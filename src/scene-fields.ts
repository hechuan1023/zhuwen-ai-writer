export type SceneCustomField = { key: string; value: string };
export const SCENE_WRITING_STATUSES = ["planned", "drafting", "revision", "final"] as const;
export type SceneWritingStatus = (typeof SCENE_WRITING_STATUSES)[number];

export type SceneManuscriptExcerptSegment = {
  start: number;
  end: number;
  characterCount: number;
  fingerprint: string;
  /** Short exact-match anchors; the manuscript excerpt itself is never stored. */
  anchorStart?: string;
  anchorEnd?: string;
};

export type SceneManuscriptLink = SceneManuscriptExcerptSegment & {
  chapterId: string;
  chapterTitle: string;
  chapterRevision: number;
  /** New links may group multiple independently verified ranges in the same chapter. */
  segments?: SceneManuscriptExcerptSegment[];
};

export function normalizeSceneAiContextIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const id = typeof entry === "string" ? entry.trim().slice(0, 160) : "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  }).slice(0, 24);
}

export function normalizeSceneManuscriptLink(value: unknown): SceneManuscriptLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const link = value as Partial<SceneManuscriptLink>;
  const chapterId = typeof link.chapterId === "string" ? link.chapterId.trim() : "";
  if (!chapterId) return null;
  const normalizeSegment = (input: unknown): SceneManuscriptExcerptSegment | null => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const segment = input as Partial<SceneManuscriptExcerptSegment>;
    const start = Math.floor(Number(segment.start));
    const end = Math.floor(Number(segment.end));
    const characterCount = Math.floor(Number(segment.characterCount));
    const fingerprint = typeof segment.fingerprint === "string" ? segment.fingerprint : "";
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(characterCount) || start < 0 || end <= start || end - start > 40_000 || characterCount < 1 || characterCount > Math.min(40_000, end - start) || !/^[0-9a-f]{16}$/u.test(fingerprint)) return null;
    const validAnchor = (anchor: unknown) => typeof anchor === "string" && Array.from(anchor).length <= 240 && anchor.length <= 480;
    const anchorsValid = segment.anchorStart == null && segment.anchorEnd == null
      ? false
      : validAnchor(segment.anchorStart) && Boolean(segment.anchorStart) && (segment.anchorEnd == null || validAnchor(segment.anchorEnd));
    const anchorStart = anchorsValid ? segment.anchorStart as string : "";
    const anchorEnd = anchorsValid && typeof segment.anchorEnd === "string" ? segment.anchorEnd : "";
    return {
      start,
      end,
      characterCount,
      fingerprint,
      ...(anchorStart ? { anchorStart, anchorEnd } : {}),
    };
  };
  const primary = normalizeSegment(link);
  if (!primary) return null;
  const revision = Math.floor(Number(link.chapterRevision) || 0);
  let segments: SceneManuscriptExcerptSegment[] | undefined;
  if (link.segments != null) {
    if (!Array.isArray(link.segments) || link.segments.length < 1 || link.segments.length > 12) return null;
    const normalizedSegments = link.segments.map(normalizeSegment).filter((segment): segment is SceneManuscriptExcerptSegment => Boolean(segment));
    if (normalizedSegments.length !== link.segments.length) return null;
    normalizedSegments.sort((a, b) => a.start - b.start || a.end - b.end);
    if (normalizedSegments.some((segment, index) => index > 0 && segment.start < normalizedSegments[index - 1].end)) return null;
    if (!normalizedSegments.some((segment) => segment.start === primary.start && segment.end === primary.end && segment.fingerprint === primary.fingerprint)) return null;
    segments = normalizedSegments;
  }
  return {
    ...primary,
    chapterId,
    chapterTitle: typeof link.chapterTitle === "string" ? link.chapterTitle.slice(0, 300) : "",
    chapterRevision: Math.max(0, Number.isSafeInteger(revision) ? revision : 0),
    ...(segments ? { segments } : {}),
  };
}

export function sceneManuscriptLinkSegments(value: unknown): SceneManuscriptExcerptSegment[] {
  const link = normalizeSceneManuscriptLink(value);
  if (!link) return [];
  return link.segments || [{
    start: link.start,
    end: link.end,
    characterCount: link.characterCount,
    fingerprint: link.fingerprint,
    ...(link.anchorStart ? { anchorStart: link.anchorStart, anchorEnd: link.anchorEnd } : {}),
  }];
}

