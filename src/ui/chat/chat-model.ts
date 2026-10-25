/**
 * AI 聊天面板的纯逻辑：可独立测试，不在组件内散落。
 */
import type { AnyRow } from "../shared";

export type ConversationGroup = {
  key: "today" | "week" | "older";
  labelKey: { zh: string; en: string };
  rows: AnyRow[];
};

export function partitionPinnedConversations(rows: AnyRow[]) {
  return {
    pinned: rows.filter((row) => Number(row.pinned) === 1),
    recent: rows.filter((row) => Number(row.pinned) !== 1),
  };
}

/** Find the exact user turn cited by an assistant reply; never infer from row adjacency. */
export function findSourcePrompt(messages: AnyRow[], reply: AnyRow): AnyRow | null {
  const sourceId = String(reply?.source_message_id || "");
  if (!sourceId) return null;
  return messages.find((message) =>
    message.role === "user" && String(message.id || "") === sourceId,
  ) || null;
}

/** 历史对话按时间分组：今天 / 近 7 天 / 更早（以本地日历日计算） */
export function groupConversations(
  rows: AnyRow[],
  now: Date = new Date(),
): ConversationGroup[] {
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const weekAgo = startOfToday - 6 * 86400000;
  const groups: ConversationGroup[] = [
    { key: "today", labelKey: { zh: "今天", en: "Today" }, rows: [] },
    { key: "week", labelKey: { zh: "近 7 天", en: "Previous 7 days" }, rows: [] },
    { key: "older", labelKey: { zh: "更早", en: "Older" }, rows: [] },
  ];
  for (const c of rows) {
    const t = new Date(String(c.updated_at || c.created_at || "")).getTime();
    const idx = !Number.isFinite(t) || t < weekAgo ? 2 : t >= startOfToday ? 0 : 1;
    groups[idx].rows.push(c);
  }
  return groups.filter((g) => g.rows.length > 0);
}

/** 会话搜索：标题或摘要命中；空查询返回全部（不做隐式截断） */
export function filterConversations(rows: AnyRow[], query: string): AnyRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (c) =>
      String(c.title || "").toLowerCase().includes(q) ||
      String(c.last_snippet || "").toLowerCase().includes(q),
  );
}

export type RefValidityContext = {
  chapterId: string | null;
  chapterSummary?: string;
  bookChapters: AnyRow[];
  selectionText?: string;
  hasChapterText: boolean;
};

/**
 * 标记引用是否已失效（来源被删除/内容不再存在）。
 * 引用快照本身保留原内容，这里只用于提示，不改写快照。
 */
export function markInvalidRefs(
  refs: AnyRow[],
  ctx: RefValidityContext,
): AnyRow[] {
  return refs.map((x) => {
    let invalid = false;
    if (x.kind === "selection") invalid = !ctx.hasChapterText || !ctx.selectionText;
    else if (x.kind === "chapter")
      invalid = !ctx.bookChapters.some((c) => c.id === x.sourceId);
    else if (x.kind === "summary")
      invalid = !(
        (x.sourceId === ctx.chapterId && Boolean(ctx.chapterSummary)) ||
        ctx.bookChapters.some((c) => c.id === x.sourceId && c.summary)
      );
    else if (x.kind === "continuation") invalid = !ctx.hasChapterText;
    return { ...x, invalid };
  });
}

export type ContextBreakdown = {
  refs: { count: number; chars: number };
  history: { count: number; chars: number };
  draft: { chars: number };
  rules: { chars: number };
  totalChars: number;
  estimateTokens: number;
};

/** 上下文占用拆分：估算口径与界面说明一致（字符数 ÷ 2） */
export function contextBreakdown(
  refs: AnyRow[],
  historyCount: number,
  historyChars: number,
  draftChars: number,
  ruleChars = 0,
): ContextBreakdown {
  const refChars = refs.reduce(
    (n, x) => n + String(x.content || "").length,
    0,
  );
  const totalChars = refChars + historyChars + draftChars + Math.max(0, ruleChars);
  return {
    refs: { count: refs.length, chars: refChars },
    history: { count: historyCount, chars: historyChars },
    draft: { chars: draftChars },
    rules: { chars: Math.max(0, ruleChars) },
    totalChars,
    estimateTokens: Math.ceil(totalChars / 2),
  };
}

/**
 * 任务切换是否允许：仅切任务本身，绝不清空已有草稿。
 * 返回应采用的草稿（保持用户输入优先）。
 */
export function resolveTaskSwitch(
  currentDraft: string,
  taskDraft: string | undefined,
): { draft: string; replaced: boolean } {
  if (currentDraft.trim()) return { draft: currentDraft, replaced: false };
  if (taskDraft) return { draft: taskDraft, replaced: true };
  return { draft: currentDraft, replaced: false };
}
