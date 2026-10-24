import { randomUUID } from "node:crypto";
import JSZip from "jszip";

type EpubChapter = {
  title: string;
  volume_title?: string | null;
  plain_text?: string | null;
};

type EpubOptions = {
  includeTitle?: boolean;
  includeAuthor?: boolean;
  includeVolume?: boolean;
  includeChapter?: boolean;
};

function xml(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xhtml(title: string, body: string, stylesheet = "../styles/book.css") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
<head><meta charset="UTF-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="${stylesheet}"/></head>
<body>${body}</body>
</html>`;
}

/** Build a reflowable EPUB 3.0 publication from ordered manuscript chapters. */
export async function buildEpub(
  novel: { title?: string | null; author?: string | null },
  chapters: EpubChapter[],
  options: EpubOptions = {},
): Promise<Buffer> {
  if (!chapters.length) throw new Error("没有可导出的章节内容");

  const title = String(novel.title || "未命名作品").trim() || "未命名作品";
  const author = String(novel.author || "").trim();
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const identifier = `urn:uuid:${randomUUID()}`;
  const zip = new JSZip();

  // OCF requires this to be the first ZIP entry, stored without compression.
  zip.file("mimetype", "application/epub+zip", {
    compression: "STORE",
    createFolders: false,
  });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );

  zip.file(
    "EPUB/styles/book.css",
    `html { line-height: 1.8; }
body { margin: 5%; font-family: serif; }
h1 { margin: 0 0 1.4em; text-align: center; font-size: 1.35em; line-height: 1.5; }
.volume-title { margin: 0 0 1em; text-align: center; color: #666; font-size: .95em; }
p { margin: 0 0 .65em; text-indent: 2em; }
.title-page { display: flex; min-height: 80vh; flex-direction: column; justify-content: center; text-align: center; }
.title-page h1 { font-size: 2em; }
.title-page p { text-indent: 0; }`,
  );

  const chapterDocs = chapters.map((chapter, index) => {
    const id = `chapter-${index + 1}`;
    const filename = `chapter-${String(index + 1).padStart(4, "0")}.xhtml`;
    const chapterTitle = String(chapter.title || `第${index + 1}章`).trim();
    const body: string[] = [];
    const volume = String(chapter.volume_title || "").trim();
    const previousVolume = index > 0 ? String(chapters[index - 1].volume_title || "").trim() : "";
    if (options.includeVolume !== false && volume && volume !== previousVolume)
      body.push(`<p class="volume-title">${xml(volume)}</p>`);
    if (options.includeChapter !== false) body.push(`<h1>${xml(chapterTitle)}</h1>`);
    const paragraphs = String(chapter.plain_text || "")
      .split(/\r\n?|\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    body.push(...paragraphs.map((line) => `<p>${xml(line)}</p>`));
    if (!paragraphs.length) body.push("<p></p>");
    zip.file(`EPUB/text/${filename}`, xhtml(chapterTitle, body.join("\n")));
    return { id, filename, title: chapterTitle };
  });

  const hasTitlePage = options.includeTitle !== false || (options.includeAuthor !== false && author);
  if (hasTitlePage) {
    const titleParts = [
      options.includeTitle !== false ? `<h1>${xml(title)}</h1>` : "",
      options.includeAuthor !== false && author ? `<p>${xml(author)}</p>` : "",
    ].filter(Boolean);
    zip.file(
      "EPUB/text/title.xhtml",
      xhtml(title, `<section class="title-page">${titleParts.join("")}</section>`),
    );
  }

  const navItems = chapterDocs
    .map((chapter) => `<li><a href="text/${chapter.filename}">${xml(chapter.title)}</a></li>`)
    .join("\n");
  zip.file(
    "EPUB/nav.xhtml",
    xhtml(
      `${title} · 目录`,
      `<nav epub:type="toc" id="toc"><h1>目录</h1><ol>${navItems}</ol></nav>`,
      "styles/book.css",
    ),
  );

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="styles/book.css" media-type="text/css"/>',
    ...(hasTitlePage
      ? ['<item id="title-page" href="text/title.xhtml" media-type="application/xhtml+xml"/>']
      : []),
    ...chapterDocs.map(
      (chapter) => `<item id="${chapter.id}" href="text/${chapter.filename}" media-type="application/xhtml+xml"/>`,
    ),
  ].join("\n    ");
  const spine = [
    ...(hasTitlePage ? ['<itemref idref="title-page"/>'] : []),
    ...chapterDocs.map((chapter) => `<itemref idref="${chapter.id}"/>`),
  ].join("\n    ");
  zip.file(
    "EPUB/package.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${identifier}</dc:identifier>
    <dc:title>${xml(title)}</dc:title>
    ${author ? `<dc:creator>${xml(author)}</dc:creator>` : ""}
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`,
  );

  return zip.generateAsync({
    type: "nodebuffer",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
