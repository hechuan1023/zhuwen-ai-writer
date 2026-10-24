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
  }
  return [...counts].map(([value, count]) => {
    const separator = value.indexOf(":");
    return { value, kind: value.slice(0, separator), label: value.slice(separator + 1), count };
  });
}

export function filterScenesByTrack(scenes: PlannerRow[], track: string) {
  if (track === "all") return scenes;
  if (track === "__unlabeled__") return scenes.filter((scene) => !sceneTags(scene).length && !scenePlotlines(scene).length);
  const separator = track.indexOf(":");
  if (separator < 0) return [];
  const kind = track.slice(0, separator);
  const label = track.slice(separator + 1);
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
