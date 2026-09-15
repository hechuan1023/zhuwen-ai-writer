import { describe, expect, it } from "vitest";
import {
  editorToLibraryContent,
  libraryContentToEditor,
  normalizeLibraryDraft,
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
