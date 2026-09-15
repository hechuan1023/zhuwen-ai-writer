import { describe, expect, it } from "vitest";

/** 与主进程 preferences 合并语义一致：浅合并对象字段。 */
function mergePref(prev: unknown, next: unknown) {
  if (
    prev &&
    typeof prev === "object" &&
    !Array.isArray(prev) &&
    next &&
    typeof next === "object" &&
    !Array.isArray(next)
  ) {
    return { ...prev, ...next };
  }
  return next;
}

describe("preference merge", () => {
  it("keeps unrelated appearance fields when patching theme", () => {
    const prev = {
      theme: "warm",
      language: "zh-CN",
      fontFamily: "serif",
      backgroundImage: "data:image/png;base64,x",
      reduceTransparency: true,
      leftWidth: 300,
    };
    const next = mergePref(prev, { theme: "dark" });
    expect(next).toEqual({ ...prev, theme: "dark" });
  });

  it("replaces non-object values", () => {
    expect(mergePref({ a: 1 }, [1, 2])).toEqual([1, 2]);
    expect(mergePref(null, { theme: "light" })).toEqual({ theme: "light" });
  });
});

describe("writing stats calendar range", () => {
  function localDateKey(d: Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function fillDays(start: Date, days: number, by: Map<string, number>) {
    const out: { date: string; total: number }[] = [];
    const cursor = new Date(start);
    for (let i = 0; i < days; i++) {
      const key = localDateKey(cursor);
      out.push({ date: key, total: by.get(key) || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  it("fills zero days and spans month boundaries", () => {
    // 2026-01-30 + 5 days → crosses into Feb
    const start = new Date(2026, 0, 30, 12, 0, 0);
    const by = new Map([
      ["2026-01-30", 10],
      ["2026-02-01", 5],
    ]);
    const rows = fillDays(start, 5, by);
    expect(rows.map((r) => r.date)).toEqual([
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
      "2026-02-03",
    ]);
    expect(rows.map((r) => r.total)).toEqual([10, 0, 5, 0, 0]);
  });
});

describe("goal celebration key", () => {
  it("uses scope+date+goal so panels do not double-celebrate", () => {
    const key = (scope: string, date: string, goal: number) =>
      `${scope}|${date}|${goal}`;
    expect(key("home", "2026-09-14", 3000)).not.toEqual(
      key("workspace", "2026-09-14", 3000),
    );
    expect(key("home", "2026-09-14", 3000)).not.toEqual(
      key("home", "2026-09-15", 3000),
    );
  });
});
