import { useEffect, useRef, useState } from "react";
import { AnyRow } from "../shared";
import { IconArchive, IconClose, IconPin, IconPlus, IconRetry, IconRestore, IconSearch } from "./icons";
import { filterConversations, groupConversations, partitionPinnedConversations } from "./chat-model";

/** 历史对话抽屉：浮层覆盖，不挤压消息区；Esc 关闭并归还焦点。 */
export function HistoryDrawer({
  language,
  novelTitle,
  conversations,
  currentId,
  query,
  loading,
  error,
  hasMore,
  onQuery,
  onNew,
  onSelect,
  onTogglePinned,
  onToggleArchived,
  archivedMode,
  onArchivedModeChange,
  onLoadMore,
  onRetry,
  onClose,
}: {
  language: string;
  novelTitle: string;
  conversations: AnyRow[];
  currentId: string;
  query: string;
  loading: boolean;
  error?: string | null;
  hasMore: boolean;
  onQuery: (q: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onTogglePinned: (id: string, pinned: boolean) => Promise<boolean>;
  onToggleArchived: (id: string, archived: boolean) => Promise<boolean>;
  archivedMode: boolean;
  onArchivedModeChange: (archived: boolean) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement;
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  const filtered = filterConversations(conversations, query);
  const partitioned = archivedMode
    ? { pinned: [] as AnyRow[], recent: filtered }
    : partitionPinnedConversations(filtered);
  const groups = groupConversations(partitioned.recent).map((g) => ({
    key: g.key,
    label: language === "en" ? g.labelKey.en : g.labelKey.zh,
    rows: g.rows,
  }));

  async function togglePinned(conversation: AnyRow) {
    const id = String(conversation.id || "");
    setBusyId(id);
    try {
      await onTogglePinned(id, Number(conversation.pinned) !== 1);
    } finally {
      setBusyId("");
    }
  }

  async function toggleArchived(conversation: AnyRow) {
    const id = String(conversation.id || "");
    setBusyId(id);
    try {
      await onToggleArchived(id, !archivedMode);
    } finally {
      setBusyId("");
    }
  }

  function renderConversation(conversation: AnyRow) {
    const id = String(conversation.id || "");
    const pinned = Number(conversation.pinned) === 1;
    const title = String(conversation.title || "");
    return (
      <div className={`zchat-conv-item ${id === currentId ? "active" : ""}`} key={id} data-fd-id="ai-history-row">
        <button type="button" className="zchat-conv-row" aria-current={id === currentId ? "true" : undefined} onClick={() => onSelect(id)}>
          <span className="zchat-conv-title">
          {pinned && !archivedMode && <IconPin className="zchat-conv-pin-indicator" size={12} />}
            <b className="zchat-ellipsis" title={title}>{title || tr("未命名对话", "Untitled")}</b>
          </span>
          <small className="zchat-ellipsis">{String(conversation.last_snippet || "").trim() || tr("（暂无内容摘要）", "(no summary)")}</small>
        </button>
        {!archivedMode && <button
          type="button"
          className={`zchat-conv-pin ${pinned ? "pinned" : ""}`}
          aria-label={pinned ? tr(`取消置顶：${title}`, `Unpin conversation: ${title}`) : tr(`置顶：${title}`, `Pin conversation: ${title}`)}
          aria-pressed={pinned}
          title={pinned ? tr("取消置顶", "Unpin") : tr("置顶对话", "Pin conversation")}
          disabled={busyId === id}
          onClick={() => void togglePinned(conversation)}
        >
          <IconPin size={14} />
        </button>}
        <button
          type="button"
          className={`zchat-conv-pin zchat-conv-archive ${archivedMode ? "pinned" : ""}`}
          aria-label={archivedMode ? tr(`恢复对话：${title}`, `Restore conversation: ${title}`) : tr(`归档对话：${title}`, `Archive conversation: ${title}`)}
          title={archivedMode ? tr("恢复对话", "Restore conversation") : tr("归档对话", "Archive conversation")}
          disabled={busyId === id}
          onClick={() => void toggleArchived(conversation)}
        >
          {archivedMode ? <IconRestore size={14} /> : <IconArchive size={14} />}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="zchat-drawer-scrim" onMouseDown={onClose} />
      <div
        className="zchat-drawer"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={tr("历史对话", "Conversation history")}
        data-fd-id="ai-history-drawer"
      >
        <div className="zchat-drawer-head">
          <span className="zchat-search">
            <IconSearch />
            <input
              ref={searchRef}
              placeholder={tr("搜索历史对话", "Search conversations")}
              aria-label={tr("搜索历史对话", "Search conversations")}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
            />
          </span>
          <button
            type="button"
            className="zchat-icon-btn"
            data-fd-id="ai-history-new"
            aria-label={tr("新建对话", "New conversation")}
            title={tr("新建对话", "New conversation")}
            onClick={onNew}
          >
            <IconPlus />
          </button>
          <button
            type="button"
            className="zchat-icon-btn"
            data-fd-id="ai-history-close"
            aria-label={tr("关闭历史", "Close history")}
            title={tr("关闭历史", "Close history")}
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>
        <div
          className="zchat-history-novel"
          role="note"
          aria-label={tr(`当前作品：${novelTitle || "未命名作品"}`, `Current novel: ${novelTitle || "Untitled novel"}`)}
          data-fd-id="ai-history-novel-scope"
        >
          <span>{tr("当前作品", "Current novel")}</span>
          <b className="zchat-ellipsis" title={novelTitle || tr("未命名作品", "Untitled novel")}>
            {novelTitle || tr("未命名作品", "Untitled novel")}
          </b>
        </div>
        <div className="zchat-history-scope" role="group" aria-label={tr("会话范围", "Conversation scope")} data-fd-id="ai-history-scope">
          <button type="button" aria-pressed={!archivedMode} onClick={() => onArchivedModeChange(false)}>
            {tr("会话", "Chats")}
          </button>
          <button type="button" aria-pressed={archivedMode} onClick={() => onArchivedModeChange(true)}>
            {tr("已归档", "Archived")}
          </button>
        </div>
        <div className="zchat-drawer-body">
          {!error && partitioned.pinned.length > 0 && (
            <section className="zchat-drawer-group zchat-pinned-group" data-fd-id="ai-history-pinned">
              <h4>{tr("置顶", "Pinned")}</h4>
              {partitioned.pinned.map(renderConversation)}
            </section>
          )}
          {error && (
            <div className="zchat-drawer-state error" role="alert">
              <span>{tr("历史加载失败", "Could not load history")}</span>
              <small>{error}</small>
              <button type="button" onClick={onRetry} data-fd-id="ai-history-retry">
                <IconRetry />
                {tr("重试", "Retry")}
              </button>
            </div>
          )}
          {!error && loading && !conversations.length && (
            <p className="zchat-drawer-state">{tr("载入中…", "Loading…")}</p>
          )}
          {!error && !loading && !conversations.length && (
            <p className="zchat-drawer-state">
              {archivedMode
                ? tr("没有已归档的对话。", "No archived conversations.")
                : tr("还没有历史对话。发送第一条消息后会出现在这里。", "No conversations yet. Your first message will appear here.")}
            </p>
          )}
          {!error && conversations.length > 0 && !filtered.length && (
            <p className="zchat-drawer-state">
              {tr("没有匹配的对话", "No matching conversations")}
            </p>
          )}
          {!error &&
            groups.map((g) =>
              g.rows.length ? (
                <section className="zchat-drawer-group" key={g.key}>
                  <h4>{g.label}</h4>
                  {g.rows.map(renderConversation)}
                </section>
              ) : null,
            )}
          {!error && hasMore && (
            <button
              type="button"
              className="zchat-load-more"
              disabled={loading}
              data-fd-id="ai-history-more"
              onClick={onLoadMore}
            >
              {loading ? tr("载入中…", "Loading…") : tr("加载更多", "Load more")}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
