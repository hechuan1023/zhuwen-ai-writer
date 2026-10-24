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
