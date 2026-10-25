import { describe, expect, it } from "vitest";
import { buildPlotlineMatrix, filterScenesByPov, filterScenesByTrack, groupScenesForTimeline, sceneCustomFields, scenePovOptions, scenePlotlines, sceneTags, sceneTrackOptions } from "../src/ui/scene-planner-model";

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

describe("scene label filters", () => {
  const scenes = [
    { id: "a", tags_json: '["复仇"]', content_json: JSON.stringify({ plotlines: ["复仇主线"] }) },
    { id: "b", tags_json: '["宗门暗线"]', content_json: JSON.stringify({ plotlines: ["复仇主线", "家族支线"] }) },
    { id: "c", tags_json: "[]" },
  ];

  it("keeps explicit plotlines distinct from generic tags and handles legacy text", () => {
    expect(sceneTags({ tags_json: "宗门暗线，宗门暗线;复仇" })).toEqual(["宗门暗线", "复仇"]);
    expect(scenePlotlines({ content_json: JSON.stringify({ plotlines: ["复仇主线", "复仇主线"] }) })).toEqual(["复仇主线"]);
    expect(sceneTrackOptions(scenes)).toEqual([
      { value: "plotline:复仇主线", kind: "plotline", label: "复仇主线", count: 2 },
      { value: "tag:复仇", kind: "tag", label: "复仇", count: 1 },
      { value: "plotline:家族支线", kind: "plotline", label: "家族支线", count: 1 },
      { value: "tag:宗门暗线", kind: "tag", label: "宗门暗线", count: 1 },
    ]);
  });

  it("filters plotlines separately from tags and includes scenes without either label", () => {
    expect(filterScenesByTrack(scenes, "plotline:复仇主线").map((scene) => scene.id)).toEqual(["a", "b"]);
    expect(filterScenesByTrack(scenes, "tag:宗门暗线").map((scene) => scene.id)).toEqual(["b"]);
    expect(filterScenesByTrack(scenes, "__unlabeled__").map((scene) => scene.id)).toEqual(["c"]);
    expect(filterScenesByTrack(scenes, "all")).toHaveLength(3);
  });
});

describe("scene custom properties", () => {
  it("reads normalized custom properties from scene content", () => {
    expect(sceneCustomFields({
      content_json: JSON.stringify({ customFields: [
        { key: "地点", value: "雾桥" },
        { key: "地点", value: "忽略重复" },
        { key: "危险", value: "" },
      ] }),
    })).toEqual([{ key: "地点", value: "雾桥" }]);
  });

  it("offers searchable custom-property filters and excludes labeled scenes from unlabeled results", () => {
    const scenes = [
      { id: "a", content_json: JSON.stringify({ customFields: [{ key: "天气", value: "暴雨" }] }) },
      { id: "b", content_json: JSON.stringify({ customFields: [{ key: "天气", value: "晴" }] }) },
      { id: "c", content_json: JSON.stringify({}) },
    ];
    const options = sceneTrackOptions(scenes);
    const rain = options.find((option) => option.label === "天气：暴雨");
    expect(rain?.kind).toBe("custom");
    expect(filterScenesByTrack(scenes, rain!.value).map((scene) => scene.id)).toEqual(["a"]);
    expect(filterScenesByTrack(scenes, "__unlabeled__").map((scene) => scene.id)).toEqual(["c"]);
  });
});

describe("plotline matrix", () => {
  it("groups assigned scenes by chapter and explicit plotline while retaining empty rows", () => {
    const result = buildPlotlineMatrix(
      [{ id: "ch1" }, { id: "ch2" }, { id: "ch3" }],
      [
        { id: "s1", chapter_id: "ch1", content_json: JSON.stringify({ plotlines: ["主线"] }) },
        { id: "s2", chapter_id: "ch1", content_json: JSON.stringify({ plotlines: ["支线", "主线"] }) },
        { id: "s3", chapter_id: "ch2", content_json: JSON.stringify({ plotlines: ["支线"] }) },
        { id: "orphan", chapter_id: "deleted", content_json: JSON.stringify({ plotlines: ["旧线"] }) },
      ],
    );
    expect(result.plotlines).toEqual(["主线", "支线"]);
    expect(result.rows.map((row) => row.chapter.id)).toEqual(["ch1", "ch2", "ch3"]);
    expect(result.rows[0].scenesByPlotline["主线"].map((scene) => scene.id)).toEqual(["s1", "s2"]);
    expect(result.rows[1].scenesByPlotline["主线"]).toEqual([]);
    expect(result.rows[2].scenesByPlotline["支线"]).toEqual([]);
  });
});
