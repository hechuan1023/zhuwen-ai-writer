import { describe, expect, it } from "vitest";
import {
  celebrateKey,
  goalScopeKey,
  hasCelebrated,
  markCelebrated,
  shouldCelebrateGoal,
} from "../src/ui/goal-celebrate";
import {
  editorToLibraryContent,
  libraryContentToEditor,
  normalizeLibraryDraft,
} from "../src/ui/library-model";

describe("goal celebrate production logic", () => {
  it("scopes by novel id not page name", () => {
    expect(goalScopeKey(null)).toBe("all");
    expect(goalScopeKey("n1")).toBe("novel:n1");
    expect(goalScopeKey("n1")).not.toEqual(goalScopeKey("n2"));
  });

  it("does not celebrate on first load when already at goal", () => {
    const d = shouldCelebrateGoal({
      today: 3000,
      prevToday: null,
      goal: 3000,
      prevGoal: 3000,
      scope: "all",
      date: "2026-09-15",
    });
    expect(d.celebrate).toBe(false);
    expect(d.reason).toBe("initial-load");
  });

  it("celebrates once when crossing and not again after persist", () => {
    const scope = "novel:test-cross";
    const date = "2026-09-15";
    const goal = 100;
    expect(
      shouldCelebrateGoal({
        today: 120,
        prevToday: 80,
        goal,
        prevGoal: goal,
        scope,
        date,
      }).celebrate,
    ).toBe(true);
    markCelebrated(scope, date, goal);
    expect(hasCelebrated(scope, date, goal)).toBe(true);
    expect(
      shouldCelebrateGoal({
        today: 200,
        prevToday: 120,
        goal,
        prevGoal: goal,
        scope,
        date,
      }).celebrate,
    ).toBe(false);
    // 另一范围仍可庆祝
    expect(
      shouldCelebrateGoal({
        today: 200,
        prevToday: 80,
        goal,
        prevGoal: goal,
        scope: "all",
        date,
      }).celebrate,
    ).toBe(true);
  });

  it("does not celebrate when lowering the goal into pass", () => {
    const d = shouldCelebrateGoal({
      today: 50,
      prevToday: 50,
      goal: 40,
      prevGoal: 100,
      scope: "all",
      date: "2026-09-15",
    });
    expect(d.celebrate).toBe(false);
    expect(d.reason).toBe("lowered-into-goal");
  });
});

describe("relation empty label production path", () => {
  it("keeps cleared label as empty string", () => {
    const model = libraryContentToEditor({
      kind: "relation",
      title: "t",
      content_json: JSON.stringify({ from: "甲", to: "乙", label: "师徒" }),
    });
    model.body = "";
    const content = editorToLibraryContent("relation", model);
    expect(content.label).toBe("");
  });

  it("title-only edit preserves label", () => {
    const model = libraryContentToEditor({
      kind: "relation",
      title: "t",
      content_json: JSON.stringify({ from: "甲", to: "乙", label: "师徒" }),
    });
    const edited = { ...model, title: "新标题" };
    expect(editorToLibraryContent("relation", edited).label).toBe("师徒");
    expect(normalizeLibraryDraft("relation", model)).not.toBe(
      normalizeLibraryDraft("relation", edited),
    );
  });
});
