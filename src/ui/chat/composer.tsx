import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnyRow, kindNameFor } from "../shared";
import { ChatMenu, type MenuItem } from "./menu";
import {
  IconChevronDown,
  IconClose,
  IconPlus,
  IconQuote,
  IconSend,
  IconSparkle,
  IconStop,
} from "./icons";

export type TaskKind = "chat" | "continue" | "naturalize" | "polish" | "outline" | "check";

export type ComposerTask = {
  id?: string;
  kind: string;
  label: string;
  /** 选择任务时准备的草稿内容（可选） */
  draft?: string;
  hint?: string;
};

/** 引用标签：名称 + 类型 + 单独移除 + 点击预览 */
function RefChips({
  refs,
  language,
  onRemove,
  onPreview,
  maxVisible = 4,
}: {
  refs: AnyRow[];
  language: string;
  onRemove: (i: number) => void;
  onPreview: (i: number) => void;
  maxVisible?: number;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [expanded, setExpanded] = useState(false);
  if (!refs.length) return null;
  const shown = expanded ? refs : refs.slice(0, maxVisible);
  const hidden = refs.length - shown.length;
  return (
    <div className="zchat-refs" data-fd-id="ai-ref-chips">
      {shown.map((x, i) => {
        const invalid = x.invalid === true;
        return (
          <span
            className={`zchat-ref ${invalid ? "invalid" : ""}`}
            key={`${x.kind}:${x.sourceId || i}`}
            title={invalid ? tr("来源已删除或失效", "Source deleted or unavailable") : x.label}
          >
            <button
              type="button"
              className="zchat-ref-main"
              onClick={() => onPreview(i)}
              aria-label={tr(`查看引用：${x.label}`, `View reference: ${x.label}`)}
            >
              <IconQuote />
              <span className="zchat-ellipsis">{x.label}</span>
              <small>{kindNameFor(x.kind, language as never)}</small>
            </button>
            <button
              type="button"
              className="zchat-ref-remove"
              aria-label={tr(`移除引用：${x.label}`, `Remove reference: ${x.label}`)}
              title={tr("移除", "Remove")}
              onClick={() => onRemove(i)}
            >
              <IconClose size={12} />
            </button>
          </span>
        );
      })}
      {hidden > 0 && (
        <button
          type="button"
          className="zchat-ref-more"
          onClick={() => setExpanded(true)}
          data-fd-id="ai-ref-more"
        >
          {tr(`还有 ${hidden} 项`, `+${hidden} more`)}
        </button>
      )}
      {expanded && refs.length > maxVisible && (
        <button type="button" className="zchat-ref-more" onClick={() => setExpanded(false)}>
          {tr("收起", "Collapse")}
        </button>
      )}
    </div>
  );
}

export type ComposerProps = {
  language: string;
  float?: boolean;
  /** 引用标签 */
  refs: AnyRow[];
  onRemoveRef: (i: number) => void;
  onPreviewRef: (i: number) => void;
  /** ＋ 引用选择器 */
  onOpenRefPicker: () => void;
  /** 可选的对话与写作任务 */
  tasks: ComposerTask[];
  activeTaskKind: string;
  activeTaskId?: string;
  onSelectTask: (taskId: string) => void;
  /** 草稿 */
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  generating: boolean;
  onStop: () => void;
  canSend: boolean;
  /** 上下文入口 */
  contextSummary: string;
  contextPercent?: number;
  contextExceeded?: boolean;
  contextLimitLabel?: string;
  onOpenContext: () => void;
  sendHint?: string;
  sendStatusLine?: string;
  /** 保存状态或会话级错误 */
  statusLine?: React.ReactNode;
  /** 可选的写作风格选择器，嵌入输入框工具栏 */
  styleControl?: ReactNode;
  /** 续写自动引用提示（可见、可查看范围） */
  autoRefNotice?: string | null;
};

/**
 * 统一输入组件：顶部引用标签、中间多行输入、底部工具行（＋ / 任务 / 上下文 / 发送）。
 * 不再有独立的任务横栏与常驻 Token 说明。
 */
export function Composer({
  language,
  float,
  refs,
  onRemoveRef,
  onPreviewRef,
  onOpenRefPicker,
  tasks,
  activeTaskKind,
  activeTaskId,
  onSelectTask,
  draft,
  onDraftChange,
  onSend,
  generating,
  onStop,
  canSend,
  contextSummary,
  contextPercent = 0,
  contextExceeded = false,
  contextLimitLabel,
  onOpenContext,
  sendHint,
  sendStatusLine,
  statusLine,
  styleControl,
  autoRefNotice,
}: ComposerProps) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const activeTask =
    tasks.find((t) => t.id === activeTaskId) ||
    tasks.find((t) => t.kind === activeTaskKind) ||
    tasks[0];

  // 自增高：两行起，到上限后内部滚动
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 220;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${Math.max(next, 56)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  const taskItems: MenuItem[] = useMemo(
    () => {
      const groupFor = (kind: string) => {
        if (kind === "chat") return tr("对话", "Conversation");
        if (kind === "outline") return tr("构思与起草", "Plan & draft");
        if (kind === "check") return tr("检查", "Review");
        return tr("写作与改稿", "Write & revise");
      };
      const groupOrder = (kind: string) =>
        kind === "chat" ? 0 : kind === "outline" ? 1 : kind === "check" ? 3 : 2;
      return tasks
        .map((task, index) => ({ task, index }))
        .sort((a, b) => groupOrder(a.task.kind) - groupOrder(b.task.kind) || a.index - b.index)
        .map(({ task: t, index }) => ({
          id: t.id || `ai-task-${t.kind}-${index + 1}`,
          label: t.label,
          hint: t.hint,
          group: groupFor(t.kind),
          selected: t.id ? t.id === activeTask?.id : t.kind === activeTaskKind,
          icon: t.kind === "continue" ? <IconSparkle /> : <IconQuote />,
          onSelect: () => onSelectTask(t.id || `ai-task-${t.kind}-${index + 1}`),
        }));
    },
    [tasks, onSelectTask, activeTask?.id, activeTaskKind, language],
  );

  return (
    <div className="zchat-composer" data-fd-id="ai-composer">
      <RefChips
        refs={refs}
        language={language}
        onRemove={onRemoveRef}
        onPreview={onPreviewRef}
      />
      {autoRefNotice ? (
        <div className="zchat-autoref" data-fd-id="ai-autoref-notice">
          <IconSparkle />
          <span className="zchat-ellipsis">{autoRefNotice}</span>
        </div>
      ) : null}
      <textarea
        ref={taRef}
        className="zchat-input"
        data-fd-id="ai-input"
        rows={2}
        aria-label={tr("AI 对话输入框", "AI message composer")}
        placeholder={
          activeTaskKind === "continue"
            ? tr("可选：写下续写要求，留空则顺着上文推进", "Optional: describe how to continue")
            : float
              ? tr("输入问题，与主窗口共享同一会话", "Ask a question in the shared conversation")
              : tr("输入问题，或先添加引用资料", "Ask a question, or add references first")
        }
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      <div className="zchat-composer-bar">
        <div className="zchat-composer-tools" data-fd-id="ai-composer-tools">
          <button
            type="button"
            className="zchat-pill"
            data-fd-id="ai-add-ref"
            aria-label={tr("添加引用", "Add reference")}
            title={tr("添加引用资料", "Add reference material")}
            onClick={onOpenRefPicker}
          >
            <IconPlus />
          </button>
          {styleControl}
          <ChatMenu
            ariaLabel={tr("任务类型", "Task type")}
            dataFdId="ai-task-menu"
            trigger={
              <>
                <IconSparkle />
                <span>{activeTask?.label || tr("对话", "Chat")}</span>
                <IconChevronDown size={13} />
              </>
            }
            triggerClassName="zchat-pill wide"
            items={taskItems}
          />
        </div>
        <div className="zchat-composer-actions" data-fd-id="ai-composer-actions">
          <button
            type="button"
            className="zchat-pill context"
            data-fd-id="ai-context-entry"
            aria-label={tr(
              `查看上下文占用：${contextSummary}${contextLimitLabel ? ` ${contextLimitLabel}` : ""}，${Math.round(contextPercent)}%`,
              `Context usage: ${contextSummary}${contextLimitLabel ? ` ${contextLimitLabel}` : ""}, ${Math.round(contextPercent)}%`,
            )}
            title={tr("查看上下文占用与将要发送的内容", "View context usage and what will be sent")}
            onClick={onOpenContext}
          >
            <span
              className={`zchat-context-ring ${contextExceeded ? "over" : contextPercent >= 80 ? "warn" : ""}`}
              style={{ "--context-progress": `${Math.min(100, Math.max(0, contextPercent))}%` } as React.CSSProperties}
              aria-hidden="true"
            >
              <i />
            </span>
            <span className="zchat-context-summary" data-fd-id="ai-context-summary">{contextSummary}</span>
            {contextLimitLabel ? <small className="zchat-context-limit">{contextLimitLabel}</small> : null}
          </button>
          <small className="zchat-enter-hint" aria-hidden="true">{tr("Enter 发送 · Shift+Enter 换行", "Enter to send · Shift+Enter for newline")}</small>
          {generating ? (
            <button
              type="button"
              className="zchat-send stop"
              data-fd-id="ai-stop"
              aria-label={tr("停止生成", "Stop generating")}
              title={tr("停止生成", "Stop generating")}
              onClick={onStop}
            >
              <IconStop />
            </button>
          ) : (
            <button
              type="button"
              className="zchat-send"
              data-fd-id="ai-send"
              aria-keyshortcuts="Enter"
              disabled={!canSend}
              aria-label={
                activeTaskKind === "continue"
                  ? tr("生成续写", "Generate continuation")
                  : tr("发送", "Send")
              }
              title={sendHint || (activeTaskKind === "continue"
                ? tr("生成续写（Enter）", "Generate continuation (Enter)")
                : tr("发送（Enter）", "Send (Enter)"))}
              aria-description={sendHint || undefined}
              onClick={onSend}
            >
              <IconSend />
            </button>
          )}
        </div>
      </div>
      {(statusLine || sendStatusLine || activeTask?.hint) && (
        <div className="zchat-composer-status">
          {statusLine}
          {sendStatusLine ? <span className={`zchat-send-status ${contextExceeded ? "error" : ""}`} id="ai-send-context-status" role="status" aria-live="polite">{sendStatusLine}</span> : null}
          {activeTask?.hint && !statusLine ? <span className="hint">{activeTask.hint}</span> : null}
        </div>
      )}
    </div>
  );
}
