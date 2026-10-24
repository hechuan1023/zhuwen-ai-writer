import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";

type EpubChapter = {
  title: string;
  volume_title?: string | null;
  plain_text?: string | null;
  content_json?: string | null;
};

type EpubOptions = {
  includeTitle?: boolean;
  includeAuthor?: boolean;
  includeVolume?: boolean;
  includeChapter?: boolean;
  epubLayout?: "standard" | "compact" | "no-indent" | "custom";
  epubCustomLayout?: {
    lineHeight?: number;
    marginPercent?: number;
    paragraphGapEm?: number;
    indentEm?: number;
  };
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

const COVER_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

type EmbeddedImage = { id: string; href: string; mime: string; data: Buffer };
type EpubRenderState = { zip: JSZip; images: Map<string, EmbeddedImage>; imageBytes: number };

function readCover(
  dataUrl: unknown,
): { mime: string; extension: string; data: Buffer } | null {
  if (typeof dataUrl !== "string") return null;
  const match =
    /^data:(image\/(?:png|jpeg|webp|gif|bmp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      dataUrl,
    );
  if (!match || match[2].length % 4 !== 0) throw new Error("图片格式无效，无法嵌入 EPUB");
  const mime = match[1];
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > 3 * 1024 * 1024 || data.toString("base64") !== match[2])
    throw new Error("图片为空或超过 3 MB，无法嵌入 EPUB");
  const signatureValid = mime === "image/png"
    ? data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === "image/jpeg"
      ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : mime === "image/gif"
        ? /^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))
        : mime === "image/bmp"
          ? data.subarray(0, 2).toString("ascii") === "BM"
          : data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  if (!signatureValid) throw new Error("图片内容与声明格式不匹配，无法嵌入 EPUB");
  return { mime, extension: COVER_MIME_EXTENSIONS[mime], data };
}

function renderImage(src: unknown, alt: unknown, state: EpubRenderState): string {
  const image = readCover(src);
  if (!image) throw new Error("正文图片数据无效，无法导出 EPUB");
  const digest = createHash("sha256").update(image.data).digest("hex");
  let asset = state.images.get(digest);
  if (!asset) {
    if (state.imageBytes + image.data.length > 20 * 1024 * 1024)
      throw new Error("正文图片总大小超过 20 MB，无法导出 EPUB");
    const extension = COVER_MIME_EXTENSIONS[image.mime];
    asset = { id: `body-image-${state.images.size + 1}`, href: `images/body-${digest}.${extension}`, mime: image.mime, data: image.data };
    state.images.set(digest, asset);
    state.imageBytes += image.data.length;
    state.zip.file(`EPUB/${asset.href}`, image.data);
  }
  return `<img src="../${asset.href}" alt="${xml(alt)}"/>`;
}

function renderContentNode(node: any, state: EpubRenderState): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") {
    let content = xml(node.text || "");
    for (const mark of node.marks || []) {
      const tag = mark.type === "bold" ? "strong" : mark.type === "italic" ? "em" : mark.type === "strike" ? "s" : mark.type === "code" ? "code" : null;
      if (tag) content = `<${tag}>${content}</${tag}>`;
    }
    return content;
  }
  if (node.type === "image") return renderImage(node.attrs?.src, node.attrs?.alt, state);
  const children = Array.isArray(node.content)
    ? node.content.map((child: any) => renderContentNode(child, state)).join("")
    : "";
  switch (node.type) {
    case "doc": return children;
    case "paragraph": return children ? `<p>${children}</p>` : "";
    case "heading": return children ? `<h2>${children}</h2>` : "";
    case "hardBreak": return "<br/>";
    case "bulletList": return `<ul>${children}</ul>`;
    case "orderedList": return `<ol>${children}</ol>`;
    case "listItem": return `<li>${children}</li>`;
    case "blockquote": return `<blockquote>${children}</blockquote>`;
    default: return children;
  }
}

