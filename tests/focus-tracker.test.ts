import { describe, expect, it } from "vitest";
import { FocusTracker, FOCUS_GAP_MS, FocusClock } from "../electron/focus-tracker";

function makeClock(opts: {
  startMono?: number;
  startWall?: number;
  dateOf?: (wall: number) => string;
}) {
  let mono = opts.startMono ?? 1000;
  let wall = opts.startWall ?? Date.parse("2026-09-15T12:00:00");
  const clock: FocusClock = {
    mono: () => mono,
    wall: () => wall,
    localDate: (ms?: number) => {
      const d = new Date(ms ?? wall);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    },
    nowIso: () => new Date(wall).toISOString(),
  };
  return {
    clock,
    advance(ms: number) {
      mono += ms;
      wall += ms;
    },
    setWall(v: number) {
      wall = v;
    },
    setMono(v: number) {
      mono = v;
    },
  };
}

function makeTracker(clock: FocusClock) {
  const inserts: any[] = [];
  const updates: any[] = [];
  let n = 0;
  const tracker = new FocusTracker({
    newId: () => `id-${n++}`,
    insert: (row) => inserts.push(row),
    update: (id, committedMs, endedAt) => updates.push({ id, committedMs, endedAt }),
    clock,
  });
  return { tracker, inserts, updates };
}

describe("FocusTracker", () => {
  it("first ping does not add duration", () => {
    const c = makeClock({});
    const { tracker, inserts, updates } = makeTracker(c.clock);
    tracker.ping("n1", "c1");
    expect(inserts[0].durationMs).toBe(0);
    tracker.end();
    expect(updates.at(-1)?.committedMs).toBe(0);
  });

  it("accumulates gap under 60s", () => {
    const c = makeClock({});
    const { tracker, updates } = makeTracker(c.clock);
    tracker.ping("n1", "c1");
    c.advance(30_000);
    tracker.ping("n1", "c1");
    tracker.end();
    expect(updates.at(-1)?.committedMs).toBe(30_000);
  });

  it("does not accumulate gap over 60s", () => {
    const c = makeClock({});
    const { tracker, updates } = makeTracker(c.clock);
    tracker.ping("n1", "c1");
    c.advance(FOCUS_GAP_MS + 5);
    tracker.ping("n1", "c1");
    tracker.end();
    expect(updates.filter((u) => u.committedMs > 0)).toHaveLength(0);
  });

  it("splits midnight gap across two dates", () => {
    // 23:59:50 → +20s → 00:00:10
    const startWall = Date.parse("2026-09-15T23:59:50");
    const c = makeClock({ startWall, startMono: 1000 });
    const { tracker, inserts, updates } = makeTracker(c.clock);
    tracker.ping("n1", "c1");
    c.advance(20_000);
    tracker.ping("n1", "c1");
    tracker.end();
    expect(inserts).toHaveLength(2);
    expect(inserts[0].date).toBe("2026-09-15");
    expect(inserts[1].date).toBe("2026-09-16");
    expect(new Set(inserts.map((r) => r.logicalId)).size).toBe(1);
    const d15 = updates.find((u) => u.id === inserts[0].id);
    const d16 = updates.find((u) => u.id === inserts[1].id);
    expect(d15?.committedMs).toBe(10_000);
    expect(d16?.committedMs).toBe(10_000);
  });

  it("discards suspicious clock jump", () => {
    const c = makeClock({});
    const { tracker, updates } = makeTracker(c.clock);
    tracker.ping("n1", "c1");
    // 墙钟向前跳 1 小时，单调仅 +1s → 保守结束
    c.advance(1000);
    c.setWall(Date.parse("2026-09-16T13:00:00"));
    tracker.ping("n1", "c1");
    tracker.end();
    expect(updates.filter((u) => u.committedMs > 60_000)).toHaveLength(0);
  });
});
