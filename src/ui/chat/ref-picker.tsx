import { useEffect, useRef, useState } from "react";
import { AnyRow, fmt, kindNameFor, kinds } from "../shared";
import { IconClose, IconDoc, IconQuote, IconSparkle, IconUser } from "./icons";
import type { MaterialSuggestion } from "../../relevant";

/** 引用选择器：浮层，不占常驻高度。 */
export function RefPicker({
  language,
  chapterId,
  chapterTitle,
  summary,
  bookChapters,
  libraryAll,
  suggestions,
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
  onAdd: (item: { label: string; kind: string; content: string; sourceId: string }) => void;
  onClose: () => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const panelRef = useRef<HTMLDivElement>(null);
  const [loadingChapter, setLoadingChapter] = useState<string | null>(null);

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
          {suggestions.length > 0 && (
            <section>
              <h4>
                <IconSparkle /> {tr("智能推荐 · 与本章相关", "Suggested · related to this chapter")}
              </h4>
              <div className="zchat-picker-grid">
                {suggestions.map((s) => (
                  <button
                    type="button"
                    key={`${s.kind}:${s.id}`}
                    title={tr(`正文提及「${s.matched}」${s.count} 次`, `Mentioned "${s.matched}" ${s.count}×`)}
                    data-fd-id="ai-picker-suggestion"
                    onClick={() =>
                      onAdd({
                        label: s.title,
                        kind: s.kind,
                        content: s.content || s.title,
                        sourceId: s.id,
                      })
                    }
                  >
                    <span className="zchat-ellipsis">{s.title}</span>
                    <small>{s.count}×</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section>
            <h4>
              <IconQuote /> {tr("当前章节", "Current chapter")}
            </h4>
            <div className="zchat-picker-grid">
              <button
                type="button"
                data-fd-id="ai-picker-selection"
                onClick={() => onAdd({ label: "", kind: "__selection__", content: "", sourceId: "" })}
              >
                {tr("选中文字", "Selection")}
              </button>
              <button
                type="button"
                data-fd-id="ai-picker-chapter"
                onClick={() => onAdd({ label: "", kind: "__chapter__", content: "", sourceId: "" })}
              >
                {tr("当前章节全文", "Whole chapter")}
              </button>
              {summary ? (
                <button
                  type="button"
                  data-fd-id="ai-picker-summary"
                  onClick={() => onAdd({ label: "", kind: "__summary__", content: "", sourceId: "" })}
                >
                  {tr("本章摘要", "Chapter summary")}
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
                      disabled={loadingChapter === c.id}
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
                      <small>{fmt(c.word_count)} {tr("字", "chars")}</small>
                    </button>
                    {c.summary ? (
                      <button
                        type="button"
                        data-fd-id="ai-picker-other-summary"
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
                      data-fd-id="ai-picker-library"
                      title={x.title}
                      onClick={() => {
                        let body = "";
                        try {
                          body = String(JSON.parse(x.content_json || "{}").body || "");
                        } catch {
                          body = "";
                        }
                        onAdd({
                          label: x.title,
                          kind: k,
                          content: body,
                          sourceId: x.id,
                        });
                      }}
                    >
                      <span className="zchat-ellipsis">{x.title}</span>
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