/** Keep only short exact-match boundaries so a scene can be relocated after edits. */
export function sceneManuscriptAnchors(value: unknown): { anchorStart: string; anchorEnd: string } {
  const points = Array.from(String(value || ""));
  if (points.length <= 240) return { anchorStart: points.join(""), anchorEnd: "" };
  return { anchorStart: points.slice(0, 120).join(""), anchorEnd: points.slice(-120).join("") };
}

/** Return a range only when the saved boundaries identify exactly one excerpt. */
export function findUniqueSceneManuscriptAnchor(text: unknown, linkValue: unknown): { start: number; end: number } | null {
  const link = normalizeSceneManuscriptLink(linkValue);
  const body = String(text || "");
  if (!link?.anchorStart || !body) return null;
  const matches: Array<{ start: number; end: number }> = [];
  let start = body.indexOf(link.anchorStart);
  while (start !== -1) {
    if (!link.anchorEnd) {
      matches.push({ start, end: start + link.anchorStart.length });
    } else {
      let endAnchor = body.indexOf(link.anchorEnd, start + link.anchorStart.length);
      while (endAnchor !== -1 && endAnchor + link.anchorEnd.length - start <= 40_000) {
        matches.push({ start, end: endAnchor + link.anchorEnd.length });
        if (matches.length > 1) return null;
        endAnchor = body.indexOf(link.anchorEnd, endAnchor + 1);
      }
    }
    if (matches.length > 1) return null;
    start = body.indexOf(link.anchorStart, start + 1);
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Return relocated ranges only when every stored segment has one unique anchor match. */
export function findUniqueSceneManuscriptAnchors(text: unknown, linkValue: unknown): Array<{ start: number; end: number }> | null {
  const link = normalizeSceneManuscriptLink(linkValue);
  if (!link) return null;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const segment of sceneManuscriptLinkSegments(link)) {
    const range = findUniqueSceneManuscriptAnchor(text, { ...segment, chapterId: link.chapterId, chapterTitle: link.chapterTitle, chapterRevision: link.chapterRevision });
    if (!range || ranges.some((existing) => range.start < existing.end && existing.start < range.end)) return null;
    ranges.push(range);
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function sceneExcerptFingerprint(value: unknown): string {
  const input = String(value || "");
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const point of input) {
    const unit = point.codePointAt(0) || 0;
    first = Math.imul(first ^ unit, 0x01000193);
    second = Math.imul(second ^ unit, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function sceneManuscriptExcerptWords(value: unknown): number {
  if (value && typeof value === "object") {
    const segments = sceneManuscriptLinkSegments(value);
    if (segments.length) return segments.reduce((total, segment) => total + segment.characterCount, 0);
    return Math.max(0, Math.floor(Number((value as any).characterCount) || 0));
  }
  return Array.from(String(value || "").replace(/\s/gu, "")).length;
}

export function verifySceneManuscriptLink(text: unknown, linkValue: unknown): "matched" | "missing" {
  const link = normalizeSceneManuscriptLink(linkValue);
  const body = String(text || "");
  if (!link) return "missing";
  return sceneManuscriptLinkSegments(link).every((segment) =>
    segment.end <= body.length && sceneExcerptFingerprint(body.slice(segment.start, segment.end)) === segment.fingerprint,
  ) ? "matched" : "missing";
}

export function normalizeSceneWritingStatus(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "planned";
  const normalized = Array.from(String(value ?? "").replace(/\s+/gu, " ").trim()).slice(0, 40).join("");
  return normalized || "planned";
}

/** Optional author-planned word target; keep legacy scene JSON without a value unchanged. */
export function normalizeSceneTargetWords(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(100_000, Math.max(1, Math.floor(number)));
}

export function normalizeSceneCustomFields(value: unknown): SceneCustomField[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((field: any) => {
    const key = String(field?.key || "").trim().slice(0, 40);
    const fieldValue = String(field?.value || "").trim().slice(0, 240);
    const normalizedKey = key.toLocaleLowerCase();
    if (!key || !fieldValue || seen.has(normalizedKey)) return [];
    seen.add(normalizedKey);
    return [{ key, value: fieldValue }];
  }).slice(0, 12);
}
