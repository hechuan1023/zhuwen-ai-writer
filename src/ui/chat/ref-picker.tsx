import { useEffect, useRef, useState } from "react";
import { AnyRow, fmt, kindNameFor, kinds } from "../shared";
import { IconCheck, IconClose, IconDoc, IconQuote, IconSparkle, IconUser } from "./icons";
import type { MaterialSuggestion } from "../../relevant";
import { materialReferenceContent } from "../../relevant";

/** 引用选择器：浮层，不占常驻高度。 */
export function RefPicker({
  language,
  chapterId,
  chapterTitle,
  summary,
  bookChapters,
  libraryAll,
  suggestions,
  selectedSources,
  onAdd,
  onClose,
}: {
  language: string;
  chapterId: string | null;
  chapterTitle: string;
  summary?: string;
  bookChapters: AnyRow[];
  libraryAll: AnyRow[];
  suggestions: MaterialSuggestion[];
  selectedSources: Array<{ kind: string; sourceId?: string }>;
  onAdd: (item: { label: string; kind: string; content: string; sourceId: string }) => void;
  onClose: () => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const panelRef = useRef<HTMLDivElement>(null);
  const [loadingChapter, setLoadingChapter] = useState<string | null>(null);
  const isAdded = (kind: string, sourceId?: string) =>
    selectedSources.some((source) => source.kind === kind && source.sourceId === sourceId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const others = bookChapters.filter((c) => c.id !== chapterId);

  return (
    <>
      <div className="zchat-picker-scrim" onMouseDown={onClose} />
      <div
        className="zchat-picker"
        ref={panelRef}
        role="dialog"
        aria-label={tr("添加引用", "Add reference")}
        data-fd-id="ai-ref-picker"
      >
        <div className="zchat-picker-head">
          <b>{tr("添加引用", "Add reference")}</b>
          <button
            type="button"
            className="zchat-icon-btn"
            aria-label={tr("关闭", "Close")}
            title={tr("关闭", "Close")}
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>
        <p className="hint zchat-picker-note">
          {tr(
            "只有这里明确添加的内容才会随请求发送。",
            "Only what you add here is sent with the request.",
          )}
        </p>
        <div className="zchat-picker-body">
          <section>
            <h4>
              <IconSparkle /> {tr("本地匹配 · 相关资料", "Local matches · related materials")}
              <small className="zchat-picker-local-only">{tr("不调用 AI", "No AI call")}</small>
            </h4>
            <p className="zchat-picker-match-note">{tr("按正文、选区、人物别名、资料标签和所属章节给出候选；你点选后才会加入请求。", "Candidates use text, selection, aliases, tags, and chapter links. Nothing is sent until you add it.")}</p>
            {suggestions.length ? (
              <div className="zchat-suggestion-list">
                {suggestions.map((suggestion) => {
                  const added = isAdded(suggestion.kind, suggestion.id);
                  return (
                    <button
                      type="button"
                      key={`${suggestion.kind}:${suggestion.id}`}
                      className={`zchat-suggestion-card ${added ? "added" : ""}`}
                      title={suggestion.reasons.join(" · ")}
                      aria-pressed={added}
                      disabled={added}
                      data-fd-id="ai-picker-suggestion"
                      onClick={() => onAdd({
                        label: suggestion.title,
                        kind: suggestion.kind,
                        content: suggestion.content || suggestion.title,
                        sourceId: suggestion.id,
                      })}
                    >
                      <span className="zchat-suggestion-copy">
                        <b className="zchat-ellipsis">{suggestion.title}</b>
                        <small>{suggestion.reasons.join(" · ") || tr(`正文提及「${suggestion.matched}」`, `Matched "${suggestion.matched}"`)}</small>
                      </span>
                      <span className="zchat-suggestion-action">{added ? <><IconCheck />{tr("已添加", "Added")}</> : tr("＋ 添加", "+ Add")}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="zchat-picker-empty">{tr("暂未匹配到资料；你仍可从下方手动选择。", "No matches yet. You can still choose materials below.")}</div>
            )}
          </section>
          <section>
            <h4>
              <IconQuote /> {tr("当前章节", "Current chapter")}
            </h4>
            <div className="zchat-picker-grid">
              <button
                type="button"
                data-fd-id="ai-picker-selection"
                aria-pressed={isAdded("selection", chapterId || "")}
                onClick={() => onAdd({ label: "", kind: "__selection__", content: "", sourceId: "" })}
              >
                {isAdded("selection", chapterId || "") ? tr("已添加 · 选中文字", "Added · selection") : tr("选中文字", "Selection")}
              </button>
              <button
                type="button"
                data-fd-id="ai-picker-chapter"
                aria-pressed={isAdded("chapter", chapterId || "")}
                onClick={() => onAdd({ label: "", kind: "__chapter__", content: "", sourceId: "" })}
              >
                {isAdded("chapter", chapterId || "") ? tr("已添加 · 当前章节全文", "Added · whole chapter") : tr("当前章节全文", "Whole chapter")}
              </button>
              {summary ? (
                <button
                  type="button"
                  data-fd-id="ai-picker-summary"
                  aria-pressed={isAdded("summary", chapterId || "")}
                  onClick={() => onAdd({ label: "", kind: "__summary__", content: "", sourceId: "" })}
                >
                  {isAdded("summary", chapterId || "") ? tr("已添加 · 本章摘要", "Added · chapter summary") : tr("本章摘要", "Chapter summary")}
                </button>
              ) : null}
            </div>
          </section>
          <section>
            <h4>
              <IconDoc /> {tr("其他章节", "Other chapters")}
            </h4>
            {others.length ? (
              <div className="zchat-picker-list">
                {others.map((c) => (
                  <span className="zchat-picker-row" key={c.id}>
                    <button
                      type="button"
                      data-fd-id="ai-picker-other-chapter"
                      disabled={loadingChapter === c.id || isAdded("chapter", c.id)}
                      aria-pressed={isAdded("chapter", c.id)}
                      title={tr("引用该章正文（点击后读取）", "Reference this chapter (loaded on click)")}
                      onClick={async () => {
                        setLoadingChapter(c.id);
                        try {
                          const r = await window.zhuwen.invoke<any>("chapters:get", c.id);
                          const text = r?.ok ? r.data?.plain_text || "" : "";
                          onAdd({
                            label: c.title,
                            kind: "chapter",
                            content: text,
                            sourceId: c.id,
                          });
                        } finally {
                          setLoadingChapter(null);
                        }
                      }}
                    >
                      <span className="zchat-ellipsis">{c.title}</span>
                      <small>{isAdded("chapter", c.id) ? tr("已添加", "Added") : `${fmt(c.word_count)} ${tr("字", "chars")}`}</small>
                    </button>
                    {c.summary ? (
                      <button
                        type="button"
                        data-fd-id="ai-picker-other-summary"
                        aria-pressed={isAdded("summary", c.id)}
                        disabled={isAdded("summary", c.id)}
                        title={tr("引用该章摘要", "Reference its summary")}
                        onClick={() =>
                          onAdd({
                            label: `${c.title} · ${tr("摘要", "Summary")}`,
                            kind: "summary",
                            content: c.summary,
                            sourceId: c.id,
                          })
                        }
                      >
                        {tr("摘要", "Summary")}
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : (
              <p className="hint">{tr("暂无其他章节", "No other chapters")}</p>
            )}
          </section>
          {kinds.map(([k, label]) => {
            const items = libraryAll.filter((x) => x.kind === k);
            if (!items.length) return null;
            return (
              <section key={k}>
                <h4>
                  <IconUser /> {kindNameFor(k, language as never) || label}
                </h4>
                <div className="zchat-picker-grid">
                  {items.map((x) => (
                    <button
                      type="button"
                      key={x.id}
                      className={isAdded(k, x.id) ? "zchat-picker-item-added" : ""}
                      disabled={isAdded(k, x.id)}
                      aria-pressed={isAdded(k, x.id)}
                      data-fd-id="ai-picker-library"
                      title={x.title}
                      onClick={() => {
                        onAdd({
                          label: x.title,
                          kind: k,
                          content: materialReferenceContent(x),
                          sourceId: x.id,
                        });
                      }}
                    >
                      <span className="zchat-ellipsis">{x.title}</span>
                      {isAdded(k, x.id) && <small>{tr("已添加", "Added")}</small>}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
