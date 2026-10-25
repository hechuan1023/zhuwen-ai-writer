import { describe, expect, it } from "vitest";
import {
  contextBreakdown,
  filterConversations,
  findSourcePrompt,
  groupConversations,
  markInvalidRefs,
  partitionPinnedConversations,
  resolveTaskSwitch,
} from "../src/ui/chat/chat-model";

const conv = (id: string, updated: string, title = id, snippet = "") => ({
  id,
  title,
  last_snippet: snippet,
  updated_at: updated,
});

describe("groupConversations：本地日历日分组", () => {
  const now = new Date("2026-03-10T15:00:00");
  it("今天 / 近 7 天 / 更早分别归组，空组不出现", () => {
    const groups = groupConversations(
      [
        conv("a", "2026-03-10T09:00:00"),
        conv("b", "2026-03-09T23:30:00"),
        conv("c", "2026-03-01T10:00:00"),
      ],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual(["today", "week", "older"]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["a"]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(["b"]);
    expect(groups[2].rows.map((r) => r.id)).toEqual(["c"]);
  });

  it("只有今天的会话时只返回今天一组", () => {
    const groups = groupConversations([conv("a", "2026-03-10T01:00:00")], now);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("today");
  });

  it("时间缺失或非法归入更早（不丢记录）", () => {
    const groups = groupConversations([conv("x", ""), conv("y", "not-a-date")], now);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("older");
    expect(groups[0].rows).toHaveLength(2);
  });

  it("跨月边界：上月同日不算今天", () => {
    const groups = groupConversations(
      [conv("prev", "2026-02-10T15:00:00")],
      now,
    );
    expect(groups[0].key).toBe("older");
  });
});

describe("置顶对话分区", () => {
  it("separates pinned rows and keeps their existing order", () => {
    const rows = [
      { id: "recent", pinned: 0 },
      { id: "pinned-a", pinned: 1 },
      { id: "pinned-b", pinned: 1 },
    ];
    const result = partitionPinnedConversations(rows);
    expect(result.pinned.map((row) => row.id)).toEqual(["pinned-a", "pinned-b"]);
    expect(result.recent.map((row) => row.id)).toEqual(["recent"]);
  });
});

describe("assistant 回复与原始提问的关联", () => {
  const messages = [
    { id: "u-1", role: "user", content: "第一次提问" },
    { id: "a-1", role: "assistant", source_message_id: "u-1", content: "回复一" },
    { id: "u-2", role: "user", content: "第二次提问" },
    { id: "a-2", role: "assistant", source_message_id: "u-2", content: "回复二" },
  ];
  it("按来源 ID 找到正确问题，不依赖相邻顺序", () => {
    expect(findSourcePrompt(messages, messages[1])).toBe(messages[0]);
    expect(findSourcePrompt(messages, messages[3])).toBe(messages[2]);
  });
  it("来源缺失或指向 assistant 消息时不提供重试入口", () => {
    expect(findSourcePrompt(messages, { role: "assistant" })).toBeNull();
    expect(findSourcePrompt(messages, { source_message_id: "a-1" })).toBeNull();
  });
});

describe("filterConversations：搜索语义", () => {
  const rows = [
    conv("a", "2026-03-10T09:00:00", "雾港来信", "关于灯塔"),
    conv("b", "2026-03-09T09:00:00", "Another", "lighthouse keeper"),
  ];
  it("空查询返回全部", () => {
    expect(filterConversations(rows, "   ")).toHaveLength(2);
  });
  it("命中标题", () => {
    expect(filterConversations(rows, "雾港").map((r) => r.id)).toEqual(["a"]);
  });
  it("命中摘要且大小写不敏感", () => {
    expect(filterConversations(rows, "LIGHTHOUSE").map((r) => r.id)).toEqual(["b"]);
  });
  it("无匹配返回空数组", () => {
    expect(filterConversations(rows, "不存在")).toHaveLength(0);
  });
});

describe("markInvalidRefs：失效来源标记", () => {
  const ctx = {
    chapterId: "ch1",
    chapterSummary: "摘要",
    bookChapters: [
      { id: "ch1", summary: "摘要" },
      { id: "ch2", summary: "" },
    ],
    selectionText: "选中的话",
    hasChapterText: true,
  };
  it("来源章节已删除 → invalid", () => {
    const out = markInvalidRefs(
      [{ kind: "chapter", sourceId: "gone", content: "x", label: "已删除章节" }],
      ctx,
    );
    expect(out[0].invalid).toBe(true);
  });
  it("有正文与选中文字时，选区引用有效", () => {
    const out = markInvalidRefs(
      [{ kind: "selection", sourceId: "ch1", content: "s", label: "选区" }],
      ctx,
    );
    expect(out[0].invalid).toBe(false);
  });
  it("正文为空时选区引用失效", () => {
    const out = markInvalidRefs(
      [{ kind: "selection", sourceId: "ch1", content: "s", label: "选区" }],
      { ...ctx, hasChapterText: false },
    );
    expect(out[0].invalid).toBe(true);
  });
  it("无摘要章节的摘要引用失效，有摘要的有效", () => {
    const out = markInvalidRefs(
      [
        { kind: "summary", sourceId: "ch2", content: "s", label: "ch2 摘要" },
        { kind: "summary", sourceId: "ch1", content: "s", label: "ch1 摘要" },
      ],
      ctx,
    );
    expect(out[0].invalid).toBe(true);
    expect(out[1].invalid).toBe(false);
  });
  it("保留原快照内容，仅附加 invalid 标记", () => {
    const out = markInvalidRefs(
      [{ kind: "chapter", sourceId: "ch1", content: "原文", label: "ch1" }],
      ctx,
    );
    expect(out[0].content).toBe("原文");
    expect(out[0].invalid).toBe(false);
  });
});

describe("contextBreakdown：口径与界面一致", () => {
  it("引用/历史/输入分别统计，tokens 按字符 ÷2 向上取整", () => {
    const b = contextBreakdown(
      [{ content: "abcde" }, { content: "12345" }],
      3,
      100,
      7,
    );
    expect(b.refs).toEqual({ count: 2, chars: 10 });
    expect(b.history).toEqual({ count: 3, chars: 100 });
    expect(b.draft.chars).toBe(7);
    expect(b.totalChars).toBe(117);
    expect(b.estimateTokens).toBe(59);
  });
  it("写作规则也计入字符额度，但 token 估算单独保留", () => {
    const b = contextBreakdown([{ content: "引用" }], 2, 8, 4, 6);
    expect(b.totalChars).toBe(20);
    expect(b.rules.chars).toBe(6);
    expect(b.estimateTokens).toBe(10);
  });
  it("全空时 tokens 为 0，不出现负数", () => {
    expect(contextBreakdown([], 0, 0, 0).estimateTokens).toBe(0);
  });
});

describe("resolveTaskSwitch：切换任务不吞草稿", () => {
  it("已有输入时保留用户输入", () => {
    expect(resolveTaskSwitch("我的长草稿", "任务示例")).toEqual({
      draft: "我的长草稿",
      replaced: false,
    });
  });
  it("空草稿时才写入任务示例", () => {
    expect(resolveTaskSwitch("   ", "任务示例")).toEqual({
      draft: "任务示例",
      replaced: true,
    });
  });
  it("无任务示例时保持原样", () => {
    expect(resolveTaskSwitch("", undefined)).toEqual({
      draft: "",
      replaced: false,
    });
  });
});
