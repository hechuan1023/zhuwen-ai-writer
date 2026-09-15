export type Segment = { text: string; newParagraph: boolean };

export function splitSegments(text: string): Segment[] {
  const segs: Segment[] = [];
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  paragraphs.forEach((para, pi) => {
    const sentences =
      para.match(/[^。！？!?…；;]+[。！？!?…；;]+|[^。！？!?…；;]+$/g) || [para];
    sentences.forEach((s, si) => {
      const t = s.trim();
      if (t) segs.push({ text: t, newParagraph: pi > 0 && si === 0 });
    });
  });
  return segs;
}

export function joinSegments(segments: Segment[], picked: boolean[]): string {
  let out = "";
  let first = true;
  segments.forEach((s, i) => {
    if (!picked[i]) return;
    if (!first && s.newParagraph) out += "\n";
    out += s.text;
    first = false;
  });
  return out;
}
