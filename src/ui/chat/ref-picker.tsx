import { useEffect, useRef, useState } from "react";
import { AnyRow, fmt, kindNameFor, kinds } from "../shared";
import { IconCheck, IconClose, IconDoc, IconPlus, IconQuote, IconSparkle, IconUser } from "./icons";
import type { MaterialSuggestion } from "../../relevant";
import { materialReferenceContent } from "../../relevant";

/** 引用选择器：浮层，不占常驻高度。 */
export function RefPicker({
  language,
  chapterId,
  chapterTitle,
  currentChapterText,
  summary,
  bookChapters,
  libraryAll,
  suggestions,
  selectedSources,
  currentPayloadChars,
  contextLimitChars,
  contextPreviewReady,
  onAdd,
  onAddMany,
  onClose,
}: {
  language: string;
  chapterId: string | null;
  chapterTitle: string;
  currentChapterText: string;
  summary?: string;
  bookChapters: AnyRow[];
  libraryAll: AnyRow[];
  suggestions: MaterialSuggestion[];
  selectedSources: Array<{ kind: string; sourceId?: string }>;
  currentPayloadChars: number;
  contextLimitChars: number;
  contextPreviewReady: boolean;
  onAdd: (item: { label: string; kind: string; content: string; sourceId: string }) => void;
  onAddMany: (items: Array<{ label: string; kind: string; content: string; sourceId: string }>) => void;
  onClose: () => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [loadingChapter, setLoadingChapter] = useState<string | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(0);
  const [bulkMessage, setBulkMessage] = useState("");
  const isAdded = (kind: string, sourceId?: string) =>
    selectedSources.some((source) => source.kind === kind && source.sourceId === sourceId);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
      if (!focusable.length) {
        e.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKey, true);
      if (previousFocus?.isConnected) {
        window.requestAnimationFrame(() => previousFocus.focus({ preventScroll: true }));
      }
    };
  }, []);

  const others = bookChapters.filter((c) => c.id !== chapterId);
  const unaddedSummaries = bookChapters.filter(
    (chapter) => String(chapter.summary || "").trim() && !isAdded("summary", chapter.id),
  );
  const savedSummaryCount = bookChapters.filter((chapter) => String(chapter.summary || "").trim()).length;
  const remainingChapterCount = bookChapters.filter((chapter) => !isAdded("chapter", chapter.id)).length;
  const remainingContextChars = Math.max(0, contextLimitChars - currentPayloadChars);

  async function addWholeChapters() {
    if (bulkLoading || !contextPreviewReady || remainingContextChars <= 0) return;
    const candidates = bookChapters.filter((chapter) => !isAdded("chapter", chapter.id));
    if (!candidates.length) return;
    setBulkLoading(true);
    setBulkProgress(0);
    setBulkMessage("");
    const references: Array<{ label: string; kind: string; content: string; sourceId: string }> = [];
    let remaining = remainingContextChars;
    let skippedForLimit = 0;
    let failed = 0;
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const chapter = candidates[index];
        setBulkProgress(index + 1);
        let content = "";
        if (chapter.id === chapterId) {
          content = currentChapterText;
        } else {
          try {
            const result = await window.zhuwen.invoke<any>("chapters:get", chapter.id);
            if (!result?.ok) {
              failed += 1;
              continue;
            }
            content = String(result.data?.plain_text || "");
          } catch {
            failed += 1;
            continue;
          }
        }
        if (!content.trim()) continue;
        const label = `${chapter.title} · ${tr("全文", "Full text")}`;
        const estimatedCost = Array.from(content).length + Array.from(label).length + 64;
        if (estimatedCost > remaining) {
          skippedForLimit = candidates.length - index;
          break;
        }
        references.push({ label, kind: "chapter", content, sourceId: chapter.id });
        remaining -= estimatedCost;
      }
      if (references.length) onAddMany(references);
      setBulkMessage(tr(
        `已加入 ${references.length} 章${skippedForLimit ? `；剩余 ${skippedForLimit} 章超出当前额度，未截断` : ""}${failed ? `；${failed} 章读取失败` : ""}`,
        `Added ${references.length} chapters${skippedForLimit ? `; ${skippedForLimit} remaining chapters exceed the current allowance and were not truncated` : ""}${failed ? `; ${failed} chapters could not be loaded` : ""}`,
      ));
    } finally {
      setBulkLoading(false);
    }
  }

  return (
    <>
      <div className="zchat-picker-scrim" onMouseDown={onClose} />
      <div
        className="zchat-picker"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-ref-picker-title"
        data-fd-id="ai-ref-picker"
      >
        <div className="zchat-picker-head">
          <b id="ai-ref-picker-title">{tr("添加引用", "Add reference")}</b>
          <button
            type="button"
            className="zchat-icon-btn"
            ref={closeButtonRef}
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
            <p className="zchat-picker-match-note">{tr("按正文、选区、人物/地点/势力别名、资料关键词片段、标签和所属章节给出候选；关键词仅作本地提示，你点选后才会加入请求。", "Candidates use text, selection, character/place/faction aliases, material keyword fragments, tags, and chapter links. Keyword matches are local hints; nothing is sent until you add it.")}</p>
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
                        {suggestion.matchedSnippet ? (
                          <small className="zchat-suggestion-excerpt">
                            <span>{tr("命中片段 · ", "Matched passage · ")}</span>{suggestion.matchedSnippet}
                          </small>
                        ) : null}
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
          {savedSummaryCount > 0 ? (
            <section data-fd-id="ai-picker-book-outline">
              <h4>
                <IconDoc /> {tr("全书脉络", "Book overview")}
              </h4>
              <p className="zchat-picker-match-note">
                {tr("一次加入各章已保存的摘要；每章仍是独立引用，可单独移除。不会加入章节全文。", "Add saved chapter summaries at once. Each stays a separate reference you can remove; chapter full text is not included.")}
              </p>
              <button
                type="button"
                className="zchat-picker-bulk"
                data-fd-id="ai-picker-all-summaries"
                disabled={!unaddedSummaries.length}
                onClick={() => {
                  for (const chapter of unaddedSummaries) {
                    onAdd({
                      label: `${chapter.title} · ${tr("摘要", "Summary")}`,
                      kind: "summary",
                      content: String(chapter.summary || ""),
                      sourceId: chapter.id,
                    });
                  }
                }}
              >
                <span><IconPlus /> {unaddedSummaries.length
                  ? tr(`添加未引用摘要（${unaddedSummaries.length}）`, `Add remaining summaries (${unaddedSummaries.length})`)
                  : tr("全书摘要已添加", "All summaries added")}</span>
                <small>{tr(`共 ${savedSummaryCount} 章`, `${savedSummaryCount} chapters`)}</small>
              </button>
            </section>
          ) : null}
          {bookChapters.length > 0 ? (
            <section data-fd-id="ai-picker-full-manuscript">
              <h4>
                <IconDoc /> {tr("全书正文", "Full manuscript")}
              </h4>
              <p className="zchat-picker-match-note">
                {tr("按卷章顺序加入完整章节，并遵守当前请求的剩余上下文额度；超出的章节保持完整、不截断。剩余额度还会受对话历史和提示词影响。", "Add complete chapters in book order within the remaining context allowance. Chapters that do not fit stay intact and are skipped; chat history and prompts also use the allowance.")}
              </p>
              <button
                type="button"
                className="zchat-picker-bulk"
                data-fd-id="ai-picker-all-chapters"
                disabled={bulkLoading || !contextPreviewReady || remainingContextChars <= 0 || !remainingChapterCount}
                onClick={() => void addWholeChapters()}
              >
                <span><IconPlus /> {bulkLoading
                  ? tr(`正在读取章节（${bulkProgress}/${remainingChapterCount}）`, `Loading chapters (${bulkProgress}/${remainingChapterCount})`)
                  : !remainingChapterCount
                    ? tr("全书正文已添加", "Full manuscript already added")
                    : !contextPreviewReady
                      ? tr("正在核对当前上下文…", "Checking current context…")
                      : remainingContextChars <= 0
                        ? tr("当前上下文已满", "No context space remaining")
                        : tr(`添加可容纳的完整章节（${remainingChapterCount}）`, `Add complete chapters that fit (${remainingChapterCount})`)}</span>
                <small>{tr(`约余 ${fmt(remainingContextChars)} 字`, `~${fmt(remainingContextChars)} chars left`)}</small>
              </button>
              {bulkMessage ? <p className="zchat-picker-match-note" role="status" data-fd-id="ai-picker-bulk-status">{bulkMessage}</p> : null}
            </section>
          ) : null}
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
                          content: materialReferenceContent(
                            x,
                            6000,
                            Object.fromEntries(bookChapters.map((chapter) => [chapter.id, chapter.title])),
                            Object.fromEntries(bookChapters.map((chapter, index) => [chapter.id, index])),
                            chapterId,
                          ),
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
