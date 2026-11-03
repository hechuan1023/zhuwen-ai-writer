import { normalizeSceneCustomFields } from "../scene-fields";

export type PlannerRow = Record<string, any>;

export function scenePov(scene: PlannerRow) {
  let content: PlannerRow = {};
  try {
    const parsed = typeof scene.content_json === "string" ? JSON.parse(scene.content_json || "{}") : scene.content_json;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content = parsed;
  } catch {
    // Keep planner usable for malformed legacy metadata.
  }
  return String(scene.pov ?? content.pov ?? "").trim();
}

export function scenePovOptions(scenes: PlannerRow[]) {
  const counts = new Map<string, number>();
  for (const scene of scenes) {
    const pov = scenePov(scene);
    if (pov) counts.set(pov, (counts.get(pov) || 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count }));
}

export function filterScenesByPov(scenes: PlannerRow[], pov: string) {
  if (pov === "all") return scenes;
  if (pov === "__unassigned__") return scenes.filter((scene) => !scenePov(scene));
  return scenes.filter((scene) => scenePov(scene) === pov);
}

export function sceneTags(scene: PlannerRow) {
  const raw = scene.tags_json ?? scene.tagsText ?? scene.tags ?? [];
  let values: unknown = raw;
  if (typeof raw === "string") {
    try {
      values = JSON.parse(raw || "[]");
    } catch {
      values = raw.split(/[,，、;；\n]+/);
    }
  }
  if (!Array.isArray(values)) values = [values];
  return [...new Set((values as unknown[]).map((value) => String(value || "").trim()).filter(Boolean))];
}

export function scenePlotlines(scene: PlannerRow) {
  let content: PlannerRow = {};
  try {
    const parsed = typeof scene.content_json === "string" ? JSON.parse(scene.content_json || "{}") : scene.content_json;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content = parsed;
  } catch {
    // Legacy malformed scene metadata should not break planner filtering.
  }
  const raw = scene.plotlines ?? content.plotlines ?? [];
  const values = Array.isArray(raw) ? raw : String(raw || "").split(/[,，、;；\n]+/);
  return [...new Set(values.map((value: unknown) => String(value || "").trim()).filter(Boolean))];
}

export function sceneCustomFields(scene: PlannerRow) {
  let content: PlannerRow = {};
  try {
    const parsed = typeof scene.content_json === "string" ? JSON.parse(scene.content_json || "{}") : scene.content_json;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content = parsed;
  } catch {
    // Keep the planner usable if legacy scene metadata is malformed.
  }
  return normalizeSceneCustomFields(scene.customFields ?? content.customFields);
}

