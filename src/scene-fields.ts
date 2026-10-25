export type SceneCustomField = { key: string; value: string };
export const SCENE_WRITING_STATUSES = ["planned", "drafting", "revision", "final"] as const;
export type SceneWritingStatus = (typeof SCENE_WRITING_STATUSES)[number];

export type SceneManuscriptLink = {
  start: number;
  end: number;
  characterCount: number;
  fingerprint: string;
  chapterId: string;
  chapterTitle: string;
  chapterRevision: number;
};

export function normalizeSceneManuscriptLink(value: unknown): SceneManuscriptLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const link = value as Partial<SceneManuscriptLink>;
  const chapterId = typeof link.chapterId === "string" ? link.chapterId.trim() : "";
  const start = Math.floor(Number(link.start));
  const end = Math.floor(Number(link.end));
  const characterCount = Math.floor(Number(link.characterCount));
  const fingerprint = typeof link.fingerprint === "string" ? link.fingerprint : "";
  if (!chapterId || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(characterCount) || start < 0 || end <= start || end - start > 40_000 || characterCount < 1 || characterCount > Math.min(40_000, end - start) || !/^[0-9a-f]{16}$/u.test(fingerprint)) return null;
  const revision = Math.floor(Number(link.chapterRevision) || 0);
  return {
    start,
    end,
    characterCount,
    fingerprint,
    chapterId,
    chapterTitle: typeof link.chapterTitle === "string" ? link.chapterTitle.slice(0, 300) : "",
    chapterRevision: Math.max(0, Number.isSafeInteger(revision) ? revision : 0),
  };
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
  if (value && typeof value === "object") return Math.max(0, Math.floor(Number((value as any).characterCount) || 0));
  return Array.from(String(value || "").replace(/\s/gu, "")).length;
}

export function verifySceneManuscriptLink(text: unknown, linkValue: unknown): "matched" | "missing" {
  const link = normalizeSceneManuscriptLink(linkValue);
  const body = String(text || "");
  if (!link || link.end > body.length) return "missing";
  return sceneExcerptFingerprint(body.slice(link.start, link.end)) === link.fingerprint ? "matched" : "missing";
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
