import sanitizeHtml from "sanitize-html";

export type ImportEncoding = "utf-8" | "gb18030" | "utf-16le";

export function decodeImportBuffer(
  buffer: Uint8Array,
  requested?: string,
): { text: string; encoding: string } {
  const candidates = requested
    ? [requested]
    : buffer[0] === 0xff && buffer[1] === 0xfe
      ? ["utf-16le"]
      : ["utf-8", "gb18030", "utf-16le"];
  for (const encoding of candidates) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
      if (text && !text.includes("\u0000"))
        return { text: text.replace(/^\uFEFF/, ""), encoding };
    } catch {
      // Try the next supported legacy encoding.
    }
  }
  throw new Error("无法识别文本编码，请尝试手动选择 UTF-8、GB18030 或 UTF-16LE");
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&#x([\da-f]{1,6});|&#(\d{1,7});/gi, (_match, hex: string, decimal: string) => {
      const codePoint = hex ? Number.parseInt(hex, 16) : Number.parseInt(decimal, 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "�";
    });
}

/** Extract readable prose from untrusted HTML without loading resources or retaining active markup. */
export function htmlToPlainText(html: string) {
  const safeMarkup = sanitizeHtml(String(html || ""), {
    allowedTags: ["br"],
    allowedAttributes: {},
    transformTags: {
      p: "br",
      div: "br",
      h1: "br",
      h2: "br",
      h3: "br",
      h4: "br",
      h5: "br",
      h6: "br",
      li: "br",
      tr: "br",
      blockquote: "br",
      section: "br",
      article: "br",
      header: "br",
      footer: "br",
    },
  });
  return decodeHtmlEntities(safeMarkup)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t \f\v]+\n/g, "\n")
    .replace(/\n[\t \f\v]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
