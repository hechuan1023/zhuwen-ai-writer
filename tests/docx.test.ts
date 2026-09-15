import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { describe, expect, it } from "vitest";
import { extractDocxText, xmlToText } from "../electron/docx";

describe("xmlToText", () => {
  it("把段落、换行、制表和 XML 实体转换为纯文本", () => {
    const xml = `<w:p><w:r><w:t>甲&amp;乙</w:t></w:r><w:tab/><w:r><w:t>丙</w:t></w:r></w:p><w:p><w:r><w:t>丁</w:t></w:r></w:p>`;
    expect(xmlToText(xml)).toBe("甲&乙\t丙\n丁");
  });
});

describe("extractDocxText", () => {
  it("从真实 DOCX 文件中提取中文正文", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zhuwen-docx-"));
    try {
      const doc = new Document({
        sections: [
          {
            children: [
              new Paragraph("第一章 起点"),
              new Paragraph("他没有回头，继续向北走。"),
            ],
          },
        ],
      });
      const buf = await Packer.toBuffer(doc);
      const file = join(dir, "t.docx");
      writeFileSync(file, buf);
      const text = extractDocxText(file);
      expect(text).toContain("第一章 起点");
      expect(text).toContain("他没有回头，继续向北走。");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("对非 ZIP 文件抛出明确错误", () => {
    const dir = mkdtempSync(join(tmpdir(), "zhuwen-docx-"));
    try {
      const file = join(dir, "x.docx");
      writeFileSync(file, "not a zip");
      expect(() => extractDocxText(file)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
