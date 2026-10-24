import { describe, expect, it } from "vitest";
import {
  editorToLibraryContent,
  libraryContentToEditor,
  normalizeLibraryDraft,
  pickNames,
  scanLibraryHealth,
} from "../src/ui/library-model";

describe("relation label/body roundtrip", () => {
  it("maps stored label into editor body and back without clearing", () => {
    const row = {
      id: "r1",
      kind: "relation",
      title: "甲与乙",
      status: "idea",
      content_json: JSON.stringify({ from: "甲", to: "乙", label: "师徒" }),
      tags_json: "[]",
    };
    const model = libraryContentToEditor(row);
    expect(model.body).toBe("师徒");
    expect(model.from).toBe("甲");
    expect(model.to).toBe("乙");

    // 只改标题，不改说明
    const edited = { ...model, title: "甲—师徒—乙" };
    const content = editorToLibraryContent("relation", edited);
    expect(content.label).toBe("师徒");
    expect(content.from).toBe("甲");
    expect(content.to).toBe("乙");
  });

  it("supports historical body-only content", () => {
    const model = libraryContentToEditor({
      kind: "relation",
      content_json: JSON.stringify({ from: "A", to: "B", body: "旧识" }),
    });
    expect(model.body).toBe("旧识");
    expect(editorToLibraryContent("relation", model).label).toBe("旧识");
  });
});

describe("library dirty compare", () => {
  it("open without edit is not dirty", () => {
    const a = libraryContentToEditor({
      kind: "relation",
      title: "t",
      content_json: JSON.stringify({ from: "甲", to: "乙", label: "师徒" }),
    });
    const b = { ...a };
    expect(normalizeLibraryDraft("relation", a)).toBe(
      normalizeLibraryDraft("relation", b),
    );
  });

  it("title change alone is dirty", () => {
    const a = libraryContentToEditor({
      kind: "relation",
      title: "t",
      content_json: JSON.stringify({ from: "甲", to: "乙", label: "师徒" }),
    });
    const b = { ...a, title: "t2" };
    expect(normalizeLibraryDraft("relation", a)).not.toBe(
      normalizeLibraryDraft("relation", b),
    );
  });
});

describe("scene / foreshadow / health tools", () => {
  it("scene outline fields round-trip", () => {
    const model = libraryContentToEditor({
      kind: "scene",
      title: "第3章",
      content_json: JSON.stringify({
        plotRole: "转折",
        hook: "身份曝光",
        coolPoint: "一招制敌",
        cast: "甲,乙",
        pov: "甲",
        plotlines: ["复仇主线", "宗门暗线"],
        when: "第3章",
      }),
    });
    const content = editorToLibraryContent("scene", model);
    expect(content.hook).toBe("身份曝光");
    expect(content.plotRole).toBe("转折");
    expect(content.cast).toBe("甲,乙");
    expect(content.pov).toBe("甲");
    expect(content.plotlines).toEqual(["复仇主线", "宗门暗线"]);
    expect(normalizeLibraryDraft("scene", model)).toContain('"pov":"甲"');
    expect(normalizeLibraryDraft("scene", model)).toContain('"plotlinesText":"复仇主线，宗门暗线"');
  });

  it("foreshadow lifecycle fields round-trip", () => {
    const model = libraryContentToEditor({
      kind: "foreshadow",
      title: "断剑",
      content_json: JSON.stringify({
        body: "剑身裂纹",
        payoff: "重铸",
        plantAt: "第2章",
        planAt: "第20章",
        importance: "高",
      }),
    });
    const content = editorToLibraryContent("foreshadow", model);
    expect(content.plantAt).toBe("第2章");
    expect(content.payoff).toBe("重铸");
  });

  it("foreshadow fields all editable in UI survive a no-op save", () => {
    const stored = {
      body: "剑身裂纹",
      payoff: "重铸",
      resolved: false,
      plantAt: "第2章",
      planAt: "第20章",
      prereq: "主角取得玄铁",
      effect: "旧门派重新归队",
      importance: "高",
    };
    const model = libraryContentToEditor({
      kind: "foreshadow",
      title: "断剑",
      content_json: JSON.stringify(stored),
    });
    const content = editorToLibraryContent("foreshadow", model);
    for (const key of Object.keys(stored)) expect(content[key]).toBe(stored[key]);
    // 只改标题，其余生命周期字段不得被清空
    const retitled = editorToLibraryContent("foreshadow", { ...model, title: "断剑·改" });
    for (const key of Object.keys(stored)) expect(retitled[key]).toBe(stored[key]);
  });

  it("health accepts a planned payoff without a written note", () => {
    const withPlan = scanLibraryHealth([
      {
        kind: "foreshadow",
        title: "裂剑",
        content_json: JSON.stringify({ payoff: "", planAt: "第80章" }),
      },
    ]);
    expect(withPlan.some((i) => i.message.includes("裂剑"))).toBe(false);

    const importanceAlone = scanLibraryHealth([
      {
        kind: "foreshadow",
        title: "裂剑",
        content_json: JSON.stringify({ payoff: "", planAt: "", importance: "高" }),
      },
    ]);
    expect(importanceAlone.some((i) => i.message.includes("裂剑"))).toBe(true);
  });

  it("character extra fields preserved", () => {
    const model = libraryContentToEditor({
      kind: "character",
      title: "甲",
      content_json: JSON.stringify({
        temperament: "冷硬",
        taboo: "不杀无辜",
        knowledge: "不知朝堂内情",
        checklist: "始终左手使剑",
      }),
    });
    const content = editorToLibraryContent("character", model);
    expect(content.taboo).toBe("不杀无辜");
  });

  it("pickNames unique; health flags unresolved foreshadow", () => {
    const names = pickNames("place", 4);
    expect(new Set(names).size).toBe(names.length);
    const issues = scanLibraryHealth([
      {
        kind: "foreshadow",
        title: "裂剑",
        content_json: JSON.stringify({ payoff: "", planAt: "" }),
      },
      {
        kind: "relation",
        title: "关系",
        content_json: JSON.stringify({ from: "甲" }),
      },
    ]);
    expect(issues.some((i) => i.message.includes("伏笔"))).toBe(true);
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });
});
