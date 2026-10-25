import { describe, expect, it } from "vitest";
import { formatConversationMarkdown, safeConversationFilename } from "../electron/ai-conversation-export";

describe("AI 对话 Markdown 导出", () => {
  it("preserves message order and Markdown content while labeling speakers", () => {
    const markdown = formatConversationMarkdown("剧情讨论", [
      { role: "user", content: "请检查 **动机**。", created_at: "2026-10-25 10:00" },
      { role: "system", content: "must not be exported" },
      { role: "assistant", content: "角色需要一个可见目标。", created_at: "2026-10-25 10:01" },
    ]);

    expect(markdown).toContain("# 剧情讨论");
    expect(markdown.indexOf("## 你 · 2026-10-25 10:00")).toBeLessThan(markdown.indexOf("## 铸文 · 2026-10-25 10:01"));
    expect(markdown).toContain("请检查 **动机**。");
    expect(markdown).not.toContain("must not be exported");
  });

  it("marks incomplete assistant messages and safely creates Windows filenames", () => {
    expect(formatConversationMarkdown("测试", [{ role: "assistant", content: "尚未完成", incomplete: true }]))
      .toContain("> 回复未完成");
    expect(safeConversationFilename('剧情: “门外”?.')).toBe('剧情_ “门外”_.md');
    expect(safeConversationFilename("... ")).toBe("铸文对话.md");
  });
});
