import { describe, expect, it } from "vitest";
import { joinSegments, splitSegments } from "./segments";

describe("splitSegments", () => {
  it("按中文句末标点切分并保留标点", () => {
    const segs = splitSegments("山风越过长夜。她没有回头！为什么？");
    expect(segs.map((s) => s.text)).toEqual([
      "山风越过长夜。",
      "她没有回头！",
      "为什么？",
    ]);
    expect(segs.every((s) => !s.newParagraph)).toBe(true);
  });

  it("把换行后的首句标记为新段落", () => {
    const segs = splitSegments("第一段。\n\n第二段开头。第二句。");
    expect(segs).toEqual([
      { text: "第一段。", newParagraph: false },
      { text: "第二段开头。", newParagraph: true },
      { text: "第二句。", newParagraph: false },
    ]);
  });

  it("无标点时作为整段返回", () => {
    expect(splitSegments("没有标点的一段话").map((s) => s.text)).toEqual([
      "没有标点的一段话",
    ]);
  });

  it("忽略空白行", () => {
    expect(splitSegments("甲。\n\n\n乙。").map((s) => s.text)).toEqual([
      "甲。",
      "乙。",
    ]);
  });
});

describe("joinSegments", () => {
  const segs = splitSegments("第一句。第二句。\n第三段。");

  it("只拼接被选中的句子", () => {
    expect(joinSegments(segs, [true, false, true])).toBe("第一句。\n第三段。");
  });

  it("首句被选中时不在行首插入换行", () => {
    expect(joinSegments(segs, [true, true, true])).toBe(
      "第一句。第二句。\n第三段。",
    );
  });

  it("未选择任何句子时返回空字符串", () => {
    expect(joinSegments(segs, [false, false, false])).toBe("");
  });

  it("全选可还原为规范化文本", () => {
    expect(joinSegments(segs, segs.map(() => true))).toBe(
      "第一句。第二句。\n第三段。",
    );
  });
});
