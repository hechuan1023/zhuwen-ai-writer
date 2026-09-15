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
