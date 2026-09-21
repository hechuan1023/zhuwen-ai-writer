import { useEffect, useRef } from "react";
import { AnyRow } from "../shared";
import { IconClose, IconPlus, IconRetry, IconSearch } from "./icons";
import { filterConversations, groupConversations } from "./chat-model";

/** 历史对话抽屉：浮层覆盖，不挤压消息区；Esc 关闭并归还焦点。 */
export function HistoryDrawer({
  language,
  conversations,
  currentId,
  query,
  loading,
  error,
  hasMore,
  onQuery,
  onNew,
  onSelect,
  onLoadMore,
  onRetry,
  onClose,
}: {
  language: string;
  conversations: AnyRow[];
  currentId: string;
  query: string;
  loading: boolean;
  error?: string | null;
  hasMore: boolean;
  onQuery: (q: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

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
  const groups = groupConversations(filtered).map((g) => ({
    key: g.key,
    label: language === "en" ? g.labelKey.en : g.labelKey.zh,
    rows: g.rows,
  }));

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
        <div className="zchat-drawer-body">
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
              {tr(
                "还没有历史对话。发送第一条消息后会出现在这里。",
                "No conversations yet. Your first message will appear here.",
              )}
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
                  {g.rows.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      className={`zchat-conv-row ${c.id === currentId ? "active" : ""}`}
                      aria-current={c.id === currentId ? "true" : undefined}
                      data-fd-id="ai-history-row"
                      onClick={() => onSelect(c.id)}
                    >
                      <b className="zchat-ellipsis" title={String(c.title || "")}>
                        {c.title || tr("未命名对话", "Untitled")}
                      </b>
                      <small className="zchat-ellipsis">
                        {String(c.last_snippet || "").trim() ||
                          tr("（暂无内容摘要）", "(no summary)")}
                      </small>
                    </button>
                  ))}
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
