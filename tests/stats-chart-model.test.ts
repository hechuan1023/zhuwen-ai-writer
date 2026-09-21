import { describe, expect, it } from "vitest";
import { trendTickIndexes, trendScale, recentWritingMonths } from "../src/ui/stats-chart-model";

describe("trend date ticks", () => {
  it("adapts the zero baseline to positive, negative and mixed values", () => {
    expect(trendScale([0, 0]).empty).toBe(true);
    expect(trendScale([0, 10]).zero).toBe(92);
    expect(trendScale([-10, 0]).zero).toBe(8);
    expect(trendScale([-10, 10]).zero).toBe(50);
    expect(trendScale([-10, 10]).ticks).toEqual([10, 0, -10]);
  });
  it("builds two calendar months across years and sums signed changes", () => {
    const months = recentWritingMonths(new Date(2026, 0, 5), new Map([["2025-12-31", 500], ["2026-01-01", 100], ["2026-01-02", -20], ["2026-01-20", 900]]));
    expect(months.map((m) => m.key)).toEqual(["2025-12", "2026-01"]);
    expect(months.map((m) => m.total)).toEqual([500, 80]);
    expect(months[1].days.find((d) => d.day === 5)?.today).toBe(true);
    expect(months[1].days.find((d) => d.day === 20)?.future).toBe(true);
  });
  it("includes leap day and correct Monday-first padding", () => {
    const months = recentWritingMonths(new Date(2024, 2, 5), new Map());
    expect(months[0].days).toHaveLength(29);
    expect(months[0].pad).toBe(3);
  });
  it("shows each day for a week on a wide chart", () => {
    expect(trendTickIndexes(7, 900)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it("limits 30/90 day labels while preserving endpoints", () => {
    for (const [days, expected] of [[30, 6], [90, 7]]) {
      const ticks = trendTickIndexes(days, 900);
      expect(ticks).toHaveLength(expected);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBe(days - 1);
      expect(new Set(ticks).size).toBe(ticks.length);
    }
  });
  it("reduces ticks on narrow windows", () => {
    expect(trendTickIndexes(30, 240)).toHaveLength(3);
    expect(trendTickIndexes(90, 100)).toEqual([0, 89]);
  });
  it("handles empty and single-day series", () => {
    expect(trendTickIndexes(0, 500)).toEqual([]);
    expect(trendTickIndexes(1, 500)).toEqual([0]);
  });
});
