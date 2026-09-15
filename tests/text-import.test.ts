import { describe, expect, it } from "vitest";
import { decodeImportBuffer } from "../electron/text-import";

describe("text import decoding", () => {
  it("detects UTF-8 and strips BOM", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("第一章\n山风")]);
    expect(decodeImportBuffer(bytes)).toEqual({ text: "第一章\n山风", encoding: "utf-8" });
  });

  it("detects UTF-16LE with BOM", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("第二章\n归途", "utf16le")]);
    expect(decodeImportBuffer(bytes)).toEqual({ text: "第二章\n归途", encoding: "utf-16le" });
  });

  it("rejects a wrong manually selected encoding", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("第三章", "utf16le")]);
    expect(() => decodeImportBuffer(bytes, "utf-8")).toThrow("无法识别文本编码");
  });
});
