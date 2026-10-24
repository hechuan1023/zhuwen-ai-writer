import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  IconRetry,
  IconUser,
} from "./icons";

/** 回到底部按钮：仅在用户上翻离开底部时出现 */
function ScrollToBottom() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const [visible, setVisible] = useState(false);
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
      aria-label="回到底部"
      title="回到底部"
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
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`zchat-act ${compact ? "icon-only" : ""}`}
      data-fd-id="ai-copy"
      aria-label={tr("复制", "Copy")}
      title={tr("复制", "Copy")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* 剪贴板不可用时静默失败，不影响阅读 */
        }
      }}
    >
      {done ? <IconCheck /> : <IconCopy />}
      {!compact && <span>{done ? tr("已复制", "Copied") : tr("复制", "Copy")}</span>}
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
}: {
  content: string;
  language: string;
  actions: ReplyActions;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
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
  onRetry?: () => void;
  retryLabel?: string;
  errorMessage?: string | null;
  onOpenSource?: (messageId: string, source: AnyRow) => void;
};

export function MessageList({
  messages,
  language,
  renderMarkdown,
  actionsFor,
  emptyState,
  conversationId,
  errorMessage,
  onRetry,
  retryLabel,
  onOpenSource,
}: MessageListProps) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastConv = useRef(conversationId);

  // 切换会话：先记录位置，再在下一帧恢复到该会话的合理位置（底部）
  useEffect(() => {
    if (lastConv.current === conversationId) return;
    lastConv.current = conversationId;
    const el = containerRef.current?.querySelector<HTMLElement>(".zchat-scroll");
    if (el) el.scrollTop = 0;
  }, [conversationId]);

  const memoMessages = useMemo(
    () =>
      messages.map((m, i) => {
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
                {m.model ? <small className="zchat-ellipsis">{m.model}</small> : null}
                {m.incomplete && (
                  <em className="zchat-incomplete">{tr("未完整回答", "incomplete")}</em>
                )}
              </div>
              <div className="zchat-msg-content">
                {renderMarkdown(m.content)}
                {m.streaming && <i className="zchat-cursor" aria-hidden="true" />}
              </div>
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
                />
              )}
              {isUser && !m.streaming && (
                <div className="zchat-actions">
                  <CopyButton text={String(m.content || "")} language={language} compact />
                </div>
              )}
            </div>
          </div>
        );
      }),
    // 依赖消息数组与语言：内容变化（流式）时只重渲染列表，不重建结构
    [messages, language, actionsFor, renderMarkdown, onOpenSource],
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
          {messages.length ? (
            memoMessages
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
        <ScrollToBottom />
      </StickToBottom>
    </div>
  );
}
