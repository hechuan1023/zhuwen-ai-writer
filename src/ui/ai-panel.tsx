import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { joinSegments, splitSegments } from "../segments";
import { relevantMaterials } from "../relevant";
import { api, useAiSessionStore, fmt, time, kindNameFor, promptNameFor, kinds, parseJson, Empty, Modal, DiffModal, ConfirmDialog, PromptDialog, AnyRow, UiLanguage } from "./shared";
import { Select } from "./select";

export function MdView({ text }: { text: string }) {
  const html = useMemo(
    () =>
      sanitizeHtml(
        marked.parse(text || "", { async: false, breaks: true }) as string,
        {
          allowedTags: sanitizeHtml.defaults.allowedTags.filter(
            (t) => t !== "img",
          ),
          allowedAttributes: sanitizeHtml.defaults.allowedAttributes,
        },
      ),
    [text],
  );
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function AiPanel({
  novel,
  chapter,
  editor,
  save,
  notify,
  float,
  onOpenSettings,
  language = "zh-CN",
}: {
  novel: AnyRow;
  chapter: AnyRow | null;
  editor?: any;
  save?: (x?: boolean) => Promise<boolean>;
  notify: (s: string) => void;
  float?: boolean;
  onOpenSettings?: () => void;
  language?: UiLanguage;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [session, patch] = useAiSessionStore();
  const [connections, setConnections] = useState<AnyRow[]>([]),
    [prompts, setPrompts] = useState<AnyRow[]>([]),
    [conversations, setConversations] = useState<AnyRow[]>([]),
    [libraryAll, setLibraryAll] = useState<AnyRow[]>([]),
    [bookChapters, setBookChapters] = useState<AnyRow[]>([]),
    [pickerOpen, setPickerOpen] = useState(false),
    [compare, setCompare] = useState<{ msg: AnyRow; original: string } | null>(
      null,
    ),
    [segments, setSegments] = useState<{ msg: AnyRow } | null>(null);
  const autoSelected = useRef("");
  const [mode, setMode] = useState<"chat" | "continue">("chat");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [previewMessages, setPreviewMessages] = useState<AnyRow[]>([]);
  const [continuationId, setContinuationId] = useState<string | null>(null);
  const prevGenerating = useRef(false);
  const pendingContinue = useRef(false);
  const novelId: string = session?.novelId || novel?.id || "";
  const chapterId: string | null = session?.chapter?.id || chapter?.id || null;
  const chapterTitle = session?.chapter?.title || chapter?.title || "";
  const connection: string = session?.connectionId || "";
  const conversation: string = session?.conversationId || "";
  const text: string = session?.text || "";
  const [draft, setDraft] = useState(text);
  const draftRef = useRef(text);
  const lastSyncedText = useRef(text);
  const draftTimer = useRef<number | undefined>(undefined);
  const draftVersionRef = useRef(0);
  const draftConvRef = useRef(conversation);
  useEffect(() => {
    // 会话切换：取消待提交任务，以服务端草稿为准
    if (draftConvRef.current !== conversation) {
      window.clearTimeout(draftTimer.current);
      draftConvRef.current = conversation;
      draftVersionRef.current = 0;
    }
  }, [conversation]);
  useEffect(() => {
    if (text === lastSyncedText.current) return;
    lastSyncedText.current = text;
    draftRef.current = text;
    setDraft(text);
  }, [text]);
  useEffect(() => () => window.clearTimeout(draftTimer.current), []);
  function patchDraft(value: string, convId: string, version: number) {
    void patch({
      text: value,
      novelId,
      conversationId: convId,
      draftVersion: version,
    });
  }
  function updateDraft(value: string, flush = false) {
    draftRef.current = value;
    setDraft(value);
    window.clearTimeout(draftTimer.current);
    const convId = conversation;
    const version = ++draftVersionRef.current;
    if (flush) {
      lastSyncedText.current = value;
      patchDraft(value, convId, version);
      return;
    }
    draftTimer.current = window.setTimeout(() => {
      // 过期任务：会话已切换则丢弃
      if (draftConvRef.current !== convId) return;
      lastSyncedText.current = value;
      patchDraft(value, convId, version);
    }, 400);
  }
  function flushDraft() {
    window.clearTimeout(draftTimer.current);
    const value = draftRef.current;
    lastSyncedText.current = value;
    const version = ++draftVersionRef.current;
    patchDraft(value, conversation, version);
    return value;
  }
  const contexts: AnyRow[] = session?.contexts || [];
  const messages: AnyRow[] = session?.messages || [];
  const generating: boolean = Boolean(session?.generating);
  const requestId: string = session?.requestId || "";
  const selectionText: string = session?.selectionText || "";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const HISTORY_PAGE = 50;
  const historySeq = useRef(0);
  const loadConversations = useCallback(
    (opts?: { offset?: number; search?: string; append?: boolean }) => {
      if (!novelId) return;
      const offset = opts?.offset || 0;
      const search = opts?.search ?? historyQuery;
      const seq = ++historySeq.current;
      setHistoryLoading(true);
      api("ai:conversations", {
        novelId,
        limit: HISTORY_PAGE,
        offset,
        search,
      }).then((r) => {
        if (seq !== historySeq.current) return;
        setHistoryLoading(false);
        if (!r.ok) return;
        const rows = r.data?.rows || [];
        setHistoryHasMore(Boolean(r.data?.hasMore));
        setConversations((prev) => {
          if (!opts?.append) return rows;
          const seen = new Set(prev.map((c) => c.id));
          return [...prev, ...rows.filter((c: AnyRow) => !seen.has(c.id))];
        });
      });
    },
    [novelId, historyQuery],
  );
  useEffect(() => {
    if (!novelId) return;
    loadConversations();
    api("connections:list").then((r) => r.ok && setConnections(r.data));
    api("prompts:list").then((r) => r.ok && setPrompts(r.data));
    api("novels:open", novelId).then(
      (r) => r.ok && setBookChapters(r.data.chapters),
    );
    api("library:listAll", novelId).then((r) => r.ok && setLibraryAll(r.data));
  }, [novelId]);
  useEffect(() => {
    const off = window.zhuwen.onAiConversations((payload) => {
      const rows = Array.isArray(payload) ? payload : payload?.rows;
      const scope = Array.isArray(payload) ? null : payload?.novelId;
      if (scope && novelId && scope !== novelId) return;
      // 搜索中或多页浏览时：按当前条件刷新，不直接覆盖成未筛选列表
      if (historyQuery.trim() || conversations.length > HISTORY_PAGE) {
        loadConversations({ offset: 0, search: historyQuery });
        return;
      }
      if (Array.isArray(rows)) setConversations(rows);
    });
    return off;
  }, [novelId, historyQuery, conversations.length, loadConversations]);
  useEffect(() => {
    if (!session) return;
    if (autoSelected.current === novelId) return;
    if (session.conversationId) {
      autoSelected.current = novelId;
      return;
    }
    if (conversations.length) {
      autoSelected.current = novelId;
      api("ai:session:loadConversation", conversations[0].id);
    }
  }, [session, conversations, novelId]);
  useEffect(() => {
    if (connections.length && !connection)
      patch({ connectionId: connections[0].id });
  }, [connections, connection, patch]);
  useEffect(() => {
    if (prevGenerating.current && !generating && pendingContinue.current) {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && last.id) setContinuationId(last.id);
      pendingContinue.current = false;
    }
    prevGenerating.current = generating;
  }, [generating, messages]);
  function chapterText() {
    return (
      (editor ? editor.getText({ blockSeparator: "\n" }) : "") ||
      session?.chapter?.plain_text ||
      chapter?.plain_text ||
      ""
    );
  }
  const suggestions = useMemo(
    () =>
      relevantMaterials(
        libraryAll,
        `${chapterText()}${selectionText ? `\n${selectionText}` : ""}`,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [libraryAll, pickerOpen, selectionText, session?.chapter?.plain_text],
  );
  function continuationContext() {
    const tail = chapterText().trim().slice(-4000);
    return {
      label: `${chapterTitle || tr("当前章节", "Current chapter")} · ${tr("续写上文", "Continuation context")}`,
      kind: "continuation",
      content: tail,
      sourceId: chapterId || "",
    };
  }
  function setContexts(updater: (xs: AnyRow[]) => AnyRow[]) {
    patch({ contexts: updater(contexts) });
  }
  function selectConversation(id: string) {
    api("ai:session:loadConversation", id);
  }
  function renameConversation() {
    if (!conversation) return;
    setRenameOpen(true);
  }
  function deleteConversation() {
    if (!conversation) return;
    setDeleteOpen(true);
  }
  function addSelection() {
    let selected = "";
    if (editor)
      selected = editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
        "\n",
      );
    if (!selected) selected = selectionText;
    if (!selected) return notify(tr("请先在正文中选择文字", "Select text in the manuscript first"));
    setContexts((xs) => [
      ...xs.filter((x) => x.kind !== "selection"),
      {
        label: `${chapterTitle || tr("选段", "Excerpt")} · ${tr("选中文字", "Selection")}`,
        kind: "selection",
        content: selected,
        sourceId: chapterId || "",
      },
    ]);
  }
  function addChapter() {
    if (!chapterId) return;
    const content =
      (editor ? editor.getText({ blockSeparator: "\n" }) : "") ||
      session?.chapter?.plain_text ||
      chapter?.plain_text ||
      "";
    setContexts((xs) => [
      ...xs.filter((x) => x.kind !== "chapter"),
      {
        label: chapterTitle || tr("当前章节", "Current chapter"),
        kind: "chapter",
        content,
        sourceId: chapterId,
      },
    ]);
  }
  function addSummary() {
    if (!chapterId || !chapter?.summary) return;
    setContexts((xs) => [
      ...xs.filter((x) => !(x.kind === "summary" && x.sourceId === chapterId)),
      {
        label: `${chapterTitle || tr("当前章节", "Current chapter")} · ${tr("摘要", "Summary")}`,
        kind: "summary",
        content: chapter.summary,
        sourceId: chapterId,
      },
    ]);
  }
  function addContext(item: {
    label: string;
    kind: string;
    content: string;
    sourceId: string;
  }) {
    setContexts((xs) =>
      xs.some((x) => x.kind === item.kind && x.sourceId === item.sourceId)
        ? xs
        : [...xs, item],
    );
  }
  const TEMPLATE_VARS =
    /(当前章节|选中文字|人物设定|世界设定|章节摘要|书名|简介|日期)/;
  function resolveTemplateVars(
    base: AnyRow[],
    input: string,
  ): { prompt: string; contexts: AnyRow[] } {
    const names = Array.from(
      new Set(
        Array.from(
          input.matchAll(
            new RegExp(`\\{(${TEMPLATE_VARS.source})\\}`, "g"),
          ),
        ).map((m) => m[1]),
      ),
    );
    if (!names.length) return { prompt: input, contexts: base };
    const extra: AnyRow[] = [];
    const seen = new Set(base.map((x) => `${x.kind}:${x.sourceId || ""}`));
    const addCtx = (
      kind: string,
      label: string,
      content: string,
      sourceId: string,
    ) => {
      if (!content) return;
      const key = `${kind}:${sourceId || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      extra.push({ label, kind, content, sourceId });
    };
    for (const name of names) {
      if (name === "当前章节") {
        addCtx(
          "chapter",
          chapterTitle || tr("当前章节", "Current chapter"),
          chapterText().trim().slice(0, 8000),
          chapterId || "",
        );
      } else if (name === "选中文字") {
        addCtx(
          "selection",
          `${chapterTitle || tr("选段", "Excerpt")} · ${tr("选中文字", "Selection")}`,
          selectionText,
          chapterId || "",
        );
      } else if (name === "人物设定") {
        const body = libraryAll
          .filter((x) => x.kind === "character")
          .map((x) => {
            const c = parseJson(x.content_json);
            return `【${x.title}】${c.body || ""}${
              c.alias ? `（${tr("别名", "Aliases")}：${c.alias}）` : ""
            }`;
          })
          .join("\n\n")
          .slice(0, 6000);
        addCtx("character", tr("全部人物卡", "All character cards"), body, "chars-all");
      } else if (name === "世界设定") {
        const body = libraryAll
          .filter((x) => x.kind === "world")
          .map((x) => {
            const c = parseJson(x.content_json);
            return `【${x.title}${c.category ? ` · ${c.category}` : ""}】${
              c.body || ""
            }`;
          })
          .join("\n\n")
          .slice(0, 6000);
        addCtx("world", tr("全部世界设定", "All world settings"), body, "world-all");
      } else if (name === "章节摘要") {
        addCtx(
          "summary",
          `${chapterTitle || tr("当前章节", "Current chapter")} · ${tr("摘要", "Summary")}`,
          chapter?.summary || session?.chapter?.summary || "",
          chapterId || "",
        );
      } else if (name === "书名") {
        addCtx("novel", tr("作品名", "Title"), novel.title || "", "novel-title");
      } else if (name === "简介") {
        addCtx("novel", tr("作品简介", "Synopsis"), novel.synopsis || "", "novel-synopsis");
      } else if (name === "日期") {
        addCtx(
          "meta",
          tr("今日日期", "Today"),
          new Date().toLocaleDateString("zh-CN"),
          "today",
        );
      }
    }
    const cleaned = input
      .replace(
        new RegExp(`\\s*\\{(${TEMPLATE_VARS.source})\\}`, "g"),
        "",
      )
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    return { prompt: cleaned, contexts: [...base, ...extra] };
  }
  function buildSendPlan():
    | { contexts: AnyRow[]; prompt: string; ask: string }
    | null {
    const ask = draftRef.current.trim();
    if (mode === "continue") {
      const cont = continuationContext();
      if (!cont.content) return null;
      const resolved = resolveTemplateVars(
        contexts.filter((x) => x.kind !== "continuation"),
        ask,
      );
      return {
        contexts: [...resolved.contexts, cont],
        prompt: `请紧接引用的「续写上文」继续写作，与上文无缝衔接，保持人称、时态、文风和视角一致。只输出续写的正文本身，不要重复或复述原文，不要解释，不要加标题。${
          resolved.prompt ? `\n\n写作要求：${resolved.prompt}` : ""
        }`,
        ask,
      };
    }
    const resolved = resolveTemplateVars(contexts, ask);
    return { contexts: resolved.contexts, prompt: resolved.prompt, ask };
  }
  async function openSendPreview() {
    flushDraft();
    const plan = buildSendPlan();
    if (!plan) return notify(tr("当前章节还没有正文，无法预览续写请求", "The current chapter is empty, so there is no continuation request to preview"));
    const result = await api<AnyRow[]>("ai:previewRequest", {
      conversationId: conversation,
      contexts: plan.contexts,
      prompt: plan.prompt,
    });
    if (!result.ok) return notify(result.error || tr("无法生成发送预览", "Could not build the request preview"));
    setPreviewMessages(result.data);
    setPreviewOpen(true);
  }
  async function send() {
    if (!connection || !chapterId || generating) return;
    flushDraft();
    const continuing = mode === "continue";
    const plan = buildSendPlan();
    if (!plan) return notify(tr("当前章节还没有正文，无法续写", "The current chapter is empty and cannot be continued"));
    if (!continuing && !plan.ask) return;
    if (!float && save && !(await save(true))) return;
    const id = crypto.randomUUID();
    patch({ contexts: plan.contexts });
    if (continuing) {
      pendingContinue.current = true;
    }
    const r = await api("ai:send", {
      requestId: id,
      conversationId: conversation || undefined,
      novelId,
      chapterId,
      sourceRevision: session?.chapter?.revision ?? chapter?.revision,
      selectionText:
        plan.contexts.find((x) => x.kind === "selection")?.content || "",
      connectionId: connection,
      prompt: plan.prompt,
      contexts: plan.contexts,
    });
    if (!r.ok) {
      pendingContinue.current = false;
      patch({ text: plan.ask });
      notify(r.error || tr("发送失败，内容已放回输入框，可修改后重试", "Sending failed. Your text was restored to the composer for retrying"));
    } else loadConversations();
  }
  async function apply(
    mode: "insert" | "replace",
    content: string,
    sourceRevision?: number,
  ) {
    if (!editor || !chapter || !content) return;
    const selected = contexts.find((x) => x.kind === "selection")?.content;
    if (
      mode === "replace" &&
      (!selected ||
        (chapter.revision !== sourceRevision && sourceRevision != null))
    )
      return notify(tr("正文已发生变化，请重新选择原文后再替换", "The manuscript changed. Select the original text again before replacing it"));
    if (save && !(await save(true)))
      return notify(tr("正文尚未保存，已取消写入 AI 内容", "The manuscript could not be saved, so the AI text was not inserted"));
    const snapshot = await api("revisions:create", {
      chapterId: chapter.id,
      source: "before_ai_apply",
    });
    if (!snapshot.ok)
      return notify(snapshot.error || tr("无法创建历史快照，已取消写入", "A history snapshot could not be created, so insertion was cancelled"));
    if (editor?.storage?.zhuwen?.markProgrammatic)
      editor.storage.zhuwen.markProgrammatic();
    if (mode === "insert") editor.commands.insertContent(content);
    else {
      const { from, to } = editor.state.selection;
      const current = editor.state.doc.textBetween(from, to, "\n");
      if (current !== selected)
        return notify(tr("当前选区与原文不一致，未执行替换", "The current selection no longer matches the original, so nothing was replaced"));
      if (editor?.storage?.zhuwen?.markProgrammatic)
        editor.storage.zhuwen.markProgrammatic();
      editor
        .chain()
        .focus()
        .deleteRange({ from, to })
        .insertContent(content)
        .run();
    }
    notify(tr("已写入正文，可使用 Ctrl+Z 撤销", "Inserted into the manuscript. Use Ctrl+Z to undo"));
  }
  async function applyEnd(content: string) {
    if (!editor || !chapter || !content) return;
    if (save && !(await save(true)))
      return notify(tr("正文尚未保存，已取消追加 AI 内容", "The manuscript could not be saved, so the AI text was not appended"));
    const snapshot = await api("revisions:create", {
      chapterId: chapter.id,
      source: "before_ai_apply",
    });
    if (!snapshot.ok)
      return notify(snapshot.error || tr("无法创建历史快照，已取消追加", "A history snapshot could not be created, so appending was cancelled"));
    const paras = content
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({
        type: "paragraph",
        content: [{ type: "text", text: s }],
      }));
    editor.commands.focus("end");
    if (editor?.storage?.zhuwen?.markProgrammatic)
      editor.storage.zhuwen.markProgrammatic();
    editor.commands.insertContent(paras);
    editor.commands.scrollIntoView();
    notify(tr("续写已追加到章末，可使用 Ctrl+Z 撤销", "Continuation appended to the chapter. Use Ctrl+Z to undo"));
  }
  const contextChars = contexts.reduce((n, x) => n + String(x.content || "").length, 0);
  const historyChars = messages.reduce(
    (n, m) => n + String(m?.content || "").length,
    0,
  );
  const draftChars = draftRef.current.length;
  const estimate = Math.ceil((contextChars + historyChars + draftChars) / 2);
  const contextOnlyEstimate = Math.ceil(contextChars / 2);
  return (
    <>
      <div className="panel-head">
        <strong>{float ? tr("AI 助手 · 浮窗", "AI Assistant · Floating") : tr("AI 写作助手", "AI Writing Assistant")}</strong>
        <Select
          size="compact"
          value={connection}
          aria-label={tr("选择连接", "Select connection")}
          placeholder={tr("选择连接", "Select connection")}
          searchable={connections.length > 8}
          onValueChange={(v) => patch({ connectionId: v })}
          options={[
            { value: "", label: tr("选择连接", "Select connection") },
            ...connections.map((c) => ({
              value: c.id as string,
              label: `${c.name} · ${c.model}`,
            })),
          ]}
        />
        {float ? (
          <button title={tr("收起浮窗", "Close floating window")} onClick={() => api("ai:float:close")}>
            {tr("收起", "Close")}
          </button>
        ) : (
          <button
            title={tr("在独立窗口打开，便于放到第二块显示器", "Open in a separate window for a second display")}
            onClick={() => api("ai:float:open")}
          >
            {tr("浮窗", "Float")}
          </button>
        )}
      </div>
      {!connections.length && (
        <div className="ai-empty-conn">
          <p>{tr("尚未配置 AI 连接", "No AI connection configured")}</p>
          <small className="hint">
            {tr("在设置中添加 OpenAI 兼容接口后即可开始使用。", "Add an OpenAI-compatible endpoint in Settings to get started.")}
          </small>
          {!float && onOpenSettings && (
            <button className="primary" onClick={onOpenSettings}>
              {tr("去配置 AI 连接", "Configure AI connection")}
            </button>
          )}
        </div>
      )}
      <div className="conversation-bar">
        <button
          type="button"
          className="conv-current"
          title={tr("打开历史会话", "Open conversation history")}
          onClick={() => {
            loadConversations();
            setHistoryOpen((v) => !v);
          }}
        >
          <span className="ellipsis">
            {conversations.find((c) => c.id === conversation)?.title ||
              tr("新会话", "New conversation")}
          </span>
          <span className="hint">{tr("历史", "History")}</span>
        </button>
        <button title={tr("新建会话", "New conversation")} onClick={() => selectConversation("")}>
          ＋
        </button>
        <button
          title={tr("重命名会话", "Rename conversation")}
          disabled={!conversation}
          onClick={renameConversation}
        >
          {tr("改名", "Rename")}
        </button>
        <button
          title={tr("删除会话", "Delete conversation")}
          className="danger-text"
          disabled={!conversation}
          onClick={deleteConversation}
        >
          {tr("删除", "Delete")}
        </button>
      </div>
      {generating && (
        <small className="hint" style={{ padding: "0 10px" }}>
          {tr(
            `正在生成：${conversations.find((c) => c.id === (session?.generatingConversationId || conversation))?.title || "当前会话"}`,
            `Generating in: ${conversations.find((c) => c.id === (session?.generatingConversationId || conversation))?.title || "current"}`,
          )}
        </small>
      )}
      {historyOpen && (
        <div className="history-drawer" data-fd-id="ai-history-drawer">
          <div className="history-drawer-head">
            <input
              placeholder={tr("搜索全部历史会话", "Search all conversations")}
              value={historyQuery}
              onChange={(e) => {
                setHistoryQuery(e.target.value);
                loadConversations({ search: e.target.value, offset: 0 });
              }}
              autoFocus
            />
            <button onClick={() => selectConversation("")}>
              {tr("新建对话", "New chat")}
            </button>
            <button onClick={() => setHistoryOpen(false)} aria-label={tr("关闭历史", "Close history")}>
              ×
            </button>
          </div>
          {historyLoading && !conversations.length && (
            <p className="hint" style={{ padding: 12 }}>{tr("载入中…", "Loading…")}</p>
          )}
          {(() => {
            const q = historyQuery.trim().toLowerCase();
            const filtered = conversations.filter((c) =>
              !q ||
              String(c.title || "").toLowerCase().includes(q) ||
              String(c.last_snippet || "").toLowerCase().includes(q),
            );
            if (!conversations.length)
              return (
                <p className="hint" style={{ padding: 12 }}>
                  {tr("还没有历史会话。发送第一条消息后会出现在这里。", "No conversations yet. The first send will appear here.")}
                </p>
              );
            if (!filtered.length)
              return (
                <p className="hint" style={{ padding: 12 }}>
                  {tr("没有匹配的会话", "No matching conversations")}
                </p>
              );
            const groups: Record<string, AnyRow[]> = {
              today: [],
              yesterday: [],
              earlier: [],
            };
            const now = new Date();
            const y0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const y1 = new Date(y0);
            y1.setDate(y1.getDate() - 1);
            for (const c of filtered) {
              const t = new Date(c.updated_at);
              if (t >= y0) groups.today.push(c);
              else if (t >= y1) groups.yesterday.push(c);
              else groups.earlier.push(c);
            }
            const renderGroup = (label: string, rows: AnyRow[]) =>
              rows.length ? (
                <div key={label} className="history-group">
                  <div className="history-group-label">{label}</div>
                  {rows.map((c) => (
                    <div
                      key={c.id}
                      className={`history-item ${c.id === conversation ? "current" : ""}`}
                      role="button"
                      tabIndex={0}
                      title={c.title}
                      onClick={() => {
                        selectConversation(c.id);
                        setHistoryOpen(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectConversation(c.id);
                          setHistoryOpen(false);
                        }
                      }}
                    >
                      <b className="ellipsis">{c.title || tr("未命名会话", "Untitled")}</b>
                      <small className="ellipsis">
                        {c.last_incomplete
                          ? tr("未完整回答 · ", "Incomplete · ")
                          : ""}
                        {c.last_snippet || tr("（无消息）", "(no messages)")}
                      </small>
                      <small className="hint">
                        {time(c.updated_at, language)}
                        {session?.generatingConversationId === c.id
                          ? ` · ${tr("生成中", "Generating")}`
                          : ""}
                      </small>
                    </div>
                  ))}
                </div>
              ) : null;
            return (
              <>
                {renderGroup(tr("今天", "Today"), groups.today)}
                {renderGroup(tr("昨天", "Yesterday"), groups.yesterday)}
                {renderGroup(tr("更早", "Earlier"), groups.earlier)}
                {historyHasMore && (
                  <div style={{ padding: 10, textAlign: "center" }}>
                    <button
                      type="button"
                      disabled={historyLoading}
                      onClick={() =>
                        loadConversations({
                          offset: conversations.length,
                          append: true,
                          search: historyQuery,
                        })
                      }
                    >
                      {historyLoading
                        ? tr("载入中…", "Loading…")
                        : tr("加载更多", "Load more")}
                    </button>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
      <details className="context-box">
        <summary>
          <span>
            <b>{tr("引用资料", "References")}</b>
            <em>{contexts.length ? tr(`已选 ${contexts.length} 项 · ${fmt(contextChars)} 字`, `${contexts.length} selected · ${fmt(contextChars)} chars`) : tr("默认不发送正文", "Manuscript not sent by default")}</em>
          </span>
          <small
            title={tr(
              `引用约 ${fmt(contextOnlyEstimate)} + 历史约 ${fmt(Math.ceil(historyChars / 2))} + 输入约 ${fmt(Math.ceil(draftChars / 2))} tokens（估算）`,
              `Refs ~${fmt(contextOnlyEstimate)} + history ~${fmt(Math.ceil(historyChars / 2))} + input ~${fmt(Math.ceil(draftChars / 2))} tokens (estimate)`,
            )}
          >
            {tr("上下文约", "Context ~")} {fmt(estimate)} tokens
          </small>
        </summary>
        <div className="context-content">
        <div className="context-actions">
          <button onClick={addSelection}>＋ {tr("选中文字", "Selection")}</button>
          <button onClick={addChapter}>＋ {tr("当前章节", "Current chapter")}</button>
          {chapter?.summary && (
            <button onClick={addSummary}>＋ {tr("本章摘要", "Chapter summary")}</button>
          )}
          <button onClick={() => setPickerOpen((x) => !x)}>
            {pickerOpen ? tr("收起资料", "Hide references") : tr("＋ 引用资料", "+ Add reference")}
          </button>
          <button
            title={tr("查看本次请求实际会发送的内容", "View the exact content that will be sent")}
            onClick={openSendPreview}
          >
            {tr("预览发送", "Preview request")}
          </button>
        </div>
        {pickerOpen && (
          <div className="context-picker">
            <div className="picker-group">
              <b>{tr("智能推荐 · 与本章相关", "Suggested · Relevant to this chapter")}</b>
              <div className="picker-items">
                {suggestions.map((s) => (
                  <button
                    key={`${s.kind}:${s.id}`}
                    title={tr(`正文提及「${s.matched}」${s.count} 次`, `Mentioned ${s.count} times as “${s.matched}”`)}
                    onClick={() =>
                      addContext({
                        label: s.title,
                        kind: s.kind,
                        content: s.content || s.title,
                        sourceId: s.id,
                      })
                    }
                  >
                    {s.title}
                    <small>{s.count} 次</small>
                  </button>
                ))}
                {!suggestions.length && (
                  <small>{tr("未在正文中发现资料关键词，可从下方手动选择。", "No story-bible keywords were found; choose a reference below.")}</small>
                )}
              </div>
            </div>
            <div className="picker-group">
              <b>{tr("其他章节", "Other chapters")}</b>
              <div className="picker-items">
                {bookChapters
                  .filter((c) => c.id !== chapter?.id)
                  .map((c) => (
                    <span className="picker-row" key={c.id}>
                      <button
                        title={tr("引用该章正文（点击后按需读取）", "Reference this chapter (loaded on demand)")}
                        onClick={async () => {
                          const r = await api<any>("chapters:get", c.id);
                          if (r.ok)
                            addContext({
                              label: c.title,
                              kind: "chapter",
                              content: r.data?.plain_text || "",
                              sourceId: c.id,
                            });
                          else notify(r.error || tr("读取章节失败", "Could not load chapter"));
                        }}
                      >
                        {c.title}
                        <small>{fmt(c.word_count)} {tr("字", "words")}</small>
                      </button>
                      {c.summary && (
                        <button
                          title={tr("引用该章摘要", "Reference this chapter summary")}
                          onClick={() =>
                            addContext({
                              label: `${c.title} · 摘要`,
                              kind: "summary",
                              content: c.summary,
                              sourceId: c.id,
                            })
                          }
                        >
                          {tr("摘要", "Summary")}
                        </button>
                      )}
                    </span>
                  ))}
                {bookChapters.filter((c) => c.id !== chapter?.id).length ===
                  0 && <small>{tr("暂无其他章节", "No other chapters")}</small>}
              </div>
            </div>
            {kinds.map(([k, label]) => {
              const items = libraryAll.filter((x) => x.kind === k);
              if (!items.length) return null;
              return (
                <div className="picker-group" key={k}>
                  <b>{label}</b>
                  <div className="picker-items">
                    {items.map((x) => (
                      <button
                        key={x.id}
                        onClick={() =>
                          addContext({
                            label: x.title,
                            kind: k,
                            content: parseJson(x.content_json).body || "",
                            sourceId: x.id,
                          })
                        }
                      >
                        {x.title}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {contexts.map((x, i) => (
          <div className="context-chip" key={i}>
            <span>
              {x.label} · {kindNameFor(x.kind, language)}
            </span>
            <button
              onClick={() => setContexts((xs) => xs.filter((_, j) => j !== i))}
            >
              ×
            </button>
            <details>
              <summary>{tr("查看内容", "View content")}</summary>
              <pre>{x.content}</pre>
            </details>
          </div>
        ))}
          {!contexts.length && <small>{tr("普通聊天默认不会发送正文。", "Normal chat does not send manuscript text by default.")}</small>}
        </div>
      </details>
      <div className="messages">
        {messages.map((m, i) => (
          <div className={`message ${m.role}`} key={m.id || i}>
            <div>
              {m.role === "user" ? tr("你", "You") : "AI"}
              {m.incomplete && <em>{tr("（未完整回答）", " (incomplete response)")}</em>}
            </div>
            <p>
              <MdView text={m.content} />
              {m.streaming && <i className="cursor" />}
            </p>
            {m.role === "assistant" && !m.streaming && (
              <div className="message-actions">
                <button
                  onClick={() => navigator.clipboard.writeText(m.content)}
                >
                  {tr("复制", "Copy")}
                </button>
                {!float && (
                  <>
                    <button
                      onClick={() =>
                        apply("insert", m.content, m.source_revision)
                      }
                    >
                      {tr("插入光标", "Insert at cursor")}
                    </button>
                    {m.id === continuationId && (
                      <button
                        className="primary"
                        onClick={() => applyEnd(m.content)}
                      >
                        {tr("追加到章末", "Append to chapter")}
                      </button>
                    )}
                    <button onClick={() => setSegments({ msg: m })}>
                      {tr("逐句采纳", "Adopt by sentence")}
                    </button>
                    <button
                      disabled={!contexts.some((x) => x.kind === "selection")}
                      onClick={() => {
                        const sel = contexts.find(
                          (x) => x.kind === "selection",
                        );
                        if (sel) setCompare({ msg: m, original: sel.content });
                      }}
                    >
                      {tr("对比", "Compare")}
                    </button>
                    <button
                      onClick={() =>
                        apply("replace", m.content, m.source_revision)
                      }
                    >
                      {tr("替换选区", "Replace selection")}
                    </button>
                  </>
                )}
                <button
                  onClick={async () => {
                    const r = await api("library:save", {
                      novelId,
                      kind: "inspiration",
                      title: tr("AI 灵感", "AI idea"),
                      content: { body: m.content },
                      status: "idea",
                      chapterId,
                    });
                    notify(r.ok ? tr("已保存为待确认灵感", "Saved as an unconfirmed idea") : r.error || tr("灵感保存失败", "Could not save idea"));
                  }}
                >
                  {tr("存为灵感", "Save as idea")}
                </button>
                {float && (
                  <span className="hint">{tr("采纳修改请在主窗口正文中操作", "Apply changes from the main manuscript window")}</span>
                )}
              </div>
            )}
          </div>
        ))}
        {!messages.length && (
          <Empty
            title={tr("与作品一起思考", "Think alongside your story")}
            text={tr("只有你明确添加的引用内容才会发送给 AI。", "Only references you explicitly add are sent to AI.")}
          />
        )}
      </div>
      <details className="quick-prompt-box">
        <summary>{tr("快捷指令", "Quick prompts")}</summary>
        <div className="quick-prompts">
          {prompts.slice(0, 6).map((p) => (
            <button
              title={p.content}
              key={p.id}
              onClick={() => updateDraft(p.content, true)}
            >
              {promptNameFor(p.name, p.builtin, language)}
            </button>
          ))}
        </div>
      </details>
      <div className="composer-mode">
        <div className="mode-toggle" role="tablist">
          <button
            className={mode === "chat" ? "active" : ""}
            onClick={() => setMode("chat")}
          >
            {tr("对话", "Chat")}
          </button>
          <button
            className={mode === "continue" ? "active" : ""}
            onClick={() => setMode("continue")}
          >
            {tr("续写", "Continue")}
          </button>
        </div>
        {mode === "continue" && (
          <small className="hint">
            {tr("自动引用本章结尾（最后 4000 字），生成后可一键追加到章末；采纳前自动创建历史快照。", "Uses the last 4,000 characters of this chapter. The result can be appended with one click after an automatic history snapshot.")}
          </small>
        )}
      </div>
      <div className="composer">
        <textarea
          placeholder={
            mode === "continue"
              ? float
                ? tr("续写要求可留空。Enter 生成，结果在主窗口采纳", "Continuation instructions are optional. Press Enter to generate, then apply in the main window")
                : tr("可选：写下续写要求，留空则顺着上文推进。Enter 生成", "Optional: describe how to continue, or leave blank. Press Enter to generate")
              : float
                ? tr("输入问题，与主窗口共享同一会话。Enter 发送，Shift+Enter 换行", "Ask a question in the shared conversation. Enter to send; Shift+Enter for a new line")
                : tr("输入问题。Enter 发送，Shift+Enter 换行", "Ask a question. Enter to send; Shift+Enter for a new line")
          }
          value={draft}
          onChange={(e) => updateDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
        />
        {generating ? (
          <button
            className="danger"
            onClick={() => api("ai:cancel", requestId)}
          >
            {tr("停止", "Stop")}
          </button>
        ) : (
          <button
            className="primary"
            disabled={!connection || (mode === "chat" && !draft.trim())}
            title={
              !connection
                ? tr("请先在设置 → AI 模型中配置连接", "Configure a connection in Settings → AI models first")
                : mode === "continue"
                  ? tr("生成续写", "Generate continuation")
                  : tr("发送", "Send")
            }
            onClick={send}
          >
            {mode === "continue" ? tr("生成续写", "Generate") : tr("发送", "Send")}
          </button>
        )}
      </div>
      <div className="composer-meta hint" style={{ padding: "0 10px 8px", fontSize: 11 }}>
        {tr(
          `上下文约 ${fmt(estimate)} tokens（引用 ${fmt(contextChars)} 字 · 历史 ${fmt(historyChars)} 字 · 输入 ${fmt(draftChars)} 字）· 估算值，非服务商精确计费`,
          `~${fmt(estimate)} tokens context (refs ${fmt(contextChars)} · history ${fmt(historyChars)} · input ${fmt(draftChars)} chars) · estimate only`,
        )}
      </div>
      {compare && (
        <DiffModal
          title={tr("对比原文与 AI 建议", "Compare manuscript and AI suggestion")}
          beforeLabel={tr("原文", "Original")}
          afterLabel={tr("AI 建议", "AI suggestion")}
          before={compare.original}
          after={compare.msg.content}
          close={() => setCompare(null)}
          applyLabel={tr("采纳并替换选区", "Adopt and replace selection")}
          onApply={async () => {
            const msg = compare.msg;
            setCompare(null);
            await apply("replace", msg.content, msg.source_revision);
          }}
        />
      )}
      {segments && (
        <SegmentsModal
          suggestion={segments.msg.content}
          hasSelection={contexts.some((x) => x.kind === "selection")}
          close={() => setSegments(null)}
          onAdopt={async (content, mode) => {
            const msg = segments.msg;
            setSegments(null);
            await apply(mode, content, msg.source_revision);
          }}
          language={language}
        />
      )}
      {previewOpen && (
        <Modal
          title={tr("预览：本次将发送给 AI 的内容", "Preview: content sent to AI")}
          close={() => setPreviewOpen(false)}
        >
          <div className="send-preview">
            <p className="hint">
              {tr(
                `以下是按实际顺序发送的完整消息，共 ${previewMessages.length} 条。历史引用也会随对应消息一起显示。`,
                `These are the ${previewMessages.length} complete messages in send order. Earlier references appear with their original messages.`,
              )}
            </p>
            {previewMessages.map((message, index) => (
              <details
                key={index}
                className="preview-block"
                open={index === previewMessages.length - 1}
              >
                <summary>
                  {index + 1}. {message.role === "assistant" ? tr("AI 回复", "AI response") : tr("用户消息", "User message")}
                  {tr(`（${fmt(message.content.length)} 字）`, ` (${fmt(message.content.length)} characters)`) }
                </summary>
                <pre>{message.content || tr("（空）", "(empty)")}</pre>
              </details>
            ))}
          </div>
        </Modal>
      )}
      {renameOpen && (
        <PromptDialog
          title={tr("重命名会话", "Rename conversation")}
          label={tr("会话名称", "Conversation name")}
          initial={
            conversations.find((c) => c.id === conversation)?.title || ""
          }
          confirmLabel={tr("保存", "Save")}
          cancelLabel={tr("取消", "Cancel")}
          onCancel={() => setRenameOpen(false)}
          onConfirm={async (title) => {
            setRenameOpen(false);
            if (!title) return;
            const r = await api("ai:conversation:update", {
              id: conversation,
              title,
            });
            if (r.ok) loadConversations();
            else
              notify(
                r.error || tr("会话重命名失败", "Could not rename conversation"),
              );
          }}
        />
      )}
      {deleteOpen && (
        <ConfirmDialog
          title={tr("删除会话", "Delete conversation")}
          message={tr(
            "删除该会话？历史消息将不再显示。此操作不影响已写入正文的内容。",
            "Delete this conversation? Its messages will no longer be shown. Text already in the manuscript is not affected.",
          )}
          confirmLabel={tr("删除", "Delete")}
          cancelLabel={tr("取消", "Cancel")}
          danger
          onCancel={() => setDeleteOpen(false)}
          onConfirm={async () => {
            setDeleteOpen(false);
            const r = await api("ai:conversation:trash", conversation);
            if (r.ok) {
              await api("ai:session:loadConversation", "");
              loadConversations();
            } else
              notify(
                r.error || tr("会话删除失败", "Could not delete conversation"),
              );
          }}
        />
      )}
    </>
  );
}

export function SegmentsModal({
  suggestion,
  hasSelection,
  close,
  onAdopt,
  language = "zh-CN",
}: {
  suggestion: string;
  hasSelection: boolean;
  close: () => void;
  onAdopt: (content: string, mode: "insert" | "replace") => void;
  language?: UiLanguage;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const segs = useMemo(() => splitSegments(suggestion), [suggestion]);
  const [picked, setPicked] = useState<boolean[]>(() => segs.map(() => true));
  const content = joinSegments(segs, picked);
  const count = segs.filter((_, i) => picked[i]).length;
  return (
    <Modal title={tr("逐句采纳 AI 建议", "Adopt AI suggestion by sentence")} close={close}>
      <div className="segments">
        <p className="hint">
          {tr("取消勾选不想采用的句子，再选择采纳方式。采纳前会自动创建历史版本。", "Uncheck sentences you do not want, then choose how to apply them. A history snapshot is created first.")}
        </p>
        <div className="segment-list">
          {segs.map((s, i) => (
            <label key={i} className={`segment ${picked[i] ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={picked[i]}
                onChange={() =>
                  setPicked((xs) => xs.map((v, j) => (j === i ? !v : v)))
                }
              />
              <span>{s.text}</span>
            </label>
          ))}
          {!segs.length && <p className="hint">{tr("没有可采纳的内容。", "There is no content to adopt.")}</p>}
        </div>
        <div className="segment-foot">
          <button onClick={() => setPicked(segs.map(() => true))}>{tr("全选", "Select all")}</button>
          <button onClick={() => setPicked(segs.map(() => false))}>
            {tr("全不选", "Select none")}
          </button>
          <span className="hint">
            {tr(
              `已选 ${count} / ${segs.length} 句，共 ${content.replace(/\s/g, "").length} 字`,
              `${count} / ${segs.length} sentences selected, ${content.replace(/\s/g, "").length} characters`,
            )}
          </span>
        </div>
        <div className="row end">
          <button onClick={close}>{tr("取消", "Cancel")}</button>
          <button
            disabled={!content}
            onClick={() => onAdopt(content, "insert")}
          >
            {tr("插入光标", "Insert at cursor")}
          </button>
          {hasSelection && (
            <button
              className="primary"
              disabled={!content}
              onClick={() => onAdopt(content, "replace")}
            >
              {tr("替换选区", "Replace selection")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
