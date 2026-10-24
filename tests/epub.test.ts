import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildEpub } from "../electron/epub";

describe("EPUB export", () => {
  const chapters = [{ title: "开篇", volume_title: "第一卷", plain_text: "正文段落" }];

  it("embeds the novel cover as a cover page and EPUB cover-image resource", async () => {
    const bytes = Buffer.from("cover image bytes");
    const epub = await JSZip.loadAsync(
      await buildEpub(
        { title: "测试作品", author: "作者", cover_path: `data:image/png;base64,${bytes.toString("base64")}` },
        chapters,
      ),
    );

    expect(Object.keys(epub.files)[0]).toBe("mimetype");
    expect(await epub.file("EPUB/images/cover.png")?.async("nodebuffer")).toEqual(bytes);
    const packageXml = await epub.file("EPUB/package.opf")!.async("string");
    const coverPage = await epub.file("EPUB/text/cover.xhtml")!.async("string");
    expect(packageXml).toContain('properties="cover-image"');
    expect(packageXml).toContain('<itemref idref="cover-page"/>');
    expect(coverPage).toContain('alt="测试作品"');
  });

  it("keeps exporting without a cover and rejects malformed cover data", async () => {
    const epub = await JSZip.loadAsync(await buildEpub({ title: "无封面" }, chapters));
    expect(epub.file("EPUB/text/cover.xhtml")).toBeNull();
    await expect(
      buildEpub({ title: "损坏封面", cover_path: "data:image/png;base64,%%%" }, chapters),
    ).rejects.toThrow("作品封面格式无效");
  });

  it("applies each selectable reading layout to the EPUB stylesheet", async () => {
    const compact = await JSZip.loadAsync(await buildEpub({}, chapters, { epubLayout: "compact" }));
    const open = await JSZip.loadAsync(await buildEpub({}, chapters, { epubLayout: "no-indent" }));
    expect(await compact.file("EPUB/styles/book.css")!.async("string")).toContain("line-height: 1.65");
    expect(await compact.file("EPUB/styles/book.css")!.async("string")).toContain("text-indent: 2em");
    expect(await open.file("EPUB/styles/book.css")!.async("string")).toContain("text-indent: 0");
  });

  it("applies bounded user-defined layout values", async () => {
    const epub = await JSZip.loadAsync(await buildEpub({}, chapters, {
      epubLayout: "custom",
      epubCustomLayout: { lineHeight: 9, marginPercent: 7, paragraphGapEm: 0.4, indentEm: -2 },
    }));
    const css = await epub.file("EPUB/styles/book.css")!.async("string");
    expect(css).toContain("line-height: 2.4");
    expect(css).toContain("margin: 7%");
    expect(css).toContain("margin: 0 0 0.4em; text-indent: 0em;");
  });
});
