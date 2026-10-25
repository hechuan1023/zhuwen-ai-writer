import { describe, expect, it } from "vitest";
import {
  focusElapsedMs,
  focusSessionProgress,
  focusWordsWritten,
  isFocusSessionComplete,
  normalizeFocusSession,
} from "../src/ui/focus-session";

const base = {
  version: 1,
  novelId: "novel-a",
  mode: "combined",
  targetMinutes: 25,
  targetWords: 500,
  startWords: 1000,
  elapsedMs: 0,
  startedAt: 1000,
  createdAt: 1000,
};

describe("focus session model", () => {
  it("validates persisted session state and bounds user values", () => {
    expect(normalizeFocusSession({ ...base, targetMinutes: 999, targetWords: -1 })).toMatchObject({
      targetMinutes: 240,
      targetWords: 1,
      mode: "combined",
    });
    expect(normalizeFocusSession({ ...base, mode: "locked" })).toBeNull();
    expect(normalizeFocusSession({ ...base, novelId: "" })).toBeNull();
    expect(normalizeFocusSession(null)).toBeNull();
  });

  it("keeps paused elapsed time stable and ignores clock rollback", () => {
    const session = normalizeFocusSession(base)!;
    expect(focusElapsedMs(session, 11_000)).toBe(10_000);
    expect(focusElapsedMs({ ...session, startedAt: null, elapsedMs: 10_000 }, 50_000)).toBe(10_000);
    expect(focusElapsedMs(session, 500)).toBe(0);
  });

  it("measures added words from the session baseline without counting deletions", () => {
    const session = normalizeFocusSession(base)!;
    expect(focusWordsWritten(session, 1125)).toBe(125);
    expect(focusWordsWritten(session, 900)).toBe(0);
  });

  it("requires both goals for a combined session", () => {
    const session = normalizeFocusSession(base)!;
    expect(isFocusSessionComplete(session, 1499, 1_501_000)).toBe(false);
    expect(isFocusSessionComplete(session, 1500, 1_501_000)).toBe(true);
    expect(focusSessionProgress(session, 1250, 751_000)).toBeCloseTo(0.5);
  });

  it("uses only the selected target in time-only and word-only modes", () => {
    const timed = normalizeFocusSession({ ...base, mode: "time", targetMinutes: 1 })!;
    const worded = normalizeFocusSession({ ...base, mode: "words", targetWords: 10 })!;
    expect(isFocusSessionComplete(timed, 1000, 61_000)).toBe(true);
    expect(isFocusSessionComplete(worded, 1010, 1_000)).toBe(true);
    expect(focusSessionProgress(worded, 1005, 1_000)).toBe(0.5);
  });
});
