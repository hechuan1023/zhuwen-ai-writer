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

  it("translates built-in prompt names without changing custom names", () => {
    expect(promptNameFor("检查逻辑", 1, "en")).toBe("Check logic");
    expect(promptNameFor("我的模板", 0, "en")).toBe("我的模板");
  });
});
