import { describe, expect, it } from "vitest";
import { filterScenesByPov, groupScenesForTimeline, scenePovOptions } from "../src/ui/scene-planner-model";

describe("scene timeline ordering", () => {
  it("uses chapter order and preserves saved scene order without parsing free-text time labels", () => {
    const result = groupScenesForTimeline(
      [{ id: "chapter-2" }, { id: "chapter-1" }],
      [
        { id: "late", chapter_id: "chapter-1", sort_order: 4, when: "次年冬" },
        { id: "first", chapter_id: "chapter-2", sort_order: 0, when: "第十日" },
        { id: "early", chapter_id: "chapter-1", sort_order: 2, when: "三日前" },
        { id: "unassigned", chapter_id: null, sort_order: 1 },
      ],
    );

    expect(result.map((group) => group.chapter.id)).toEqual(["chapter-2", "chapter-1"]);
    expect(result.map((group) => group.scenes.map((scene) => scene.id))).toEqual([
      ["first"],
      ["early", "late"],
    ]);
    expect(result[1].scenes.map((scene) => scene.when)).toEqual(["三日前", "次年冬"]);
  });

  it("keeps empty chapter groups visible and ignores orphaned chapter references", () => {
    const result = groupScenesForTimeline(
      [{ id: "empty" }, { id: "known" }],
      [{ id: "orphan", chapter_id: "deleted", sort_order: 0 }],
    );
    expect(result.map((group) => group.scenes)).toEqual([[], []]);
  });
});

describe("scene POV filters", () => {
  const scenes = [
    { id: "a", pov: "林照", sort_order: 0 },
    { id: "b", content_json: JSON.stringify({ pov: "顾行舟" }), sort_order: 1 },
    { id: "c", pov: "林照", sort_order: 2 },
    { id: "d", pov: "", sort_order: 3 },
  ];

  it("offers distinct POVs with scene counts in saved order", () => {
    expect(scenePovOptions(scenes)).toEqual([
      { value: "林照", count: 2 },
      { value: "顾行舟", count: 1 },
    ]);
  });

  it("filters POV-specific scenes and scenes without a POV label", () => {
    expect(filterScenesByPov(scenes, "顾行舟").map((scene) => scene.id)).toEqual(["b"]);
    expect(filterScenesByPov(scenes, "__unassigned__").map((scene) => scene.id)).toEqual(["d"]);
    expect(filterScenesByPov(scenes, "all")).toHaveLength(4);
  });
});
