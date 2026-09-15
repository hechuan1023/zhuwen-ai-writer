import fs from "node:fs";
import zlib from "node:zlib";

export function findSignature(
  buf: Buffer,
  sig: number,
  from: number,
  to: number,
): number {
  for (let i = from; i >= to; i--) if (buf.readUInt32LE(i) === sig) return i;
  return -1;
}

export function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_: string, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_: string, d: string) =>
      String.fromCodePoint(parseInt(d, 10)),
    )
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractDocxText(file: string): string {
  return extractDocxTextBuffer(fs.readFileSync(file));
}

export function extractDocxTextBuffer(buf: Buffer): string {
  const eocd = findSignature(
    buf,
    0x06054b50,
    buf.length - 22,
    Math.max(0, buf.length - 65557),
  );
  if (eocd < 0) throw new Error("不是有效的 DOCX 文件（缺少 ZIP 结构）");
  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  let entry: { method: number; compSize: number; local: number } | null = null;
  for (let i = 0; i < total; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const local = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    if (name === "word/document.xml") {
      entry = { method, compSize, local };
      break;
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  if (!entry) throw new Error("DOCX 中缺少 word/document.xml");
  const nameLen = buf.readUInt16LE(entry.local + 26);
  const extraLen = buf.readUInt16LE(entry.local + 28);
  const start = entry.local + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  const xml = (
    entry.method === 8 ? zlib.inflateRawSync(data) : data
  ).toString("utf8");
  return xmlToText(xml);
}
