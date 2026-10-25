import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { joinSegments, splitSegments } from "../segments";
import { materialReferenceContent, relevantMaterials } from "../relevant";
import { normalizeSceneTargetWords } from "../scene-fields";
import { api, useAiSessionStore, fmt, kindNameFor, promptNameFor, parseJson, Empty, Modal, DiffModal, ConfirmDialog, PromptDialog, AnyRow, UiLanguage, aiDraftFlusher } from "./shared";
import { ChatToolbar } from "./chat/chat-toolbar";
import { HistoryDrawer } from "./chat/history-drawer";
import { MessageList, type ReplyActions } from "./chat/message-list";
import { Composer, type ComposerTask, type PromptTemplate } from "./chat/composer";
import { RefPicker } from "./chat/ref-picker";
import { ContextDialog } from "./chat/context-dialog";
import { StyleCardPanel, type StyleCard, type StyleIntensity } from "./chat/style-card-panel";
import {
  contextBreakdown,
  markInvalidRefs,
} from "./chat/chat-model";

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
  expanded,
  onToggleExpand,
  dockSide = "right",
  onDockSideChange,
  sceneDraftRequest,
  onSceneDraftRequestConsumed,
  onNavigateSource,
}: {
  novel: AnyRow;
  chapter: AnyRow | null;
  editor?: any;
  save?: (x?: boolean) => Promise<boolean>;
  notify: (s: string) => void;
  float?: boolean;
  onOpenSettings?: () => void;
  language?: UiLanguage;
  /** 主窗口内展开聊天区（与独立浮窗区分） */
  expanded?: boolean;
  onToggleExpand?: (next: boolean) => void;
  dockSide?: "left" | "right";
  onDockSideChange?: (side: "left" | "right") => void;
  sceneDraftRequest?: { nonce: string; chapterId: string; scene: AnyRow } | null;
  onSceneDraftRequestConsumed?: () => void;
  onNavigateSource?: (source: { kind: string; sourceId: string }) => Promise<boolean | void> | boolean | void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [session, patch] = useAiSessionStore();
  const [connections, setConnections] = useState<AnyRow[]>([]),
    [prompts, setPrompts] = useState<AnyRow[]>([]),
    [conversations, setConversations] = useState<AnyRow[]>([]),
    [libraryAll, setLibraryAll] = useState<AnyRow[]>([]),
    [bookChapters, setBookChapters] = useState<AnyRow[]>([]),
    [styleCards, setStyleCards] = useState<StyleCard[]>([]),
    [pickerOpen, setPickerOpen] = useState(false),
    [compare, setCompare] = useState<{ msg: AnyRow; original: string } | null>(
      null,
    ),
    [segments, setSegments] = useState<{ msg: AnyRow } | null>(null),
    [revisionApproval, setRevisionApproval] = useState<{
      chapterTitle: string;
      sourceRevision: number;
      currentRevision: number;
      resume: () => void;
    } | null>(null);
  const [sourceApproval, setSourceApproval] = useState<{
    labels: string[];
    resume: () => void;
  } | null>(null);
  const autoSelected = useRef("");
  const consumedSceneDraft = useRef("");
  const [mode, setMode] = useState<"chat" | "continue" | "naturalize" | "polish" | "outline" | "check">("chat");
  const [activeTaskId, setActiveTaskId] = useState("discuss-plot");
  const [styleIds, setStyleIds] = useState<string[]>([]);
  const [styleIntensity, setStyleIntensity] = useState<StyleIntensity>("balanced");
  const [styleRuleChars, setStyleRuleChars] = useState(0);
  const [stylePreviewRules, setStylePreviewRules] = useState("");
  const [projectInstructions, setProjectInstructions] = useState("");
  const [projectInstructionsDraft, setProjectInstructionsDraft] = useState("");
  const [projectInstructionsOpen, setProjectInstructionsOpen] = useState(false);
  const [projectInstructionsSaving, setProjectInstructionsSaving] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [previewMessages, setPreviewMessages] = useState<AnyRow[]>([]);
  const [payloadChars, setPayloadChars] = useState<number | null>(null);
  const [payloadPreviewStatus, setPayloadPreviewStatus] = useState<"idle" | "pending" | "checking" | "ready" | "error">("pending");
  const payloadSeq = useRef(0);
  const projectInstructionLoadSeq = useRef(0);
  const [continuationId, setContinuationId] = useState<string | null>(null);
  const [pendingRegenerateConversation, setPendingRegenerateConversation] = useState<string | null>(null);
  const prevGenerating = useRef(false);
  const pendingContinue = useRef(false);
  const sendLatest = useRef<() => void>(() => {});
  const novelId: string = session?.novelId || novel?.id || "";
  const chapterId: string | null = session?.chapter?.id || chapter?.id || null;
  const chapterTitle = session?.chapter?.title || chapter?.title || "";
  const connection: string = session?.connectionId || "";
  const conversation: string = session?.conversationId || "";
  const text: string = session?.text || "";
  const [draft, setDraft] = useState(text);
  const [editorContextRevision, setEditorContextRevision] = useState(0);
  const draftRef = useRef(text);
  const lastSyncedText = useRef(text);
  const draftTimer = useRef<number | undefined>(undefined);
  const draftVersionRef = useRef(0);
  const draftConvRef = useRef(conversation);
  useEffect(() => {
    // 会话切换：取消待提交任务，以服务端草稿与版本号为准
    if (draftConvRef.current !== conversation) {
      window.clearTimeout(draftTimer.current);
      draftConvRef.current = conversation;
      draftVersionRef.current = Number(session?.draftVersion || 0);
    } else {
      draftVersionRef.current = Math.max(draftVersionRef.current, Number(session?.draftVersion || 0));
    }
  }, [conversation, session?.draftVersion]);
  useEffect(() => {
    if (text === lastSyncedText.current) return;
    lastSyncedText.current = text;
    draftRef.current = text;
    setDraft(text);
  }, [text]);
  useEffect(() => () => window.clearTimeout(draftTimer.current), []);
  useEffect(() => {
    if (!editor?.on || !editor?.off) return;
    const onEditorUpdate = () => setEditorContextRevision((revision) => revision + 1);
    editor.on("update", onEditorUpdate);
    return () => editor.off("update", onEditorUpdate);
  }, [editor]);
  // 退出前由 App 调用：立即提交 400ms 防抖中未发送的草稿
  const flushDraftRef = useRef<() => void>(() => {});
  flushDraftRef.current = flushDraft;
  useEffect(() => {
    aiDraftFlusher.current = () => flushDraftRef.current();
    return () => {
      aiDraftFlusher.current = () => {};
    };
  }, []);
  function patchDraft(value: string, convId: string, version: number, nextContexts?: AnyRow[], nextStyleIds?: string[] | null) {
    return patch({
      text: value,
      ...(nextContexts ? { contexts: nextContexts } : {}),
      ...(nextStyleIds !== undefined ? { draftStyleIds: nextStyleIds } : {}),
      novelId,
      conversationId: convId,
      draftVersion: version,
    }).then((result) => {
      const acceptedVersion = Number(result.data?.version || 0);
      if (acceptedVersion) draftVersionRef.current = Math.max(draftVersionRef.current, acceptedVersion);
      if (!result.ok || result.data?.accepted === false) {
        notify(result.error || tr("草稿版本已更新，当前内容将在下次输入时重新保存。", "Draft changed elsewhere; your next edit will save the current version."));
      }
      return result;
    });
  }
  function saveComposerState(value: string, nextContexts: AnyRow[], convId = conversation, nextStyleIds?: string[] | null) {
    draftRef.current = value;
    setDraft(value);
    window.clearTimeout(draftTimer.current);
    lastSyncedText.current = value;
    draftConvRef.current = convId;
    const version = ++draftVersionRef.current;
    return patchDraft(value, convId, version, nextContexts, nextStyleIds);
  }
  function updateDraft(value: string, flush = false) {
    draftRef.current = value;
    setDraft(value);
    window.clearTimeout(draftTimer.current);
    const convId = conversation;
    const version = ++draftVersionRef.current;
    if (flush) {
      lastSyncedText.current = value;
      void patchDraft(value, convId, version);
      return;
    }
    draftTimer.current = window.setTimeout(() => {
      // 过期任务：会话已切换则丢弃
      if (draftConvRef.current !== convId) return;
      lastSyncedText.current = value;
      void patchDraft(value, convId, version);
    }, 400);
  }
  function insertPromptTemplate(template: PromptTemplate) {
    const current = draftRef.current;
    const next = current.trim()
      ? `${current.replace(/\s+$/, "")}\n\n${template.content}`
      : template.content;
    updateDraft(next, true);
  }
  function flushDraft() {
    window.clearTimeout(draftTimer.current);
    const value = draftRef.current;
    lastSyncedText.current = value;
    const version = ++draftVersionRef.current;
    void patchDraft(value, conversation, version);
    return value;
  }
  const contexts: AnyRow[] = session?.contexts || [];
  const activeStyleIds: string[] = Array.isArray(session?.draftStyleIds)
    ? session.draftStyleIds
    : styleIds;
  const messages: AnyRow[] = session?.messages || [];
  const messageWindow = session?.messageWindow || { hasEarlier: false, beforeMessageId: null };
  const generating: boolean = Boolean(session?.generating);
  const requestId: string = session?.requestId || "";
  const selectionText: string = session?.selectionText || "";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [compareConversation, setCompareConversation] = useState<AnyRow | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const compareRequestSeq = useRef(0);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyArchived, setHistoryArchived] = useState(false);
  const [currentArchived, setCurrentArchived] = useState(false);
  const [currentConversationTitle, setCurrentConversationTitle] = useState("");
  const [archiveStatusReady, setArchiveStatusReady] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const HISTORY_PAGE = 50;
  const historySeq = useRef(0);
  const loadConversations = useCallback(
    (opts?: { offset?: number; search?: string; append?: boolean; archived?: boolean }) => {
      if (!novelId) return;
      const offset = opts?.offset || 0;
      const search = opts?.search ?? historyQuery;
      const archived = opts?.archived ?? historyArchived;
      const seq = ++historySeq.current;
      setHistoryLoading(true);
      setHistoryError(null);
      api("ai:conversations", {
        novelId,
        limit: HISTORY_PAGE,
        offset,
        search,
        archived,
      }).then((r) => {
        if (seq !== historySeq.current) return;
        setHistoryLoading(false);
        if (!r.ok) {
          setHistoryError(r.error || "load failed");
          return;
        }
        const rows = r.data?.rows || [];
        setHistoryHasMore(Boolean(r.data?.hasMore));
        setConversations((prev) => {
          if (!opts?.append) return rows;
          const seen = new Set(prev.map((c) => c.id));
          return [...prev, ...rows.filter((c: AnyRow) => !seen.has(c.id))];
        });
      });
    },
    [novelId, historyQuery, historyArchived],
  );
  useEffect(() => {
    let live = true;
    setArchiveStatusReady(false);
    if (!conversation) {
      setCurrentArchived(false);
      setCurrentConversationTitle("");
      setArchiveStatusReady(true);
      return () => { live = false; };
    }
    api<{ archived: boolean; title: string }>("ai:conversation:status", conversation).then((result) => {
      if (live && result.ok) {
        setCurrentArchived(Boolean(result.data?.archived));
        setCurrentConversationTitle(String(result.data?.title || ""));
      }
      if (live) setArchiveStatusReady(true);
    });
    return () => { live = false; };
  }, [conversation, novelId]);
  useEffect(() => {
    const loadSeq = ++projectInstructionLoadSeq.current;
    setProjectInstructions("");
    if (!novelId) return;
    api<{ instructions: string }>("ai:project-instructions:get", novelId).then((r) => {
      if (loadSeq === projectInstructionLoadSeq.current && r.ok)
        setProjectInstructions(String(r.data?.instructions || ""));
    });
    loadConversations();
    api("connections:list").then((r) => r.ok && setConnections(r.data));
    api("prompts:list").then((r) => r.ok && setPrompts(r.data));
    api<StyleCard[]>("ai:styles:list").then((r) => r.ok && setStyleCards(r.data || []));
    api<any>("ai:style-selection:get", novelId).then((r) => {
      if (!r.ok) return;
      setStyleIds(r.data?.styleIds || (r.data?.styleId ? [r.data.styleId] : []));
      setStyleIntensity(r.data?.styleIntensity || "balanced");
    });
    api("novels:open", novelId).then(
      (r) => r.ok && setBookChapters(r.data.chapters),
    );
    api("library:listAll", novelId).then((r) => r.ok && setLibraryAll(r.data));
    return () => {
      if (projectInstructionLoadSeq.current === loadSeq)
        projectInstructionLoadSeq.current += 1;
    };
  }, [novelId]);
  async function reloadStyleCards() {
    const r = await api<StyleCard[]>("ai:styles:list");
    if (r.ok) setStyleCards(r.data || []);
    const selected = await api<any>("ai:style-selection:get", novelId);
    if (selected.ok) {
      setStyleIds(selected.data?.styleIds || (selected.data?.styleId ? [selected.data.styleId] : []));
      setStyleIntensity(selected.data?.styleIntensity || "balanced");
    }
  }
  async function selectStyles(next: string[]) {
    const r = await api<any>("ai:style-selection:set", { novelId, styleIds: next, styleIntensity });
    if (r.ok) {
      setStyleIds(r.data?.styleIds || next);
      return true;
    }
    notify(r.error || tr("写作风格保存失败", "Could not save writing style"));
    return false;
  }
  async function selectStyleIntensity(next: StyleIntensity) {
    const r = await api<any>("ai:style-selection:set", { novelId, styleIds, styleIntensity: next });
    if (r.ok) {
      setStyleIntensity(r.data?.styleIntensity || next);
      return true;
    }
    notify(r.error || tr("技法强调度保存失败", "Could not save technique emphasis"));
    return false;
  }
  async function selectComposerStyles(next: string[]) {
    if (!Array.isArray(session?.draftStyleIds)) return selectStyles(next);
    const result = await saveComposerState(draftRef.current, contexts, conversation, next);
    return result.ok && result.data?.accepted !== false;
  }
  useEffect(() => {
    let live = true;
    api<any>("ai:style:estimate", { styleIds: activeStyleIds, styleIntensity, taskKind: mode }).then((r) => {
      if (live && r.ok) {
        setStyleRuleChars(Number(r.data?.chars || 0));
        setStylePreviewRules(String(r.data?.instruction || ""));
      }
    });
    return () => { live = false; };
  }, [activeStyleIds, styleIntensity, mode]);
  useEffect(() => {
    const request = sceneDraftRequest;
    if (!request || session?.novelId !== novelId || request.chapterId !== chapterId || consumedSceneDraft.current === request.nonce) return;
    consumedSceneDraft.current = request.nonce;
    const scene = request.scene || {};
    const sceneContent = parseJson(scene.content_json || "{}");
    const targetWords = normalizeSceneTargetWords(scene.targetWords ?? sceneContent.targetWords);
    const sceneContext = {
      label: `${scene.title || tr("未命名场景", "Untitled scene")} · ${tr("场景细纲", "Scene outline")}`,
      kind: "scene",
      sourceId: String(scene.id || ""),
      content: materialReferenceContent({
        ...scene,
        kind: "scene",
        content_json: scene.content_json || JSON.stringify(scene),
      }),
    };
    patch({
      contexts: [
        ...(session?.contexts || []).filter((item: AnyRow) => !(item.kind === "scene" && item.sourceId === sceneContext.sourceId)),
        sceneContext,
      ],
    });
    setActiveTaskId("draft-scene");
    setMode("outline");
    updateDraft(tr(
      `请依据引用的场景细纲，为「${scene.title || "本场"}」起草正文。遵守已确认设定与人物知识边界，兑现细纲中的目标、冲突和回报；不要擅自改变既定事实。${targetWords ? `本场目标篇幅约 ${fmt(targetWords)} 字，尽量接近目标，不要为凑字数重复或注水。` : ""}只输出可直接进入小说的正文，不要标题、提纲或解释。`,
      `Draft the prose for “${scene.title || "this scene"}” using the attached scene outline. Respect confirmed canon and character knowledge; deliver the outlined goal, conflict, and payoff without changing established facts.${targetWords ? ` Aim for approximately ${fmt(targetWords)} Chinese characters for this scene; stay near the target without padding or repetition.` : ""} Output only manuscript-ready prose, with no heading, outline, or explanation.`,
    ));
    onSceneDraftRequestConsumed?.();
  // updateDraft is a function declaration; the nonce prevents duplicate consumption while session snapshots settle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneDraftRequest, chapterId, session?.novelId, session?.contexts, novelId]);
  useEffect(() => {
    const off = window.zhuwen.onAiConversations((payload) => {
      const rows = Array.isArray(payload) ? payload : payload?.rows;
      const scope = Array.isArray(payload) ? null : payload?.novelId;
      if (scope && novelId && scope !== novelId) return;
      if (conversation) {
        api<{ archived: boolean; title: string }>("ai:conversation:status", conversation).then((result) => {
          if (result.ok) {
            setCurrentArchived(Boolean(result.data?.archived));
            setCurrentConversationTitle(String(result.data?.title || ""));
          }
        });
      }
      // 搜索中或多页浏览时：按当前条件刷新，不直接覆盖成未筛选列表
      if (historyQuery.trim() || conversations.length > HISTORY_PAGE || historyArchived) {
        loadConversations({ offset: 0, search: historyQuery, archived: historyArchived });
        return;
      }
      if (Array.isArray(rows)) setConversations(rows);
    });
    return off;
  }, [novelId, historyQuery, historyArchived, conversations.length, conversation, loadConversations]);
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
        chapterText(),
        12,
        {
          chapterId,
          selectionText,
          language,
          chapterTitles: Object.fromEntries(bookChapters.map((item) => [item.id, item.title])),
          chapterOrder: Object.fromEntries(bookChapters.map((item, index) => [item.id, index])),
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [libraryAll, bookChapters, pickerOpen, selectionText, chapterId, chapter?.plain_text, session?.chapter?.plain_text, language],
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
    void saveComposerState(draftRef.current, updater(contexts));
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
    let selectionFrom: number | null = null;
    let selectionTo: number | null = null;
    if (editor)
      {
      selectionFrom = editor.state.selection.from;
      selectionTo = editor.state.selection.to;
      selected = editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
        "\n",
      );
    }
    if (!selected) selected = selectionText;
    if (!selected) return notify(tr("请先在正文中选择文字", "Select text in the manuscript first"));
    setContexts((xs) => [
      ...xs.filter((x) => x.kind !== "selection"),
      {
        label: `${chapterTitle || tr("选段", "Excerpt")} · ${tr("选中文字", "Selection")}`,
        kind: "selection",
        content: selected,
        sourceId: chapterId || "",
        from: selectionFrom,
        to: selectionTo,
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
    if (mode === "naturalize") {
      const selected = contexts.find((x) => x.kind === "selection");
      if (!selected) return null;
      const resolved = resolveTemplateVars(contexts, ask);
      return {
        contexts: resolved.contexts,
        prompt: ask
          ? `请对引用的选区执行自然化润色。保留原有情节顺序、叙述视角、关键线索、人物决定和已知设定。只输出修改后的正文。\n\n补充要求：${resolved.prompt}`
          : "请对引用的选区执行自然化润色。只输出修改后的正文。",
        ask,
      };
    }
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
  function requestPayloadPreview(plan: { contexts: AnyRow[]; prompt: string }) {
    return api<AnyRow[]>("ai:previewRequest", {
      conversationId: conversation,
      novelId,
      contexts: plan.contexts,
      prompt: plan.prompt,
      styleIds: activeStyleIds,
      styleIntensity,
      taskKind: mode,
    });
  }
  function payloadCharCount(messages: AnyRow[]) {
    return messages.reduce((total, message) => total + Array.from(String(message?.content || "")).length, 0);
  }

  useEffect(() => {
    const seq = ++payloadSeq.current;
    setPayloadChars(null);
    setPayloadPreviewStatus("pending");
    const plan = buildSendPlan();
    if (!plan) {
      setPayloadChars(0);
      setPayloadPreviewStatus("idle");
      return;
    }
    const timer = window.setTimeout(() => {
      if (seq === payloadSeq.current) setPayloadPreviewStatus("checking");
      void requestPayloadPreview(plan).then((result) => {
        if (seq !== payloadSeq.current) return;
        if (result.ok) {
          setPayloadChars(payloadCharCount(result.data || []));
          setPayloadPreviewStatus("ready");
        } else {
          setPayloadChars(null);
          setPayloadPreviewStatus("error");
        }
      }).catch(() => {
        if (seq === payloadSeq.current) {
          setPayloadChars(null);
          setPayloadPreviewStatus("error");
        }
      });
    }, 320);
    return () => {
      window.clearTimeout(timer);
      payloadSeq.current += 1;
    };
  }, [
    draft,
    contexts,
    mode,
    activeStyleIds,
    conversation,
    chapterId,
    chapterTitle,
    language,
    editorContextRevision,
    chapter?.revision,
    chapter?.plain_text,
    session?.chapter?.revision,
    session?.chapter?.plain_text,
    selectionText,
    messages.length,
    styleRuleChars,
    projectInstructions,
  ]);

  async function send() {
    if (!connection || !chapterId || generating) return;
    flushDraft();
    const continuing = mode === "continue";
    const plan = buildSendPlan();
    if (!plan) return notify(mode === "naturalize" ? tr("请先添加正文选区，再执行自然化润色", "Select a manuscript excerpt before naturalizing") : tr("当前章节还没有正文，无法续写", "The current chapter is empty and cannot be continued"));
    if (!continuing && mode !== "naturalize" && !plan.ask) return;
    const payloadPreview = await requestPayloadPreview(plan);
    if (!payloadPreview.ok) {
      setPayloadPreviewStatus("error");
      return notify(payloadPreview.error || tr("无法核对本次上下文，未发送。", "Could not verify this request's context; nothing was sent."));
    }
    const plannedChars = payloadCharCount(payloadPreview.data || []);
    setPayloadChars(plannedChars);
    setPayloadPreviewStatus("ready");
    if (plannedChars > contextLimitChars) {
      return notify(tr(
        `上下文已超过 30 万字上限（当前约 ${fmt(plannedChars)} 字），请减少引用或历史消息。`,
        `Context exceeds the 300k-character limit (about ${fmt(plannedChars)} chars). Remove references or older messages.`,
      ));
    }
    const historyTrimNotice = (payloadPreview.data || []).find((message: AnyRow) =>
      message.role === "system" && String(message.content || "").startsWith("[Context management:"),
    );
    const trimmedMessageCount = Number(String(historyTrimNotice?.content || "").match(/^\[Context management: (\d+)/)?.[1] || 0);
    if (trimmedMessageCount > 0) {
      notify(tr(
        `本次请求为适配上下文上限，已省略最早的 ${trimmedMessageCount} 条历史消息；本地完整记录仍保留。`,
        `The ${trimmedMessageCount} earliest messages were omitted from this request to fit the context limit. Your full local history is preserved.`,
      ));
    }
    if (!float && save && !(await save(true))) return;
    const id = crypto.randomUUID();
    const composerSave = await saveComposerState(draftRef.current, plan.contexts);
    if (!composerSave.ok || composerSave.data?.accepted === false) return;
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
      selectionFrom: plan.contexts.find((x) => x.kind === "selection")
        ? (plan.contexts.find((x) => x.kind === "selection")?.from ?? null)
        : (editor?.state.selection.from ?? null),
      selectionTo: plan.contexts.find((x) => x.kind === "selection")
        ? (plan.contexts.find((x) => x.kind === "selection")?.to ?? null)
        : (editor?.state.selection.to ?? null),
      connectionId: connection,
      prompt: plan.prompt,
      contexts: plan.contexts,
      styleIds: activeStyleIds,
      styleIntensity,
      taskKind: mode,
    });
    if (!r.ok) {
      pendingContinue.current = false;
      updateDraft(plan.ask, true);
      notify(r.error || tr("发送失败，内容已放回输入框，可修改后重试", "Sending failed. Your text was restored to the composer for retrying"));
    } else {
      if (conversation) setCurrentArchived(false);
      loadConversations({ archived: historyArchived });
    }
  }
  sendLatest.current = () => { void send(); };
  useEffect(() => {
    if (!pendingRegenerateConversation || conversation !== pendingRegenerateConversation || generating) return;
    setPendingRegenerateConversation(null);
    window.requestAnimationFrame(() => sendLatest.current());
  }, [pendingRegenerateConversation, conversation, generating]);
  async function verifyAdoptionSource(
    sourceMessageId: string | null | undefined,
    sourceChapterId: string | null | undefined,
    sourceRevision: number | null | undefined,
    approvedRevision: number | undefined,
    approvedSourceState: string | undefined,
    resume: (revision: number, sourceState: string) => void,
  ) {
    if (sourceChapterId && chapter && sourceChapterId !== chapter.id) {
      const sourceTitle = bookChapters.find((item) => item.id === sourceChapterId)?.title || tr("原章节", "source chapter");
      notify(tr(
        `这条回复来自「${sourceTitle}」，当前打开的是「${chapter.title}」。请先切换到来源章节，再采纳。`,
        `This reply was generated for “${sourceTitle}”, but “${chapter.title}” is open. Switch to its source chapter before adopting it.`,
      ));
      return false;
    }
    let currentRevision = Number(chapter?.revision || 0);
    if (sourceRevision != null && chapter) {
      const latest = await api<AnyRow>("chapters:get", chapter.id);
      if (!latest.ok || !latest.data) {
        notify(tr("无法核对当前章节版本，未采纳 AI 内容。", "Could not verify the current chapter revision; nothing was adopted."));
        return false;
      }
      currentRevision = Number(latest.data.revision ?? chapter.revision);
      if (currentRevision !== Number(sourceRevision) && approvedRevision !== currentRevision) {
        setRevisionApproval({
          chapterTitle: chapter.title,
          sourceRevision: Number(sourceRevision),
          currentRevision,
          resume: () => resume(currentRevision, approvedSourceState || ""),
        });
        return false;
      }
    }
    if (!sourceMessageId) return true;
    const refs = await api<AnyRow[]>("ai:message:contexts", sourceMessageId);
    if (!refs.ok) {
      notify(refs.error || tr("无法核对 AI 回复所依据的资料，未采纳。", "Could not verify the AI source materials; nothing was adopted."));
      return false;
    }
    const staleRefs = (refs.data || []).filter((item) =>
      ["changed", "deleted", "missing"].includes(String(item.sourceStatus || "")),
    );
    if (!staleRefs.length) return true;
    const sourceState = JSON.stringify(staleRefs.map((item) => [
      item.kind, item.sourceId, item.sourceStatus, item.currentDataVersion,
    ]));
    if (approvedSourceState === sourceState) return true;
    setSourceApproval({
      labels: staleRefs.map((item) => `${item.label || item.kind}（${
        item.sourceStatus === "changed" ? tr("已更新", "updated") :
          item.sourceStatus === "deleted" ? tr("已删除", "deleted") : tr("已不存在", "missing")
      }）`),
      resume: () => resume(currentRevision, sourceState),
    });
    return false;
  }
  async function apply(
    mode: "insert" | "replace",
    content: string,
    sourceRevision?: number,
    savedSelection?: string,
    savedFrom?: number | null,
    savedTo?: number | null,
    sourceChapterId?: string,
    approvedRevision?: number,
    sourceMessageId?: string,
    approvedSourceState?: string,
  ) {
    if (!editor || !chapter || !content) return;
    if (sourceChapterId && sourceChapterId !== chapter.id) {
      await verifyAdoptionSource(sourceMessageId, sourceChapterId, sourceRevision, approvedRevision, approvedSourceState, () => {});
      return;
    }
    const selected = savedSelection ?? contexts.find((x) => x.kind === "selection")?.content;
    if (mode === "replace" && !selected)
      return notify(tr("缺少原始选区快照，无法安全替换。", "The original selection snapshot is missing, so replacement is not safe."));
    if (mode === "replace") {
      const currentSelection = editor.state.selection;
      if (savedFrom != null && savedTo != null && (currentSelection.from !== savedFrom || currentSelection.to !== savedTo))
        return notify(tr("原选区位置已变化，请重新选择并比较后再采用", "The original selection moved. Select it again and compare before adopting"));
      if (editor.state.doc.textBetween(currentSelection.from, currentSelection.to, "\n") !== selected)
        return notify(tr("当前选区与原文不一致，未执行替换", "The current selection no longer matches the original, so nothing was replaced"));
    }
    if (save && !(await save(true)))
      return notify(tr("正文尚未保存，已取消写入 AI 内容", "The manuscript could not be saved, so the AI text was not inserted"));
    if (!(await verifyAdoptionSource(sourceMessageId, sourceChapterId, sourceRevision, approvedRevision, approvedSourceState, (revision, sourceState) => {
      void apply(mode, content, sourceRevision, savedSelection, savedFrom, savedTo, sourceChapterId, revision, sourceMessageId, sourceState);
    }))) return;
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
  async function applyEnd(
    content: string,
    sourceRevision?: number,
    sourceChapterId?: string,
    approvedRevision?: number,
    sourceMessageId?: string,
    approvedSourceState?: string,
  ) {
    if (!editor || !chapter || !content) return;
    if (save && !(await save(true)))
      return notify(tr("正文尚未保存，已取消追加 AI 内容", "The manuscript could not be saved, so the AI text was not appended"));
    if (!(await verifyAdoptionSource(sourceMessageId, sourceChapterId, sourceRevision, approvedRevision, approvedSourceState, (revision, sourceState) => {
      void applyEnd(content, sourceRevision, sourceChapterId, revision, sourceMessageId, sourceState);
    }))) return;
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
  const historyChars = messages.reduce(
    (n, m) => n + String(m?.content || "").length,
    0,
  );
  const draftChars = draftRef.current.length;
  const historyCount = messages.filter((m) => !m.streaming).length;
  const generatingConvTitle =
    conversations.find(
      (c) => c.id === (session?.generatingConversationId || conversation),
    )?.title || "";
  const refsForUi: AnyRow[] = markInvalidRefs(contexts, {
    chapterId,
    chapterSummary: chapter?.summary,
    bookChapters,
    selectionText,
    hasChapterText: Boolean(chapterText().trim()),
  });
  const sourceRevisionNow = Number(session?.chapter?.revision ?? chapter?.revision ?? -1);
  const decorateMessage = useCallback((message: AnyRow) => {
      const messageChapterId = String(message.chapter_id || "");
      const messageRevision = message.source_revision == null ? null : Number(message.source_revision);
      return {
        ...message,
        source_stale: Boolean(
          messageChapterId && messageChapterId === chapterId && messageRevision != null &&
          sourceRevisionNow >= 0 && messageRevision !== sourceRevisionNow,
        ),
        source_chapter_other: Boolean(messageChapterId && chapterId && messageChapterId !== chapterId),
        source_chapter_title: bookChapters.find((item) => item.id === messageChapterId)?.title || "",
        source_material_stale: Array.isArray(message.source_refs) && message.source_refs.some((source: AnyRow) =>
          ["changed", "deleted", "missing"].includes(String(source.source_status || "")),
        ),
      };
    },
    [chapterId, sourceRevisionNow, bookChapters],
  );
  const messagesForUi = useMemo(() => messages.map(decorateMessage), [messages, decorateMessage]);
  const loadEarlierMessages = useCallback(async (beforeMessageId: string) => {
    const result = await api<{ rows: AnyRow[]; hasEarlier: boolean }>("ai:conversation:messages:before", {
      novelId,
      conversationId: conversation,
      beforeMessageId,
      limit: 80,
    });
    if (!result.ok) return { ok: false, error: result.error || tr("读取更早消息失败", "Could not load earlier messages") };
    return {
      ok: true,
      rows: (result.data?.rows || []).map(decorateMessage),
      hasEarlier: Boolean(result.data?.hasEarlier),
    };
  }, [novelId, conversation, decorateMessage, language]);
  const breakdown = contextBreakdown(
    contexts,
    messages.filter((m) => !m.streaming).length,
    historyChars,
    draftChars,
    styleRuleChars,
  );
  const contextLimitChars = 300000;
  const displayedPayloadChars = payloadChars ?? breakdown.totalChars;
  const contextPercent = Math.round((displayedPayloadChars / contextLimitChars) * 100);
  const contextExceeded = payloadChars != null && payloadChars > contextLimitChars;
  const hasSelectionReference = contexts.some((item) => item.kind === "selection");
  const hasChapterText = Boolean(chapterText().trim());
  const taskCanSend = mode === "continue"
    ? hasChapterText
    : mode === "naturalize"
      ? hasSelectionReference
      : Boolean(draft.trim());
  const requestCanSend = Boolean(connection && chapterId && !generating && taskCanSend);
  const contextCanSend = payloadPreviewStatus === "ready"
    ? !contextExceeded
    : payloadPreviewStatus === "error" && !contextExceeded;
  const canSend = requestCanSend && contextCanSend;
  const sendHint = !connection
    ? tr("请先配置 AI 连接", "Configure an AI connection first")
    : !chapterId
      ? tr("请先选择章节", "Select a chapter first")
      : mode === "naturalize" && !hasSelectionReference
        ? tr("请先选择并引用正文片段", "Select and reference a manuscript excerpt first")
        : mode === "continue" && !hasChapterText
          ? tr("当前章节没有正文，暂时无法续写", "This chapter has no text to continue")
          : !taskCanSend
            ? tr("请先输入请求内容", "Enter a request first")
            : payloadPreviewStatus === "pending"
              ? tr("正在等待输入稳定后核对上下文…", "Waiting to verify the updated context…")
              : payloadPreviewStatus === "checking"
                ? tr("正在核对本次实际发送内容…", "Verifying the exact request payload…")
                : contextExceeded
                  ? tr("超过 30 万字上限，请减少引用或历史消息", "Over the 300k-character limit; remove references or older messages")
                  : payloadPreviewStatus === "error"
                    ? tr("上下文核对失败；点发送可重试，未核对前不会发送", "Context verification failed. Send to retry; nothing is sent until verified")
                    : "";
  const sendStatusLine = contextExceeded
    ? sendHint
    : payloadPreviewStatus === "pending" || payloadPreviewStatus === "checking" || payloadPreviewStatus === "error"
      ? sendHint
      : "";
  const [contextOpen, setContextOpen] = useState(false);
  const [contextHistoryStats, setContextHistoryStats] = useState<{
    messageCount: number;
    characterCount: number;
  } | null>(null);
  const contextStatsSeq = useRef(0);
  const [refPreview, setRefPreview] = useState<AnyRow | null>(null);
  const previewMessageSource = useCallback(async (messageId: string, source: AnyRow) => {
    if (!messageId) return;
    const result = await api<AnyRow[]>("ai:message:contexts", messageId);
    if (!result.ok) return notify(result.error || (language === "en" ? "Could not load the source snapshot" : "无法读取引用快照"));
    const found = (result.data || []).find((item) =>
      item.kind === source.kind &&
      (source.source_id ? item.sourceId === source.source_id : item.label === source.label),
    );
    if (found) setRefPreview(found);
    else notify(language === "en" ? "No matching source snapshot was saved for this message" : "这条消息没有保存对应引用快照");
  }, [language, notify]);
  const previewSeq = useRef(0);
  async function openContext() {
    setContextOpen(true);
    setContextHistoryStats(null);
    const statsSeq = ++contextStatsSeq.current;
    if (conversation) {
      void api<{ messageCount: number; characterCount: number }>(
        "ai:conversation:messages:stats",
        { novelId, conversationId: conversation },
      )
        .then((stats) => {
          if (statsSeq === contextStatsSeq.current && stats.ok && stats.data)
            setContextHistoryStats(stats.data);
        });
    }
    const seq = ++previewSeq.current;
    const plan = buildSendPlan();
    if (!plan) {
      setPreviewMessages([]);
      return;
    }
    const result = await requestPayloadPreview(plan);
    if (seq !== previewSeq.current) return;
    const payload = result.ok ? result.data || [] : [];
    setPreviewMessages(payload);
    setPayloadChars(result.ok ? payloadCharCount(payload) : null);
  }
  async function saveProjectInstructions() {
    setProjectInstructionsSaving(true);
    const result = await api<{ instructions: string }>("ai:project-instructions:set", {
      novelId,
      instructions: projectInstructionsDraft,
    });
    setProjectInstructionsSaving(false);
    if (!result.ok) {
      notify(result.error || tr("作品指令保存失败", "Could not save project instructions"));
      return;
    }
    setProjectInstructions(String(result.data?.instructions || ""));
    setProjectInstructionsOpen(false);
    notify(tr("作品 AI 指令已保存，将用于本作品后续请求。", "Project AI instructions saved. They will be used for future requests in this novel."));
  }
  function handleAddFromPicker(item: {
    label: string;
    kind: string;
    content: string;
    sourceId: string;
  }) {
    if (item.kind === "__selection__") return addSelection();
    if (item.kind === "__chapter__") return addChapter();
    if (item.kind === "__summary__") return addSummary();
    addContext(item);
  }
  const canApplyFromReply = !float && Boolean(editor) && Boolean(chapter);
  const applyDisabledReason = !canApplyFromReply
    ? tr("主窗口中才能修改正文", "Apply from the main window")
    : undefined;
  const tasks: ComposerTask[] = [
    {
      id: "discuss-plot",
      kind: "chat",
      label: tr("讨论剧情", "Discuss plot"),
      draft: tr(
        "请结合已添加的引用，指出本段的关键矛盾，并给出 3 种不改变既定事实的推进方案。",
        "Using the attached references, identify the key conflict and offer 3 continuations that do not change established facts.",
      ),
      hint: tr(
        "普通对话默认不附带正文，只发送你添加的引用。",
        "Chat sends only the references you add.",
      ),
    },
    {
      id: "polish-passage",
      kind: "polish",
      label: tr("润色段落", "Polish passage"),
      draft: tr(
        "请润色选中段落：保留事实、视角与人物关系，不扩写新情节。输出修改稿并说明改动理由。",
        "Polish the selected passage: keep facts, POV, and relationships; do not invent new plot. Output the revision and briefly explain changes.",
      ),
      hint: tr("建议先在正文中选中段落并加入引用。", "Select text in the manuscript and add it as a reference first."),
    },
    {
      id: "character-writing",
      kind: "polish",
      label: tr("人物描写", "Character writing"),
      draft: tr(
        "请基于人物卡与场景引用，写一段贴合该人物语言习惯的行动/对话描写，保持视角一致。",
        "Using the character card and scene references, write action/dialogue that fits their speech habits and keeps POV consistent.",
      ),
      hint: tr("可引用人物卡与相关章节。", "Reference character cards and related chapters."),
    },
    {
      id: "plot-next",
      kind: "outline",
      label: tr("推演后续", "Plot next"),
      draft: tr(
        "请推演接下来 2–3 个场景的可能走向：列出前提、风险与最自然的一条路径，不要直接替我写完整章。",
        "Outline 2–3 possible next scenes: premises, risks, and the most natural path. Do not write the whole chapter for me.",
      ),
    },
    {
      id: "proofread",
      kind: "check",
      label: tr("检查错别字", "Proofread"),
      draft: tr(
        "请检查引用文本中的错别字、标点与语病，逐条列出原句与建议，不要改写风格。",
        "Check typos, punctuation, and grammar in the referenced text. List original vs suggestion; do not restyle.",
      ),
    },
    {
      id: "ground-setting",
      kind: "check",
      label: tr("设定奠基", "Ground setting"),
      draft: tr(
        "请根据当前引用的世界设定与人物，列出本章必须遵守的 5–8 条事实约束（时间、空间、能力边界、已发生事件），供后续写作对照。",
        "From the referenced world/character notes, list 5–8 facts this chapter must respect (time, space, abilities, past events).",
      ),
    },
    ...(chapterId ? [{
      id: "extract-story-candidates",
      kind: "check",
      label: tr("提取资料候选", "Extract story-bible candidates"),
      attachChapter: true,
      appendDraft: true,
      draft: tr(
        `请以引用的“当前章节”正文为主要事实来源，整理可供作者确认后录入资料库的候选。不要修改或补写正文，也不要自动把推测写成事实。\n\n按以下小节输出，仅列出有原文依据的内容；每条附一段不超过 30 字的原文证据：\n1. 新出现或身份信息明确的人物（姓名、身份/行动、证据；无法确认姓名时标“待确认”）。\n2. 新出现或本章补充的地点、势力、规则、物品等设定（候选名称、明确事实、证据）。\n3. 本章已经发生的人物或设定变化（对象、变化前后；原文未明确则不要补全）。\n4. 本章场景细纲候选（时间/地点、视角、出场人物、剧情作用、回报、章末钩子；缺少的字段标“无明确证据”）。\n\n区分“原文明确”和“待确认推断”，计划、传闻和人物猜测不得写成已经发生的事实。若引用中已有资料卡，优先指出可补充到旧条目的内容，不重复创建。某一类没有有效候选时写“无”。最后只列候选，不生成长篇章节摘要。`,
        `Use the referenced current chapter as the primary source of truth. Extract candidates the author may review and add to the story bible. Do not edit or continue the manuscript, and never present inference as fact.\n\nReturn only items supported by the text, each with an excerpt of at most 30 Chinese characters: (1) newly introduced or clarified characters; (2) new or expanded locations, factions, rules, or objects; (3) changes that have already happened to a character or setting; (4) a scene-outline candidate with time/place, POV, cast, plot role, payoff, and chapter-end hook. Mark missing evidence explicitly. Separate explicit facts from pending inferences; plans, rumors, and guesses are not events. If a referenced story-bible entry already exists, suggest an addition to it instead of duplicating it. Use “None” for empty categories. Do not write a long chapter summary.`,
      ),
      hint: tr("自动引用当前章节；只生成带原文证据的候选，不会自动写入资料库。", "Automatically references the current chapter. Candidates include evidence and are never saved automatically."),
    }] : []),
    {
      id: "outline-chapter",
      kind: "outline",
      label: tr("大纲规划", "Outline chapter"),
      draft: tr(
        "请为下一章拟细纲：剧情作用、出场人物、场景目标与冲突、爽点、章末钩子。用条目列出，不写正文。",
        "Outline the next chapter: plot role, cast, scene goal/conflict, highlight, chapter-end hook. Bullets only; no full prose.",
      ),
    },
    {
      id: "draft-scene",
      kind: "outline",
      label: tr("起草场景", "Draft scene"),
      hint: tr("根据场景细纲起草；发送前可编辑要求。", "Draft from a scene outline; review the prompt before sending."),
    },
    {
      id: "expand-selection",
      kind: "polish",
      label: tr("扩写选区", "Expand selection"),
      draft: tr(
        "请在保持事实与视角不变的前提下扩写选区：补充感官与动作细节，不超过原文两倍长度。",
        "Expand the selection without changing facts or POV; add sensory/action detail; keep under 2× length.",
      ),
    },
    {
      id: "rewrite-selection",
      kind: "polish",
      label: tr("改写选区", "Rewrite selection"),
      draft: tr(
        "请改写选区，使节奏更紧、语言更贴合人物语气；保留全部事实信息，并列出主要改动点。",
        "Rewrite the selection for tighter pacing and character-true voice; keep all facts; list main changes.",
      ),
    },
    {
      id: "continue-chapter",
      kind: "continue",
      label: tr("续写", "Continue"),
      hint: tr(
        "自动引用本章结尾（最后 4000 字），生成后可追加到章末。",
        "Auto-references the last 4,000 characters; append after generating.",
      ),
    },
    {
      id: "naturalize-selection",
      kind: "naturalize",
      label: tr("自然化润色", "Naturalize"),
      hint: tr("先添加正文选区；结果会进入 AI 面板，确认后才修改正文。", "Add a manuscript selection first; nothing changes until you adopt the result."),
    },
  ];
  const actionsFor = useCallback(
    (m: AnyRow): ReplyActions => {
      const naturalize = m.task_kind === "naturalize";
      const sourceChapterMismatch = Boolean(m.chapter_id && chapterId && m.chapter_id !== chapterId);
      const sourceChapterTitle = bookChapters.find((item) => item.id === m.chapter_id)?.title || tr("来源章节", "source chapter");
      const replyDisabledReason = sourceChapterMismatch
        ? tr(`回复来自「${sourceChapterTitle}」，请切换回该章节`, `Reply is from “${sourceChapterTitle}”. Switch to that chapter first.`)
        : applyDisabledReason;
      const openComparison = () => {
        const saved = m.selection_text || contexts.find((x) => x.kind === "selection")?.content;
        if (!saved) {
          notify(tr("这条历史消息没有保存原始选区，无法安全比较；可复制结果后重新选择正文。", "This message has no saved selection snapshot, so it cannot be compared safely. Copy the result and select the text again."));
          return;
        }
        setCompare({ msg: m, original: saved });
      };
      return ({
      canApply: canApplyFromReply && !sourceChapterMismatch,
      applyDisabledReason: replyDisabledReason,
      canAppendToEnd: !float && m.id === continuationId && !sourceChapterMismatch,
      requiresComparison: naturalize,
      onInsertCursor: () => naturalize ? openComparison() : void apply("insert", m.content, m.source_revision, undefined, undefined, undefined, m.chapter_id, undefined, m.source_message_id),
      onReplaceSelection: () =>
        naturalize ? openComparison() : void apply("replace", m.content, m.source_revision, m.selection_text || undefined, m.selection_from, m.selection_to, m.chapter_id, undefined, m.source_message_id),
      onAppendToEnd: () => naturalize ? openComparison() : void applyEnd(m.content, m.source_revision, m.chapter_id, undefined, m.source_message_id),
      onSegments: () => naturalize ? openComparison() : setSegments({ msg: m }),
      onCompare: openComparison,
      onSaveInspiration: () => {
        void api("library:save", {
          novelId,
          kind: "inspiration",
          title: tr("AI 灵感", "AI idea"),
          content: { body: m.content },
          status: "idea",
          chapterId,
        }).then((r) =>
          notify(
            r.ok
              ? tr("已保存为待确认灵感", "Saved as an unconfirmed idea")
              : r.error || tr("灵感保存失败", "Could not save idea"),
          ),
        );
      },
      floatOnlyHint: float,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      applyDisabledReason,
      bookChapters,
      canApplyFromReply,
      chapter?.id,
      chapter?.title,
      chapterId,
      contexts,
      continuationId,
      editor,
      float,
      language,
      novelId,
      notify,
    ],
  );
  const renderMarkdown = useCallback(
    (text: string) => <MdView text={text} />,
    [],
  );
  async function reusePrompt(message: AnyRow, regenerate = false) {
    if (generating) {
      notify(tr("请等待当前回复完成后再复用提问。", "Wait for the current response to finish before reusing a prompt."));
      return;
    }
    if (!message.id) return;
    const sourceChapterId = String(message.chapter_id || "");
    if (sourceChapterId && sourceChapterId !== chapterId) {
      const sourceChapter = bookChapters.find((item) => item.id === sourceChapterId);
      if (!sourceChapter) {
        notify(tr("原提问所属章节已不存在，无法安全重试。", "The source chapter no longer exists; retry was stopped to avoid using the wrong chapter."));
        return;
      }
      if (!onNavigateSource) {
        notify(tr(`请先切换到「${sourceChapter.title}」再重试这条提问。`, `Switch to “${sourceChapter.title}” before retrying this prompt.`));
        return;
      }
      const navigated = await onNavigateSource({ kind: "chapter", sourceId: sourceChapterId });
      if (navigated === false) return;
    }
    const result = await api<AnyRow[]>("ai:message:contexts", String(message.id));
    if (!result.ok) {
      notify(result.error || tr("无法恢复这次提问的引用。", "Could not restore the references for this prompt."));
      return;
    }
    const restoredContexts = (result.data || []).map((item) => ({
      label: String(item.label || ""),
      kind: String(item.kind || ""),
      content: String(item.content || ""),
      sourceId: String(item.sourceId || ""),
      ...(item.kind === "selection"
        ? { from: message.selection_from ?? null, to: message.selection_to ?? null }
        : {}),
    }));
    const storedStyleIds = (() => {
      try {
        const parsed = JSON.parse(String(message.style_ids_json || "[]"));
        return Array.isArray(parsed)
          ? [...new Set(parsed.map((id: unknown) => String(id || "").trim()).filter(Boolean))].slice(0, 6)
          : [];
      } catch {
        return message.style_id ? [String(message.style_id)] : [];
      }
    })();
    const branched = await api<{ conversationId: string }>("ai:conversation:branch", String(message.id));
    if (!branched.ok || !branched.data?.conversationId) {
      notify(branched.error || tr("创建对话分支失败，请稍后重试。", "Could not create a conversation branch. Please try again."));
      return;
    }
    const branchId = String(branched.data.conversationId);
    const loaded = await api("ai:session:loadConversation", branchId);
    if (!loaded.ok) {
      notify(loaded.error || tr("分支已创建，但暂时无法打开。", "The branch was created, but could not be opened."));
      return;
    }
    const currentSession = await api<AnyRow>("ai:session:get");
    if (currentSession.ok) {
      draftConvRef.current = branchId;
      draftVersionRef.current = Number(currentSession.data?.draftVersion || 0);
    }
    const task = tasks.find((item) => item.kind === message.task_kind);
    if (task) {
      setActiveTaskId(task.id || task.kind);
      setMode(task.kind as typeof mode);
    }
    let draftStyleIds: string[] | null = null;
    let styleRestoreNotice = "";
    if (message.task_kind && !["chat", "check"].includes(String(message.task_kind))) {
      const cardResult = await api<StyleCard[]>("ai:styles:list");
      if (cardResult.ok) {
        setStyleCards(cardResult.data || []);
        const available = new Set((cardResult.data || []).map((card) => card.id));
        const restorableIds = storedStyleIds.filter((id) => available.has(id));
        draftStyleIds = restorableIds;
        if (restorableIds.length < storedStyleIds.length) {
          styleRestoreNotice = tr("部分历史技法卡已不存在，分支中已恢复仍可用的卡片。", "Some original technique cards are no longer available; the remaining cards were restored in this branch.");
        }
      } else styleRestoreNotice = tr("技法组合未能自动恢复，请发送前检查分支风格。", "The original technique set could not be restored; review the branch style before sending.");
    }
    const saved = await saveComposerState(String(message.content || ""), restoredContexts, branchId, draftStyleIds);
    if (!saved.ok || saved.data?.accepted === false) {
      notify(saved.error || tr("恢复提问失败，请稍后重试。", "Could not restore the prompt. Please try again."));
      return;
    }
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('[data-fd-id="ai-input"]')?.focus();
    });
    setHistoryOpen(false);
    loadConversations({ offset: 0 });
    if (regenerate && styleRestoreNotice) {
      notify(tr(
        `原提问的部分技法卡不可用，已恢复可用卡片，但为避免改变原写作规则，本次未自动发送。请检查分支规则后手动发送。${styleRestoreNotice}`,
        `Some original technique cards are unavailable. The remaining cards were restored, but nothing was sent to avoid silently changing the writing rules. Review the branch and send manually. ${styleRestoreNotice}`,
      ));
      return;
    }
    if (regenerate) setPendingRegenerateConversation(branchId);
    notify(regenerate
      ? tr("已在新分支中按原问题与引用重新生成；原对话和回复均保留。", "Regenerating from the original prompt and references in a new branch; the source conversation and reply are preserved.")
      : tr(
          `已从此处创建分支，原对话保留；技法卡组合已作为分支专属设置恢复，不会更改作品默认风格。检查问题和引用后发送即可重试。${styleRestoreNotice ? ` ${styleRestoreNotice}` : ""}`,
          `A new branch was created; the original conversation is unchanged. Its technique cards are restored as branch-only settings and won't change the novel default. Review the prompt and references, then send to retry.${styleRestoreNotice ? ` ${styleRestoreNotice}` : ""}`,
        ));
  }
  const currentTitle =
    conversations.find((c) => c.id === conversation)?.title ||
    currentConversationTitle ||
    tr("新对话", "New conversation");
  const sessionTabs = useMemo(() => {
    const activeRow = conversations.find((row) => String(row.id) === conversation);
    const current = {
      id: conversation,
      title: String(activeRow?.title || currentTitle),
      generating: Boolean(activeRow?.generating || (conversation && generating)),
    };
    const recent = conversations
      .filter((row) => String(row.id || "") !== conversation && !row.archived_at)
      .slice(0, conversation ? 3 : 4)
      .map((row) => ({
        id: String(row.id),
        title: String(row.title || tr("未命名对话", "Untitled conversation")),
        generating: Boolean(row.generating),
      }));
    return [current, ...recent];
  }, [conversations, conversation, currentTitle, generating, language]);
  async function exportCurrentConversation() {
    const result = await api<{ file?: string }>("ai:conversation:export", conversation);
    if (!result.ok) {
      notify(result.error || tr("导出对话失败。", "Could not export this conversation."));
      return;
    }
    if (result.data?.file) notify(tr("对话已导出为 Markdown。", "Conversation exported as Markdown."));
  }
  async function toggleConversationPinned(id: string, pinned: boolean) {
    const result = await api("ai:conversation:pin", { id, pinned });
    if (!result.ok) {
      notify(result.error || tr("置顶状态更新失败。", "Could not update the pin state."));
      return false;
    }
    loadConversations({ offset: 0, search: historyQuery });
    return true;
  }
  async function toggleConversationArchived(id: string, archived: boolean) {
    const result = await api<{ archived: boolean }>("ai:conversation:archive", { id, archived });
    if (!result.ok) {
      notify(result.error || tr("归档状态更新失败。", "Could not update archive status."));
      return false;
    }
    if (id === conversation) setCurrentArchived(archived);
    loadConversations({ offset: 0, search: historyQuery, archived: historyArchived });
    notify(archived ? tr("对话已归档，可在「已归档」中恢复。", "Conversation archived. You can restore it from Archived.") : tr("对话已恢复。", "Conversation restored."));
    return true;
  }
  return (
    <div className={`zchat ${expanded ? "expanded" : ""}`} data-fd-id="ai-panel">
      <ChatToolbar
        title={currentTitle}
        language={language}
        float={float}
        canExpand={!float}
        expanded={expanded}
        canRenameDelete={Boolean(conversation)}
        canExport={Boolean(conversation && messages.length)}
        canArchive={Boolean(conversation && !generating && archiveStatusReady)}
        archived={currentArchived}
        dockSide={dockSide}
        hasProjectInstructions={Boolean(projectInstructions.trim())}
        onOpenProjectInstructions={() => {
          setProjectInstructionsDraft(projectInstructions);
          setProjectInstructionsOpen(true);
        }}
        generatingLabel={
          generating
            ? tr(
                `正在生成${generatingConvTitle ? `：${generatingConvTitle}` : ""}`,
                `Generating${generatingConvTitle ? `: ${generatingConvTitle}` : ""}`,
              )
            : null
        }
        onNew={() => selectConversation("")}
        onToggleHistory={() => {
          if (!historyOpen) loadConversations();
          setHistoryOpen((v) => !v);
        }}
        historyOpen={historyOpen}
        onToggleExpand={() => onToggleExpand?.(!expanded)}
        onRename={renameConversation}
        onExport={() => void exportCurrentConversation()}
        onToggleArchive={() => void toggleConversationArchived(conversation, !currentArchived)}
        onDockSideChange={(side) => onDockSideChange?.(side)}
        onDelete={deleteConversation}
        onOpenFloat={() => api("ai:float:open")}
        onCloseFloat={() => api("ai:float:close")}
      />
      {sessionTabs.length > 1 && (
        <nav className="zchat-session-tabs" aria-label={tr("最近对话", "Recent conversations")}>
          {sessionTabs.map((tab) => (
            <button
              key={tab.id || "new-conversation"}
              type="button"
              aria-current={tab.id === conversation ? "page" : undefined}
              aria-label={tab.generating
                ? `${tab.title} · ${tr("生成中", "Generating")}`
                : tab.title}
              className={`zchat-session-tab ${tab.id === conversation ? "active" : ""}`}
              title={tab.title}
              onClick={() => {
                setCurrentConversationTitle(tab.id ? tab.title : "");
                if (tab.id !== conversation) selectConversation(tab.id);
              }}
            >
              <span className={`zchat-session-tab-dot ${tab.generating ? "generating" : ""}`} aria-hidden="true" />
              <span className="zchat-ellipsis">{tab.title}</span>
            </button>
          ))}
        </nav>
      )}
      {!connections.length && (
        <div className="zchat-notice" data-fd-id="ai-no-connection">
          <p>{tr("尚未配置 AI 连接", "No AI connection configured")}</p>
          <small className="hint">
            {tr(
              "你仍然可以浏览历史对话与草稿；配置连接后即可发送。",
              "You can still browse history and drafts; configure a connection to send.",
            )}
          </small>
          {!float && onOpenSettings && (
            <button type="button" className="primary" onClick={onOpenSettings}>
              {tr("去配置 AI 连接", "Configure AI connection")}
            </button>
          )}
        </div>
      )}
      <MessageList
        messages={messagesForUi}
        hasEarlierMessages={Boolean(messageWindow.hasEarlier)}
        onLoadEarlier={loadEarlierMessages}
        language={language}
        conversationId={conversation}
        renderMarkdown={renderMarkdown}
        actionsFor={actionsFor}
        onOpenSource={previewMessageSource}
        onReusePrompt={(message) => void reusePrompt(message)}
        onRegeneratePrompt={(message) => void reusePrompt(message, true)}
        emptyState={
          <Empty
            title={tr("今天想写些什么？", "What would you like to write today?")}
            text={tr(
              "只有你明确添加的引用内容才会发送给 AI。先从一个方向开始。",
              "Only references you explicitly add are sent. Start with a direction.",
            )}
            action={
              <div className="zchat-suggestions">
                {prompts.slice(0, 4).map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => updateDraft(p.content, true)}
                  >
                    {promptNameFor(p.name, p.builtin, language)}
                  </button>
                ))}
              </div>
            }
          />
        }
      />
      <Composer
        language={language}
        float={float}
        refs={refsForUi}
        onRemoveRef={(i) => setContexts((xs) => xs.filter((_, j) => j !== i))}
        onPreviewRef={(i) => setRefPreview(refsForUi[i])}
        onOpenRefPicker={() => setPickerOpen(true)}
        tasks={tasks}
        promptTemplates={prompts as PromptTemplate[]}
        onSelectPromptTemplate={insertPromptTemplate}
        onManagePromptTemplates={onOpenSettings}
        activeTaskKind={mode}
        activeTaskId={activeTaskId}
        onSelectTask={(id) => {
          const task = tasks.find((t) => t.id === id);
          if (!task) return;
          if (task.attachChapter) addChapter();
          setActiveTaskId(id);
          setMode(task.kind as typeof mode);
          if (task?.draft) {
            const current = draftRef.current;
            const next = task.appendDraft && current.trim()
              ? `${current.replace(/\s+$/, "")}\n\n${task.draft}`
              : task.draft;
            updateDraft(next, true);
          }
        }}
        draft={draft}
        onDraftChange={(v) => updateDraft(v)}
        onSend={() => void send()}
        generating={generating}
        onStop={() => api("ai:cancel", requestId)}
        canSend={canSend}
        contextSummary={tr(
          `${fmt(displayedPayloadChars)} 字`,
          `${fmt(displayedPayloadChars)} chars`,
        )}
        contextPercent={contextPercent}
        contextExceeded={contextExceeded}
        contextLimitLabel={tr("/30万", "/300k")}
        sendHint={sendHint}
        sendStatusLine={sendStatusLine}
        onOpenContext={() => void openContext()}
        styleControl={
          <StyleCardPanel
            language={language}
            cards={styleCards}
            selectedIds={activeStyleIds}
            onSelectionChange={selectComposerStyles}
            styleIntensity={styleIntensity}
            onStyleIntensityChange={(intensity) => void selectStyleIntensity(intensity)}
            taskKind={mode}
            previewRules={stylePreviewRules}
            onReload={() => void reloadStyleCards()}
            compact
          />
        }
        autoRefNotice={
          mode === "continue"
            ? tr(
                `将自动引用「${chapterTitle || "当前章节"}」结尾（最多 4000 字）`,
                `Will auto-reference the end of "${chapterTitle || "this chapter"}" (max 4,000 chars)`,
              )
            : null
        }
        statusLine={(() => {
          const ds = session?.draftState;
          if (!ds || ds.status === "idle") return null;
          const label =
            ds.status === "saving"
              ? tr("草稿保存中…", "Saving draft…")
              : ds.status === "saved"
                ? tr("草稿已保存", "Draft saved")
                : tr(
                    `草稿保存失败：${ds.error || "未知错误"}`,
                    `Draft save failed: ${ds.error || "unknown"}`,
                  );
          return (
            <span
              className={`zchat-draft-state ${ds.status}`}
              role="status"
              aria-live="polite"
              title={label}
              data-fd-id="draft-state"
            >
              {label}
              {ds.status === "error" && (
                <button
                  type="button"
                  className="zchat-draft-retry"
                  data-fd-id="draft-retry"
                  onClick={() => updateDraft(draftRef.current, true)}
                >
                  {tr("重试", "Retry")}
                </button>
              )}
            </span>
          );
        })()}
      />
      {pickerOpen && (
        <RefPicker
          language={language}
          chapterId={chapterId}
          chapterTitle={chapterTitle}
          summary={chapter?.summary}
          bookChapters={bookChapters}
          libraryAll={libraryAll}
          suggestions={suggestions}
          selectedSources={contexts.map(({ kind, sourceId }) => ({ kind, sourceId }))}
          onAdd={handleAddFromPicker}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {historyOpen && (
        <HistoryDrawer
          language={language}
          novelTitle={String(novel.title || "")}
          conversations={conversations}
          currentId={conversation}
          query={historyQuery}
          loading={historyLoading}
          error={historyError}
          hasMore={historyHasMore}
          archivedMode={historyArchived}
          onArchivedModeChange={(archived) => {
            setHistoryArchived(archived);
            setConversations([]);
            setHistoryHasMore(false);
            loadConversations({ offset: 0, search: historyQuery, archived });
          }}
          onQuery={(q) => {
            setHistoryQuery(q);
            loadConversations({ search: q, offset: 0, archived: historyArchived });
          }}
          onNew={() => {
            selectConversation("");
            setHistoryOpen(false);
          }}
          onSelect={(id) => {
            setCurrentConversationTitle(String(conversations.find((row) => row.id === id)?.title || ""));
            selectConversation(id);
            setHistoryOpen(false);
          }}
          onCompare={(id) => {
            const sequence = ++compareRequestSeq.current;
            setHistoryOpen(false);
            setCompareLoading(true);
            void api<{ conversation: AnyRow; rows: AnyRow[] }>("ai:conversation:read", { novelId, conversationId: id })
              .then((result) => {
                if (sequence !== compareRequestSeq.current) return;
                if (!result.ok || !result.data) {
                  notify(result.error || tr("读取对照会话失败", "Could not load comparison conversation"));
                  return;
                }
                setCompareConversation({ ...result.data.conversation, messages: result.data.rows });
              })
              .finally(() => {
                if (sequence === compareRequestSeq.current) setCompareLoading(false);
              });
          }}
          onTogglePinned={toggleConversationPinned}
          onToggleArchived={toggleConversationArchived}
          onLoadMore={() =>
            loadConversations({
              offset: conversations.length,
              search: historyQuery,
              archived: historyArchived,
              append: true,
            })
          }
          onRetry={() => loadConversations({ search: historyQuery, offset: 0, archived: historyArchived })}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {(compareLoading || compareConversation) && (
        <Modal
          title={tr("对话对照阅读", "Conversation comparison")}
          className="zchat-compare-modal"
          close={() => {
            compareRequestSeq.current += 1;
            setCompareConversation(null);
            setCompareLoading(false);
          }}
        >
          {compareLoading ? (
            <p className="zchat-compare-state" role="status">{tr("正在读取对话…", "Loading conversation…")}</p>
          ) : compareConversation ? (
            <div className="zchat-compare-view" role="group" aria-label={tr("两个会话的只读对照", "Read-only comparison of two conversations")}>
              {[
                {
                  id: conversation || "current-draft",
                  title: currentTitle || tr("当前对话", "Current conversation"),
                  messages: messages.filter((message) => !message.streaming).slice(-120),
                },
                {
                  id: String(compareConversation.id || "comparison"),
                  title: String(compareConversation.title || tr("未命名对话", "Untitled conversation")),
                  messages: compareConversation.messages || [],
                },
              ].map((column, index) => (
                <section className="zchat-compare-column" key={column.id}>
                  <header className="zchat-compare-head">
                    <strong title={column.title}>{column.title}</strong>
                    <span>{index === 0 ? tr("当前会话", "Current") : tr("历史快照", "History snapshot")}</span>
                  </header>
                  <div className="zchat-compare-transcript" aria-label={tr(`${column.title}消息`, `${column.title} messages`)}>
                    {column.messages.map((message: AnyRow, messageIndex: number) => (
                      <article className={`zchat-compare-message ${message.role === "user" ? "user" : "assistant"}`} key={String(message.id || `${column.id}-${messageIndex}`)}>
                        <small>{message.role === "user" ? tr("你", "You") : tr("AI", "AI")}</small>
                        <MdView text={String(message.content || "")} />
                      </article>
                    ))}
                    {!column.messages.length && <p className="zchat-compare-state">{tr("此对话还没有消息。", "This conversation has no messages yet.")}</p>}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
        </Modal>
      )}
      {contextOpen && (
        <ContextDialog
          language={language}
          refs={refsForUi}
          historyChars={contextHistoryStats?.characterCount ?? historyChars}
          draftChars={draftChars}
          historyCount={contextHistoryStats?.messageCount ?? historyCount}
          historyStatsComplete={Boolean(contextHistoryStats) || !conversation}
          ruleChars={styleRuleChars}
          projectInstructionChars={Array.from(projectInstructions).length}
          estimateTokens={Math.ceil(displayedPayloadChars / 2)}
          payloadChars={payloadChars}
          contextLimitChars={contextLimitChars}
          previewMessages={previewMessages.length ? previewMessages : null}
          onClose={() => {
            contextStatsSeq.current += 1;
            setContextOpen(false);
          }}
        />
      )}
      {projectInstructionsOpen && createPortal(
        <Modal title={tr("作品 AI 指令", "Project AI instructions")} close={() => setProjectInstructionsOpen(false)}>
          <div className="zchat-project-instructions">
            <p className="hint">
              {tr(
                "这些要求会自动用于本作品后续 AI 请求，适合填写长期有效的设定边界、叙述视角、语言偏好和协作方式。单次任务和已确认作品事实优先。",
                "These instructions are added to future AI requests for this novel. Use them for lasting canon boundaries, point of view, voice, or collaboration preferences. The current task and confirmed story facts take priority.",
              )}
            </p>
            <textarea
              autoFocus
              data-fd-id="ai-project-instructions-input"
              aria-label={tr("作品 AI 指令", "Project AI instructions")}
              placeholder={tr("例如：采用第三人称限知视角；所有关键情节必须由人物行动推动；不替作者决定主线结局。", "Example: Use close third person; let character actions drive major plot turns; do not decide the main ending for the author.")}
              value={projectInstructionsDraft}
              maxLength={8000}
              rows={12}
              onChange={(event) => setProjectInstructionsDraft(event.target.value)}
            />
            <div className="zchat-project-instructions-foot">
              <small>{Array.from(projectInstructionsDraft).length.toLocaleString(language === "en" ? "en-US" : "zh-CN")} / 8,000</small>
              <span className="hint">{projectInstructions ? tr("已设置作品固定指令", "Project instructions are active") : tr("尚未设置作品固定指令", "No project instructions set")}</span>
            </div>
            <div className="row end">
              <button type="button" onClick={() => setProjectInstructionsOpen(false)} disabled={projectInstructionsSaving}>{tr("取消", "Cancel")}</button>
              <button type="button" className="primary" onClick={() => void saveProjectInstructions()} disabled={projectInstructionsSaving || Array.from(projectInstructionsDraft).length > 8000}>
                {projectInstructionsSaving ? tr("保存中…", "Saving…") : tr("保存指令", "Save instructions")}
              </button>
            </div>
          </div>
        </Modal>,
        document.body,
      )}
      {refPreview && (
        <Modal
          title={refPreview.label || tr("引用内容", "Reference content")}
          close={() => setRefPreview(null)}
        >
          <div className="zchat-ref-preview">
            <p className="hint">
              {kindNameFor(refPreview.kind, language as never)} ·{" "}
              {fmt(String(refPreview.content || "").length)}{" "}
              {tr("字", "chars")}
            </p>
            <pre>{refPreview.content}</pre>
            {["changed", "deleted", "missing"].includes(String(refPreview.sourceStatus || "")) && (
              <div className="zchat-source-stale" role="status">
                {refPreview.sourceStatus === "changed"
                  ? tr("生成后此资料已更新；上方内容是生成时保存的快照。", "This material has changed since generation; the text above is the saved snapshot.")
                  : refPreview.sourceStatus === "deleted"
                    ? tr("此资料已删除；上方内容是生成时保存的快照。", "This material was deleted; the text above is the saved snapshot.")
                    : tr("原始资料已不存在；上方内容是生成时保存的快照。", "The original material is missing; the text above is the saved snapshot.")}
              </div>
            )}
            {refPreview.sourceId && onNavigateSource && [
              "chapter", "selection", "summary", "continuation", "outline", "scene", "character", "world", "inspiration", "timeline", "foreshadow", "relation",
            ].includes(refPreview.kind) && (
              <button
                type="button"
                className="zchat-source-open"
                onClick={() => {
                  const source = { kind: String(refPreview.kind || ""), sourceId: String(refPreview.sourceId) };
                  setRefPreview(null);
                  onNavigateSource(source);
                }}
              >
                {tr("打开原始资料", "Open original source")}
              </button>
            )}
          </div>
        </Modal>
      )}
      {revisionApproval && (
        <ConfirmDialog
          title={tr("章节已更新", "Chapter changed")}
          message={tr(
            `这条回复基于「${revisionApproval.chapterTitle}」第 ${revisionApproval.sourceRevision} 版；当前正文已是第 ${revisionApproval.currentRevision} 版。请确认仍要把旧回复写入当前正文。`,
            `This reply was generated from “${revisionApproval.chapterTitle}” revision ${revisionApproval.sourceRevision}; the manuscript is now revision ${revisionApproval.currentRevision}. Confirm that you still want to apply the older reply.`,
          )}
          confirmLabel={tr("仍要采纳", "Apply anyway")}
          cancelLabel={tr("返回检查", "Review first")}
          onCancel={() => setRevisionApproval(null)}
          onConfirm={() => {
            const pending = revisionApproval;
            setRevisionApproval(null);
            pending.resume();
          }}
        />
      )}
      {sourceApproval && (
        <ConfirmDialog
          title={tr("引用资料已变化", "Referenced materials changed")}
          message={tr(
            `这条回复所依据的资料在生成后发生了变化：${sourceApproval.labels.join("、")}。请先查看来源快照；若仍要采纳，请确认。`,
            `Sources used for this reply changed after generation: ${sourceApproval.labels.join(", ")}. Review the saved snapshots; confirm only if you still want to adopt it.`,
          )}
          confirmLabel={tr("仍要采纳", "Apply anyway")}
          cancelLabel={tr("返回检查", "Review first")}
          onCancel={() => setSourceApproval(null)}
          onConfirm={() => {
            const pending = sourceApproval;
            setSourceApproval(null);
            pending.resume();
          }}
        />
      )}
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
            await apply("replace", msg.content, msg.source_revision, compare.original, msg.selection_from, msg.selection_to, msg.chapter_id, undefined, msg.source_message_id);
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
            await apply(mode, content, msg.source_revision, msg.selection_text || undefined, msg.selection_from, msg.selection_to, msg.chapter_id, undefined, msg.source_message_id);
          }}
          language={language}
        />
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
            if (r.ok) {
              setCurrentConversationTitle(title);
              loadConversations({ archived: historyArchived });
            }
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
    </div>
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
