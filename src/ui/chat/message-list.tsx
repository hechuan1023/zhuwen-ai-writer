import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { AnyRow } from "../shared";
import { ChatMenu, type MenuItem } from "./menu";
import {
  IconArrowDown,
  IconCheck,
  IconCopy,
  IconDoc,
  IconMore,
  IconQuote,
  IconRename,
  IconRetry,
  IconUser,
} from "./icons";
import { findSourcePrompt } from "./chat-model";

/** 回到底部按钮：仅在用户上翻离开底部时出现 */
function ScrollToBottom({ language }: { language: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const [visible, setVisible] = useState(false);
  const label = language === "en" ? "Scroll to bottom" : "回到底部";
  useEffect(() => {
    if (isAtBottom) {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setVisible(true), 120);
    return () => clearTimeout(t);
  }, [isAtBottom]);
  if (!visible) return null;
  return (
    <button
      type="button"
      className="zchat-to-bottom"
      data-fd-id="ai-to-bottom"
      aria-label={label}
      title={label}
      onClick={() => scrollToBottom()}
    >
      <IconArrowDown />
    </button>
  );
}

function CopyButton({
  text,
  language,
  compact,
}: {
  text: string;
  language: string;
  compact?: boolean;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [copyState, setCopyState] = useState<"idle" | "done" | "error">("idle");
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      // Continue with the hidden-textarea fallback for restricted desktop contexts.
    }
    const previousFocus = document.activeElement as HTMLElement | null;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    try {
      textarea.focus();
      textarea.select();
      if (!document.execCommand("copy")) throw new Error("Clipboard copy failed");
    } finally {
      textarea.remove();
      previousFocus?.focus?.({ preventScroll: true });
    }
  }
  const statusText = copyState === "done"
    ? tr("已复制", "Copied")
    : copyState === "error"
      ? tr("复制失败，请检查剪贴板权限", "Copy failed; check clipboard permissions")
      : tr("复制", "Copy");
  return (
    <button
      type="button"
      className={`zchat-act ${compact ? "icon-only" : ""}`}
      data-fd-id="ai-copy"
      aria-label={statusText}
      title={statusText}
      onClick={async () => {
        try {
          await copy();
          setCopyState("done");
        } catch {
          setCopyState("error");
        }
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setCopyState("idle"), 1800);
      }}
    >
      {copyState === "done" ? <IconCheck /> : <IconCopy />}
      {!compact && <span>{statusText}</span>}
      <span className="sr-only" role="status" aria-live="polite">{copyState === "idle" ? "" : statusText}</span>
    </button>
  );
}

export type ReplyActions = {
  canApply: boolean;
  /** 缺少选区等原因，禁用采纳时的说明 */
  applyDisabledReason?: string;
  canAppendToEnd: boolean;
  onInsertCursor: () => void;
  onReplaceSelection: () => void;
  onAppendToEnd: () => void;
  onSegments: () => void;
  onCompare: () => void;
  onSaveInspiration: () => void;
  /** 浮窗内不允许改动正文 */
  floatOnlyHint?: boolean;
  /** 自然化润色必须先走原文/结果差异确认 */
  requiresComparison?: boolean;
};