function renderChapterBody(chapter: EpubChapter, state: EpubRenderState): string {
  if (chapter.content_json) {
    try {
      const document = JSON.parse(chapter.content_json);
      if (document?.type === "doc") return renderContentNode(document, state);
    } catch {
      // Older or damaged JSON falls back to the plain-text snapshot below.
    }
  }
  return String(chapter.plain_text || "")
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${xml(line)}</p>`)
    .join("\n");
}

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
  novel: { title?: string | null; author?: string | null; cover_path?: string | null },
  chapters: EpubChapter[],
  options: EpubOptions = {},
): Promise<Buffer> {
  if (!chapters.length) throw new Error("没有可导出的章节内容");

  const title = String(novel.title || "未命名作品").trim() || "未命名作品";
  const author = String(novel.author || "").trim();
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const identifier = `urn:uuid:${randomUUID()}`;
  const zip = new JSZip();
  const renderState: EpubRenderState = { zip, images: new Map(), imageBytes: 0 };
  const cover = readCover(novel.cover_path);
  const layouts = {
    standard: { lineHeight: "1.8", margin: "5%", paragraphGap: ".65em", indent: "2em" },
    compact: { lineHeight: "1.65", margin: "4%", paragraphGap: ".3em", indent: "2em" },
    "no-indent": { lineHeight: "2", margin: "6%", paragraphGap: ".9em", indent: "0" },
  } as const;
  const custom = options.epubCustomLayout || {};
  const layout = options.epubLayout === "custom"
    ? {
        lineHeight: `${boundedNumber(custom.lineHeight, 1.8, 1.4, 2.4)}`,
        margin: `${boundedNumber(custom.marginPercent, 5, 3, 12)}%`,
        paragraphGap: `${boundedNumber(custom.paragraphGapEm, 0.65, 0, 1.5)}em`,
        indent: `${boundedNumber(custom.indentEm, 2, 0, 3)}em`,
      }
    : layouts[options.epubLayout || "standard"] || layouts.standard;

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
    `html { line-height: ${layout.lineHeight}; }
body { margin: ${layout.margin}; font-family: serif; }
h1 { margin: 0 0 1.4em; text-align: center; font-size: 1.35em; line-height: 1.5; }
.volume-title { margin: 0 0 1em; text-align: center; color: #666; font-size: .95em; }
p { margin: 0 0 ${layout.paragraphGap}; text-indent: ${layout.indent}; }
img { display: block; max-width: 100%; max-height: 80vh; object-fit: contain; margin: 1em auto; }
.title-page { display: flex; min-height: 80vh; flex-direction: column; justify-content: center; text-align: center; }
.title-page h1 { font-size: 2em; }
.title-page p { text-indent: 0; }
.cover-page { margin: 0; padding: 0; text-align: center; }
.cover-page img { display: block; width: 100%; height: 100vh; object-fit: contain; }`,
  );

  if (cover) {
    zip.file(`EPUB/images/cover.${cover.extension}`, cover.data);
    zip.file(
      "EPUB/text/cover.xhtml",
      xhtml(
        title,
        `<section class="cover-page"><img src="../images/cover.${cover.extension}" alt="${xml(title)}"/></section>`,
      ),
    );
  }

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
    const chapterBody = renderChapterBody(chapter, renderState);
    if (chapterBody) body.push(chapterBody);
    if (!chapterBody) body.push("<p></p>");
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
    ...(cover
      ? [
          `<item id="cover-image" href="images/cover.${cover.extension}" media-type="${cover.mime}" properties="cover-image"/>`,
          '<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>',
        ]
      : []),
    ...[...renderState.images.values()].map((image) =>
      `<item id="${image.id}" href="${image.href}" media-type="${image.mime}"/>`,
    ),
    ...(hasTitlePage
      ? ['<item id="title-page" href="text/title.xhtml" media-type="application/xhtml+xml"/>']
      : []),
    ...chapterDocs.map(
      (chapter) => `<item id="${chapter.id}" href="text/${chapter.filename}" media-type="application/xhtml+xml"/>`,
    ),
  ].join("\n    ");
  const spine = [
    ...(cover ? ['<itemref idref="cover-page"/>'] : []),
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
