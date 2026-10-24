import { describe, expect, it } from "vitest";
import { findRepeatedPhrases } from "./repetition-audit";

describe("本章高频表达检查", () => {
  it("finds Chinese phrases repeated three or more times across text runs", () => {
    const results = findRepeatedPhrases([
      "夜雨敲窗，远处有灯。",
      "风停之后，夜雨敲窗。",
      "夜雨敲窗时，门外传来脚步。",
    ]);

    expect(results).toContainEqual({ phrase: "夜雨敲窗", count: 3 });
  });

  it("counts English word sequences case-insensitively", () => {
    const results = findRepeatedPhrases([
      "She watched the same door, then left.",
      "He watched the same door, then waited.",
      "They watched the same door in silence.",
    ]);

    expect(results).toContainEqual({ phrase: "watched the same door", count: 3 });
  });

  it("does not report one-off or ordinary two-time phrases", () => {
    expect(findRepeatedPhrases(["月光落在窗沿。只有这一处。"])).toEqual([]);
    expect(findRepeatedPhrases(["夜雨敲窗。夜雨敲窗。"])).toEqual([]);
  });

  it("filters nested fragments when a longer repeated expression covers them", () => {
    const results = findRepeatedPhrases([
      "她没有回答。",
      "她没有回答。",
      "她没有回答。",
    ]);

    expect(results.some((entry) => entry.phrase === "没有回答" )).toBe(false);
    expect(results.some((entry) => entry.phrase === "她没有回答")).toBe(true);
  });
});