export function sceneTrackOptions(scenes: PlannerRow[]) {
  const counts = new Map<string, number>();
  for (const scene of scenes) {
    for (const label of scenePlotlines(scene)) {
      const key = `plotline:${label}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const label of sceneTags(scene)) {
      const key = `tag:${label}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const field of sceneCustomFields(scene)) {
      const key = `custom:${encodeURIComponent(JSON.stringify([field.key, field.value]))}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts].map(([value, count]) => {
    const separator = value.indexOf(":");
    const kind = value.slice(0, separator);
    let label = value.slice(separator + 1);
    if (kind === "custom") {
      try {
        const [key, fieldValue] = JSON.parse(decodeURIComponent(label));
        label = `${key}：${fieldValue}`;
      } catch {
        label = "自定义属性";
      }
    }
    return { value, kind, label, count };
  });
}

export function filterScenesByTrack(scenes: PlannerRow[], track: string) {
  if (track === "all") return scenes;
  if (track === "__unlabeled__") return scenes.filter((scene) => !sceneTags(scene).length && !scenePlotlines(scene).length && !sceneCustomFields(scene).length);
  const separator = track.indexOf(":");
  if (separator < 0) return [];
  const kind = track.slice(0, separator);
  const label = track.slice(separator + 1);
  if (kind === "custom") {
    try {
      const [key, value] = JSON.parse(decodeURIComponent(label));
      return scenes.filter((scene) => sceneCustomFields(scene).some((field) => field.key === key && field.value === value));
    } catch {
      return [];
    }
  }
  return scenes.filter((scene) => (kind === "plotline" ? scenePlotlines(scene) : kind === "tag" ? sceneTags(scene) : []).includes(label));
}

export function buildPlotlineMatrix(chapters: PlannerRow[], scenes: PlannerRow[]) {
  const knownChapterIds = new Set(chapters.map((chapter) => String(chapter.id)));
  const plotlines = new Set<string>();
  const byChapter = new Map<string, Map<string, PlannerRow[]>>();
  for (const chapter of chapters) byChapter.set(String(chapter.id), new Map());
  for (const scene of scenes) {
    const chapterId = String(scene.chapter_id || "");
    if (!knownChapterIds.has(chapterId)) continue;
    const chapterThreads = byChapter.get(chapterId)!;
    for (const plotline of scenePlotlines(scene)) {
      plotlines.add(plotline);
      const chapterScenes = chapterThreads.get(plotline) || [];
      chapterScenes.push(scene);
      chapterThreads.set(plotline, chapterScenes);
    }
  }
  const columns = [...plotlines];
  return {
    plotlines: columns,
    rows: chapters.map((chapter) => {
      const chapterThreads = byChapter.get(String(chapter.id))!;
      return {
        chapter,
        scenesByPlotline: Object.fromEntries(columns.map((plotline) => [plotline, chapterThreads.get(plotline) || []])),
      };
    }),
  };
}

/** Read only author-entered cast metadata; do not infer appearances from manuscript text. */
export function sceneCast(scene: PlannerRow) {
  let content: PlannerRow = {};
  try {
    const parsed = typeof scene.content_json === "string" ? JSON.parse(scene.content_json || "{}") : scene.content_json;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content = parsed;
  } catch {
    // Keep legacy scene metadata usable when its JSON is malformed.
  }
  const raw = scene.cast ?? content.cast ?? "";
  const values = Array.isArray(raw) ? raw : String(raw || "").split(/[,，、;；\n\r]+/u);
  const seen = new Set<string>();
  return values.map((value: unknown) => String(value || "").replace(/\s+/gu, " ").trim())
    .filter((name: string) => {
      const key = name.toLocaleLowerCase();
      if (!name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Rows are scenes in saved chapter/scene order; columns are author-entered characters. */
export function buildCharacterSceneMatrix(chapters: PlannerRow[], scenes: PlannerRow[]) {
  const chapterOrder = new Map(chapters.map((chapter, index) => [String(chapter.id), index]));
  const knownChapterIds = new Set(chapterOrder.keys());
  const orderedScenes = scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => knownChapterIds.has(String(scene.chapter_id || "")))
    .sort((a, b) => (chapterOrder.get(String(a.scene.chapter_id || ""))! - chapterOrder.get(String(b.scene.chapter_id || ""))!)
      || Number(a.scene.sort_order || 0) - Number(b.scene.sort_order || 0)
      || a.index - b.index)
    .map(({ scene }) => scene);
  const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
  const characterByKey = new Map<string, string>();
  for (const character of orderedScenes.flatMap(sceneCast)) {
    const key = character.toLocaleLowerCase();
    if (!characterByKey.has(key)) characterByKey.set(key, character);
  }
  const characters = [...characterByKey.values()].sort(collator.compare);
  return {
    characters,
    rows: orderedScenes.map((scene) => ({ scene, cast: sceneCast(scene) })),
  };
}

/** Groups assigned scenes in chapter order and preserves the author's saved scene order. */
export function groupScenesForTimeline(chapters: PlannerRow[], scenes: PlannerRow[]) {
  const known = new Set(chapters.map((chapter) => chapter.id));
  const grouped = new Map<string, PlannerRow[]>();
  const ordered = scenes
    .map((scene, index) => ({ scene, index }))
    .sort((a, b) => Number(a.scene.sort_order || 0) - Number(b.scene.sort_order || 0) || a.index - b.index);
  for (const { scene } of ordered) {
    const chapterId = String(scene.chapter_id || "");
    if (!known.has(chapterId)) continue;
    const rows = grouped.get(chapterId) || [];
    rows.push(scene);
    grouped.set(chapterId, rows);
  }
  return chapters.map((chapter) => ({ chapter, scenes: grouped.get(chapter.id) || [] }));
}