/** 单条 AI 回复：默认只显示 复制 / 采纳 / 更多 */
function AssistantActions({
  content,
  language,
  actions,
  sourcePrompt,
  onRetryPrompt,
  onRegeneratePrompt,
}: {
  content: string;
  language: string;
  actions: ReplyActions;
  sourcePrompt: AnyRow | null;
  onRetryPrompt?: (message: AnyRow) => void;
  onRegeneratePrompt?: (message: AnyRow) => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const retryItems: MenuItem[] = [
    {
      id: "ai-regenerate-branch",
      label: tr("重新生成（新分支）", "Try again in a new branch"),
      icon: <IconRetry />,
      hint: tr("保留当前回复", "Keeps this reply"),
      disabled: !sourcePrompt || !onRegeneratePrompt,
      onSelect: () => { if (sourcePrompt) onRegeneratePrompt?.(sourcePrompt); },
    },
    {
      id: "ai-edit-prompt-branch",
      label: tr("编辑原提问并重试", "Edit prompt and retry"),
      icon: <IconRename />,
      hint: tr("检查后手动发送", "Review before sending"),
      disabled: !sourcePrompt || !onRetryPrompt,
      onSelect: () => { if (sourcePrompt) onRetryPrompt?.(sourcePrompt); },
    },
  ];
  const adoptItems: MenuItem[] = [
    {
      id: "ai-adopt-insert",
      label: tr("插入光标", "Insert at cursor"),
      icon: <IconQuote />,
      disabled: !actions.canApply || actions.requiresComparison,
      hint: !actions.canApply
        ? actions.applyDisabledReason
        : actions.requiresComparison
          ? tr("自然化润色必须先查看差异", "Naturalize must be compared first")
          : undefined,
      onSelect: actions.onInsertCursor,
    },
    {
      id: "ai-adopt-replace",
      label: tr("替换选区", "Replace selection"),
      disabled: !actions.canApply || actions.requiresComparison,
      hint: !actions.canApply
        ? actions.applyDisabledReason
        : actions.requiresComparison
          ? tr("自然化润色必须先查看差异", "Naturalize must be compared first")
          : undefined,
      onSelect: actions.onReplaceSelection,
    },
    {
      id: "ai-adopt-append",
      label: tr("追加到章末", "Append to chapter"),
      disabled: !actions.canAppendToEnd || actions.requiresComparison,
      hint: !actions.canAppendToEnd
        ? tr("仅对本次续写结果显示", "Only for the latest continuation")
        : undefined,
      onSelect: actions.onAppendToEnd,
    },
    {
      id: "ai-adopt-segments",
      label: tr("逐句采纳", "Adopt by sentence"),
      disabled: !actions.canApply || actions.requiresComparison,
      hint: !actions.canApply
        ? actions.applyDisabledReason
        : actions.requiresComparison
          ? tr("自然化润色必须先查看差异", "Naturalize must be compared first")
          : undefined,
      onSelect: actions.onSegments,
    },
    {
      id: "ai-adopt-compare",
      label: tr("对比修改", "Compare changes"),
      disabled: !actions.canApply,
      hint: actions.requiresComparison ? tr("自然化润色必须先查看差异", "Naturalize must be compared first") : (!actions.canApply ? actions.applyDisabledReason : undefined),
      onSelect: actions.onCompare,
    },
  ];
  const moreItems: MenuItem[] = [
    {
      id: "ai-more-inspiration",
      label: tr("存为灵感", "Save as idea"),
      icon: <IconDoc />,
      onSelect: actions.onSaveInspiration,
    },
  ];
  return (
    <div className="zchat-actions">
      <CopyButton text={content} language={language} compact />
      {sourcePrompt && (onRetryPrompt || onRegeneratePrompt) && (
        <ChatMenu
          ariaLabel={tr("重新生成或编辑提问", "Retry or edit prompt")}
          dataFdId="ai-retry-options"
          trigger={<IconRetry />}
          triggerClassName="zchat-act icon-only zchat-retry-prompt"
          items={retryItems}
          align="start"
        />
      )}
      {actions.floatOnlyHint ? (
        <span className="zchat-actions-hint">
          {tr("采纳修改请在主窗口操作", "Apply from the main window")}
        </span>
      ) : (
        <>
          <ChatMenu
            ariaLabel={tr("采纳", "Adopt")}
            dataFdId="ai-adopt-menu"
            trigger={
              <>
                <IconCheck />
                <span>{tr("采纳", "Adopt")}</span>
              </>
            }
            triggerClassName="zchat-act wide"
            items={adoptItems}
            align="start"
          />
          <ChatMenu
            ariaLabel={tr("更多回复操作", "More reply actions")}
            dataFdId="ai-reply-more"
            trigger={<IconMore />}
            triggerClassName="zchat-act icon-only"
            items={moreItems}
            align="start"
          />
        </>
      )}
    </div>
  );
}

export type MessageListProps = {
  messages: AnyRow[];
  language: string;
  renderMarkdown: (text: string) => ReactNode;
  actionsFor: (m: AnyRow) => ReplyActions;
  emptyState?: ReactNode;
  /** 会话切换时用于恢复各自阅读位置 */
  conversationId: string;
  hasEarlierMessages?: boolean;
  onLoadEarlier?: (beforeMessageId: string) => Promise<{
    ok: boolean;
    rows?: AnyRow[];
    hasEarlier?: boolean;
    error?: string;
  }>;
  onRetry?: () => void;
  retryLabel?: string;
  errorMessage?: string | null;
  onOpenSource?: (messageId: string, source: AnyRow) => void;
  onReusePrompt?: (message: AnyRow) => void;
  onRegeneratePrompt?: (message: AnyRow) => void;
};

export function MessageList({
  messages,
  language,
  renderMarkdown,
  actionsFor,
  emptyState,
  conversationId,
  hasEarlierMessages = false,
  onLoadEarlier,
  errorMessage,
  onRetry,
  retryLabel,
  onOpenSource,
  onReusePrompt,
  onRegeneratePrompt,
}: MessageListProps) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const PAGE_SIZE = 80;
  const containerRef = useRef<HTMLDivElement>(null);
  const lastConv = useRef(conversationId);
  const loadSequence = useRef(0);
  const [earlierMessages, setEarlierMessages] = useState<AnyRow[]>([]);
  const [hasEarlier, setHasEarlier] = useState(hasEarlierMessages);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [loadEarlierError, setLoadEarlierError] = useState("");
  const prependScroll = useRef<{ height: number; top: number } | null>(null);

  async function loadEarlier() {
    if (loadingEarlier || !hasEarlier || !onLoadEarlier) return;
    const beforeMessageId = [...earlierMessages, ...messages].find((message) => message.id)?.id;
    if (!beforeMessageId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(".zchat-scroll");
    if (!el) return;
    const sequence = ++loadSequence.current;
    prependScroll.current = { height: el.scrollHeight, top: el.scrollTop };
    setLoadingEarlier(true);
    setLoadEarlierError("");
    const result = await onLoadEarlier(String(beforeMessageId));
    if (sequence !== loadSequence.current) return;
    setLoadingEarlier(false);
    if (!result.ok) {
      prependScroll.current = null;
      setLoadEarlierError(result.error || tr("读取更早消息失败", "Could not load earlier messages"));
      return;
    }
    const rows = result.rows || [];
    if (!rows.length) prependScroll.current = null;
    setEarlierMessages((current) => {
      const ids = new Set([...current, ...messages].map((message) => String(message.id || "")).filter(Boolean));
      return [...current, ...rows.filter((message) => !message.id || !ids.has(String(message.id)))];
    });
    setHasEarlier(Boolean(result.hasEarlier && rows.length));
  }

  useLayoutEffect(() => {
    const pending = prependScroll.current;
    if (!pending) return;
    prependScroll.current = null;
    const el = containerRef.current?.querySelector<HTMLElement>(".zchat-scroll");
    if (el) el.scrollTop = pending.top + (el.scrollHeight - pending.height);
  }, [earlierMessages]);

  // 切换会话：先记录位置，再在下一帧恢复到该会话的合理位置（底部）
  useEffect(() => {
    if (lastConv.current === conversationId) return;
    lastConv.current = conversationId;
    loadSequence.current += 1;
    prependScroll.current = null;
    setEarlierMessages([]);
    setHasEarlier(hasEarlierMessages);
    setLoadingEarlier(false);
    setLoadEarlierError("");
    const el = containerRef.current?.querySelector<HTMLElement>(".zchat-scroll");
    if (el) el.scrollTop = 0;
  }, [conversationId]);

  useEffect(() => {
    if (hasEarlierMessages) setHasEarlier(true);
  }, [hasEarlierMessages]);

  const allMessages = useMemo(
    () => {
      const seen = new Set<string>();
      return [...earlierMessages, ...messages].filter((message) => {
        if (!message.id) return true;
        const id = String(message.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    },
    [earlierMessages, messages],
  );

  const memoMessages = useMemo(
    () =>
      allMessages.map((m, i) => {
        const isUser = m.role === "user";
        const key = m.id || `local-${i}`;
        return (
          <div
            className={`zchat-msg ${isUser ? "user" : "assistant"}`}
            key={key}
            data-fd-id={`ai-msg-${isUser ? "user" : "assistant"}`}
          >
            <div className="zchat-msg-avatar" aria-hidden="true">
              {isUser ? <IconUser /> : <span className="zchat-mark">铸</span>}
            </div>
            <div className="zchat-msg-body">
              <div className="zchat-msg-meta">
                <span>{isUser ? tr("你", "You") : tr("AI", "AI")}</span>
                {m.incomplete && (
                  <em className="zchat-incomplete">{tr("未完整回答", "incomplete")}</em>
                )}
              </div>
              <div className="zchat-msg-content">
                {renderMarkdown(m.content)}
                {m.streaming && <i className="zchat-cursor" aria-hidden="true" />}
              </div>
              {isUser && String(m.style_rules || "").trim() && (
                <details className="zchat-msg-instruction-snapshot zchat-msg-style-snapshot">
                  <summary title={m.style_name ? `${m.style_name}${m.style_version ? ` · v${m.style_version}` : ""}` : undefined}>
                    <IconDoc />
                    <span>{tr("本次写作规则", "Writing rules used")}</span>
                    <small>
                      {m.style_name ? `${m.style_name} · ` : ""}
                      {Array.from(String(m.style_rules)).length} {tr("字", "chars")}
                    </small>
                  </summary>
                  <pre>{String(m.style_rules)}</pre>
                </details>
              )}
              {isUser && String(m.project_instructions || "").trim() && (
                <details className="zchat-msg-instruction-snapshot">
                  <summary>
                    <IconDoc />
                    <span>{tr("作品指令快照", "Project instructions")}</span>
                    <small>{Array.from(String(m.project_instructions)).length} {tr("字", "chars")}</small>
                  </summary>
                  <pre>{String(m.project_instructions)}</pre>
                </details>
              )}
              {!isUser && Array.isArray(m.source_refs) && m.source_refs.length > 0 && (
                <div className="zchat-msg-sources" aria-label={tr("本次回复引用来源", "Sources used for this reply")}>
                  <span>{tr("依据", "Sources")}</span>
                  {m.source_refs.map((source: AnyRow, sourceIndex: number) => (
                    <button
                      type="button"
                      key={`${source.kind}:${source.source_id || sourceIndex}`}
                      title={tr(
                        source.source_status === "changed" ? "资料已更新 · 查看请求时快照" :
                          source.source_status === "deleted" ? "资料已删除 · 查看请求时快照" :
                            source.source_status === "missing" ? "原资料不存在 · 查看请求时快照" :
                              "查看本次请求保存的来源快照",
                        source.source_status === "changed" ? "Material changed · view request snapshot" :
                          source.source_status === "deleted" ? "Material deleted · view request snapshot" :
                            source.source_status === "missing" ? "Original missing · view request snapshot" :
                              "View the source snapshot saved with this request",
                      )}
                      onClick={() => onOpenSource?.(String(m.source_message_id || ""), source)}
                    >
                      <IconQuote />
                      <span>{source.label || source.kind}</span>
                    </button>
                  ))}
                </div>
              )}
              {!isUser && m.source_stale && (
                <div className="zchat-source-stale" role="status">
                  {tr("生成后正文有更新 · 采纳前请核对", "Manuscript changed since generation · review before adopting")}
                </div>
              )}
              {!isUser && m.source_material_stale && (
                <div className="zchat-source-stale" role="status">
                  {tr("引用资料生成后已变化 · 查看来源快照，采纳前需确认", "A referenced material changed after generation · review the source snapshot before adopting")}
                </div>
              )}
              {!isUser && m.source_chapter_other && (
                <div className="zchat-source-origin" role="status">
                  {tr("回复生成于：", "Generated for: ")}{m.source_chapter_title || tr("其他章节", "another chapter")}
                </div>
              )}
              {!isUser && !m.streaming && (
                <AssistantActions
                  content={String(m.content || "")}
                  language={language}
                  actions={actionsFor(m)}
                  sourcePrompt={findSourcePrompt(allMessages, m)}
                  onRetryPrompt={onReusePrompt}
                  onRegeneratePrompt={onRegeneratePrompt}
                />
              )}
              {isUser && !m.streaming && (
                <div className="zchat-actions">
                  <CopyButton text={String(m.content || "")} language={language} compact />
                  {onReusePrompt && (
                    <button
                      type="button"
                      className="zchat-act icon-only zchat-retry-prompt"
                      data-fd-id="ai-reuse-prompt"
                      aria-label={tr("从这里分支并编辑", "Branch and edit from here")}
                      title={tr("从此处创建分支并编辑提问", "Create a branch here and edit the prompt")}
                      onClick={() => onReusePrompt(m)}
                    >
                      <IconRetry />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      }),
    // 依赖消息数组与语言：内容变化（流式）时只重渲染列表，不重建结构
    [allMessages, language, actionsFor, renderMarkdown, onOpenSource, onReusePrompt, onRegeneratePrompt],
  );

  return (
    <div className="zchat-scroll-host" ref={containerRef}>
      <StickToBottom
        className="zchat-scroll"
        resize="smooth"
        initial="smooth"
        role="log"
        aria-live="polite"
        aria-label={tr("消息记录", "Message history")}
      >
        <StickToBottom.Content className="zchat-scroll-inner">
          {allMessages.length ? (
            <>
              {hasEarlier && (
                <button
                  type="button"
                  className="zchat-load-earlier"
                  data-fd-id="ai-load-earlier"
                  onClick={loadEarlier}
                  disabled={loadingEarlier}
                >
                  {tr(loadingEarlier ? "正在加载…" : `加载更早的 ${PAGE_SIZE} 条消息`, loadingEarlier ? "Loading…" : `Load ${PAGE_SIZE} earlier messages`)}
                </button>
              )}
              {loadEarlierError && <div className="zchat-load-earlier-error" role="alert">{loadEarlierError}</div>}
              {memoMessages}
            </>
          ) : (
            <div className="zchat-empty">{emptyState}</div>
          )}
          {errorMessage && (
            <div className="zchat-error" role="alert">
              <small>{errorMessage}</small>
              {onRetry && (
                <button type="button" onClick={onRetry} data-fd-id="ai-retry">
                  <IconRetry />
                  {retryLabel || tr("重试", "Retry")}
                </button>
              )}
            </div>
          )}
        </StickToBottom.Content>
        <ScrollToBottom language={language} />
      </StickToBottom>
    </div>
  );
}
