import { describe, expect, it } from "vitest";
import { diffLines, kindNameFor, promptNameFor } from "./shared";

describe("diffLines", () => {
  it("preserves unchanged context around a very large replacement", () => {
    const before = ["共同开头", ...Array.from({ length: 700 }, (_, i) => `旧-${i}`), "共同结尾"].join("\n");
    const after = ["共同开头", ...Array.from({ length: 700 }, (_, i) => `新-${i}`), "共同结尾"].join("\n");
    const result = diffLines(before, after);

    expect(result[0]).toEqual({ type: "same", text: "共同开头" });
    expect(result.at(-1)).toEqual({ type: "same", text: "共同结尾" });
    expect(result.filter((line) => line.type === "del")).toHaveLength(700);
    expect(result.filter((line) => line.type === "add")).toHaveLength(700);
  });
});

describe("localized writing terms", () => {
  it("translates built-in reference kinds", () => {
    expect(kindNameFor("foreshadow", "en")).toBe("Foreshadowing");
    expect(kindNameFor("character", "zh-CN")).toBe("人物卡");
  });

  it("translates every story-bible kind in both languages", () => {
    for (const [kind, zh, en] of [
      ["outline", "故事大纲", "Outline"],
      ["scene", "章节细纲", "Scene outline"],
      ["character", "人物卡", "Character"],
      ["world", "世界设定", "Worldbuilding"],
      ["inspiration", "灵感笔记", "Idea"],
      ["timeline", "时间线", "Timeline"],
      ["foreshadow", "伏笔", "Foreshadowing"],
      ["relation", "人物关系", "Relationship"],
    ] as const) {
      expect(kindNameFor(kind, "zh-CN")).toBe(zh);
      expect(kindNameFor(kind, "en")).toBe(en);
    }
  });

  it("translates built-in prompt names without changing custom names", () => {
    expect(promptNameFor("检查逻辑", 1, "en")).toBe("Check logic");
    expect(promptNameFor("我的模板", 0, "en")).toBe("我的模板");
  });
});
