import { parseJson, parseTags } from "./shared";

/** DB content_json → 编辑模型 */
export function libraryContentToEditor(row: {
  kind?: string;
  content_json?: string;
  tags_json?: string;
  [k: string]: any;
}): any {
  const c = parseJson(row.content_json || "{}");
  const next: any = { ...row, ...c };
  const kind = row.kind || next.kind;
  if (kind === "relation") {
    // ?? 而非 ||：区分「字段不存在」与「用户主动清空为空串」
    next.body = c.label ?? c.body ?? "";
    next.from = c.from ?? "";
    next.to = c.to ?? "";
    next.label = next.body;
  }
  if (!next.tagsText) next.tagsText = parseTags(row.tags_json || "[]");
  return next;
}

/** 编辑模型 → library:save 的 content 对象 */
export function editorToLibraryContent(kind: string, editing: any): any {
  if (kind === "timeline")
    return { when: editing.when || "", body: editing.body || "" };
  if (kind === "foreshadow")
    return {
      body: editing.body || "",
      payoff: editing.payoff || "",
      resolved: Boolean(editing.resolved),
    };
  if (kind === "relation")
    return {
      from: editing.from ?? "",
      to: editing.to ?? "",
      // body 为唯一编辑源；空串表示用户清空，不得回退到旧 label
      label:
        typeof editing.body === "string"
          ? editing.body
          : typeof editing.label === "string"
            ? editing.label
            : "",
    };
  if (kind === "character")
    return {
      body: editing.body || "",
      alias: editing.alias || "",
      appearance: editing.appearance || "",
      personality: editing.personality || "",
      goal: editing.goal || "",
      motive: editing.motive || "",
      conflict: editing.conflict || "",
      speech: editing.speech || "",
      note: editing.note || "",
    };
  if (kind === "world")
    return { body: editing.body || "", category: editing.category || "" };
  return { body: editing.body || "" };
}

export function normalizeLibraryDraft(kind: string, d: any) {
  if (!d) return "";
  return JSON.stringify({
    id: d.id || "",
    kind,
    title: String(d.title || "").trim(),
    status: d.status || "idea",
    body: String(d.body || ""),
    when: String(d.when || ""),
    from: String(d.from || ""),
    to: String(d.to || ""),
    payoff: String(d.payoff || ""),
    resolved: Boolean(d.resolved),
    alias: String(d.alias || ""),
    appearance: String(d.appearance || ""),
    personality: String(d.personality || ""),
    goal: String(d.goal || ""),
    motive: String(d.motive || ""),
    conflict: String(d.conflict || ""),
    speech: String(d.speech || ""),
    note: String(d.note || ""),
    category: String(d.category || ""),
    tagsText: String(d.tagsText || ""),
    chapterId: d.chapter_id || d.chapterId || "",
  });
}
