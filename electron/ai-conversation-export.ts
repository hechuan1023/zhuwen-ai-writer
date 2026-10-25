export type ExportableAiMessage = {
  role: string;
  content: string;
  created_at?: string | null;
  incomplete?: number | boolean | null;
};

export function safeConversationFilename(title: string): string {
  const safe = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/u, "")
    .trim()
    .slice(0, 90);
  return `${safe || "铸文对话"}.md`;
}

export function formatConversationMarkdown(
  title: string,
  messages: readonly ExportableAiMessage[],
): string {
  const safeTitle = title.replace(/[\r\n]+/gu, " ").trim() || "未命名对话";
  const blocks = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const speaker = message.role === "user" ? "你" : "铸文";
      const time = String(message.created_at || "").trim();
      const content = String(message.content || "").trimEnd();
      const incomplete = message.incomplete ? "\n\n> 回复未完成" : "";
      return `## ${speaker}${time ? ` · ${time}` : ""}\n\n${content || "（空消息）"}${incomplete}`;
    });
  return `# ${safeTitle}\n\n> 导出自铸文 AI 对话\n\n${blocks.join("\n\n---\n\n")}\n`;
}
