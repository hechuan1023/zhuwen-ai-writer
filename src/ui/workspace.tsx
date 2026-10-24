import { AppBackdrop } from "./app-backdrop";
import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { api, fmt, time, tx, UiLanguage, Empty, Modal, ConfirmDialog, AnyRow, readerFonts, emptyDoc } from "./shared";
import { NovelEdit } from "./novel-edit";
import { DailyGoalMeter } from "./daily-goal";
import { WritingStatsCenter } from "./stats-center";
import { Select } from "./select";
import { applyReduceMotion } from "./motion";
import { buildEnvironment, WritingEnvironment } from "./presets";
import { patchAppearance } from "./prefs";

const AiPanel = lazy(() => import("./ai-panel").then((m) => ({ default: m.AiPanel })));
const LibraryPanel = lazy(() => import("./library-panel").then((m) => ({ default: m.LibraryPanel })));
const HistoryPanel = lazy(() => import("./history-panel").then((m) => ({ default: m.HistoryPanel })));
const TrashPanel = lazy(() => import("./trash-panel").then((m) => ({ default: m.TrashPanel })));
const IoPanel = lazy(() => import("./io-panel").then((m) => ({ default: m.IoPanel })));

const Settings = lazy(() =>
  import("./settings").then((m) => ({ default: m.Settings })),
);
const SummaryModal = lazy(() =>
  import("./summary-modal").then((m) => ({ default: m.SummaryModal })),
);

const bounded = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

function WorkspaceIcon({ name }: { name: "chapters" | "library" | "history" | "trash" }) {
  const paths = {
    chapters: <><path d="M8 6h11M8 12h11M8 18h11"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></>,
    library: <><path d="M5 4h13a1 1 0 0 1 1 1v15H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1Z"/><path d="M7 4v16M10 8h6"/></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4M12 7v5l3 2"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

const SelectionWordCount = memo(function SelectionWordCount({
  editor,
  language,
}: {
  editor: any;
  language: UiLanguage;
}) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!editor) {
      setCount(0);
      return;
    }
    const update = () => {
      try {
        const { from, to } = editor.state.selection;
        const selected =
          from === to ? "" : editor.state.doc.textBetween(from, to, "\n");
        setCount(
          Array.from(selected).filter((c) => !/\s/.test(c as string)).length,
        );
      } catch {
        setCount(0);
      }
    };
    update();
    editor.on("selectionUpdate", update);
    editor.on("update", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("update", update);
    };
  }, [editor]);
  if (count <= 0) return null;
  return (
    <span>
      {tx(language, "selectedWords")} {count} {tx(language, "words")}
    </span>
  );
});

export function Workspace({
  initial,
  onBack,
  notify,
  registerCloseGuard,
  onLanguageChange,
}: {
  initial: AnyRow;
  onBack: () => void;
  notify: (s: string) => void;
  registerCloseGuard: (guard: () => Promise<boolean>) => void;
  onLanguageChange: (language: UiLanguage) => void;
}) {
  const [novel, setNovel] = useState(initial),
    [volumes, setVolumes] = useState<AnyRow[]>([]),
    [chapters, setChapters] = useState<AnyRow[]>([]),
    [chapter, setChapter] = useState<AnyRow | null>(null);
  const [left, setLeft] = useState(true),
    [right, setRight] = useState(true),
    /** 主窗口内展开聊天区：会话/草稿/生成状态保留，仅改变宽度 */
    [aiExpanded, setAiExpanded] = useState(false),
    [focus, setFocus] = useState(false),
    [leftView, setLeftView] = useState<
      "chapters" | "library" | "history" | "trash"
    >("chapters"),
    [modal, setModal] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
      "saved" | "saving" | "dirty" | "error"
    >("saved"),
    [lastSavedAt, setLastSavedAt] = useState<string | null>(null),
    [chapterSearch, setChapterSearch] = useState(""),
    [findOpen, setFindOpen] = useState(false),
    [findText, setFindText] = useState(""),
    [replaceText, setReplaceText] = useState(""),
    [showReplace, setShowReplace] = useState(false),
    [matchCount, setMatchCount] = useState(0),
    [searchOpen, setSearchOpen] = useState(false),
    [bookQuery, setBookQuery] = useState(""),
    [bookResults, setBookResults] = useState<AnyRow[]>([]),
    [bookSearching, setBookSearching] = useState(false),
    [bookProgress, setBookProgress] = useState({ scanned: 0, total: 0, matches: 0 }),
    [statsOpen, setStatsOpen] = useState(false),
    [summaryOpen, setSummaryOpen] = useState(false),
    [ctxMenu, setCtxMenu] = useState<{
      type: "chapter" | "volume";
      id: string;
      title: string;
      x: number;
      y: number;
    } | null>(null),
    [titleModal, setTitleModal] = useState<{
      mode:
        | "create-chapter"
        | "rename-chapter"
        | "create-volume"
        | "rename-volume";
      id?: string;
      volumeId?: string;
      value: string;
    } | null>(null),
    [paletteOpen, setPaletteOpen] = useState(false),
    [batchMode, setBatchMode] = useState(false),
    [checkedIds, setCheckedIds] = useState<string[]>([]),
    [batchTarget, setBatchTarget] = useState(""),
    // 移入回收站前的待确认目标（章节 / 卷 / 批量章节）
    [pendingTrash, setPendingTrash] = useState<
      | { kind: "chapter"; id: string; title: string }
      | { kind: "volume"; id: string; title: string }
      | { kind: "chapters"; ids: string[] }
      | null
    >(null);
  const [theme, setTheme] = useState<"light" | "warm" | "dark">("warm"),
    [uiDensity, setUiDensity] = useState<"compact" | "comfortable">("compact"),
    [focusZen, setFocusZen] = useState(false),
    [leftWidth, setLeftWidth] = useState(292),
    [rightWidth, setRightWidth] = useState(380),
    [fontFamily, setFontFamily] = useState(readerFonts[0].value),
    [fontSize, setFontSize] = useState(17),
    [lineHeight, setLineHeight] = useState(1.7),
    [paraSpacing, setParaSpacing] = useState(0.25),
    [readingWidth, setReadingWidth] = useState(760),
    [firstLineIndent, setFirstLineIndent] = useState(true),
    [dailyGoal, setDailyGoal] = useState(0),
    [language, setLanguage] = useState<UiLanguage>("zh-CN"),
    [typewriterMode, setTypewriterMode] = useState(false),
    [editorZoom, setEditorZoom] = useState(1),
    [backgroundImage, setBackgroundImage] = useState(""),
    [backgroundName, setBackgroundName] = useState(""),
    [backgroundOpacity, setBackgroundOpacity] = useState(0.22),
    [backgroundBlur, setBackgroundBlur] = useState(0),
    [backgroundFit, setBackgroundFit] = useState<"cover" | "contain" | "tile">(
      "cover",
    ),
    [paperOpacity, setPaperOpacity] = useState(0.9),
    [panelOpacity, setPanelOpacity] = useState(0.72),
    [reduceTransparency, setReduceTransparency] = useState(false),
    [reduceMotion, setReduceMotion] = useState(false);
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const languageRef = useRef(language);
  languageRef.current = language;
  const dailyGoalRef = useRef(dailyGoal);
  dailyGoalRef.current = dailyGoal;
  const appearance = useRef({
    theme,
    uiDensity,
    focusZen,
    leftWidth,
    rightWidth,
    fontFamily,
    fontSize,
    lineHeight,
    paraSpacing,
    readingWidth,
    language,
    typewriterMode,
    editorZoom,
    backgroundImage,
    backgroundName,
    backgroundOpacity,
    backgroundBlur,
    backgroundFit,
    paperOpacity,
    panelOpacity,
    reduceTransparency,
    reduceMotion,
  });
  appearance.current = {
    theme,
    uiDensity,
    focusZen,
    leftWidth,
    rightWidth,
    fontFamily,
    fontSize,
    lineHeight,
    paraSpacing,
    readingWidth,
    language,
    typewriterMode,
    editorZoom,
    backgroundImage,
    backgroundName,
    backgroundOpacity,
    backgroundBlur,
    backgroundFit,
    paperOpacity,
    panelOpacity,
    reduceTransparency,
    reduceMotion,
  };
  const persistTimer = useRef<number | undefined>(undefined);
  const pendingAppearance = useRef<Partial<typeof appearance.current>>({});
  function flushPendingPreferences() {
    if (persistTimer.current) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = undefined;
      if (Object.keys(pendingAppearance.current).length) {
        api("preferences:set", {
          key: "appearance",
          value: { ...appearance.current, ...pendingAppearance.current },
        });
        pendingAppearance.current = {};
      }
    }
    if (goalTimer.current) {
      window.clearTimeout(goalTimer.current);
      goalTimer.current = undefined;
      api("preferences:set", {
        key: "writing",
        value: { dailyGoal: dailyGoalRef.current },
        merge: true,
      });
    }
  }
  const persistAppearance = (over: Partial<typeof appearance.current> = {}) => {
    if (envPreview) return; // 预览期间不落盘：防止预览值或混合状态被意外保存
    Object.assign(pendingAppearance.current, over);
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      api("preferences:set", {
        key: "appearance",
        value: { ...pendingAppearance.current },
        merge: true,
      });
      pendingAppearance.current = {};
    }, 350);
  };
  // ── 环境预览状态机 ──────────────────────────────────────────────
  // 预览：只改当前显示（envEffective 覆盖基础状态），不写任何持久化；
  // 应用：先持久化成功，再更新基础状态；取消：把基础状态还原为预览前快照。
  const [envPreview, setEnvPreview] = useState<WritingEnvironment | null>(null);
  const [envPreviewLabel, setEnvPreviewLabel] = useState<string | null>(null);
  const envOriginalRef = useRef<typeof appearance.current | null>(null);
  // 必须依赖真实 state，不能只依赖 envPreview（否则普通外观修改不刷新）
  const envBase = useMemo<AnyRow>(
    () => ({
      theme,
      uiDensity,
      focusZen,
      leftWidth,
      rightWidth,
      fontFamily,
      fontSize,
      lineHeight,
      paraSpacing,
      readingWidth,
      firstLineIndent,
      language,
      typewriterMode,
      editorZoom,
      backgroundImage,
      backgroundName,
      backgroundOpacity,
      backgroundBlur,
      backgroundFit,
      paperOpacity,
      panelOpacity,
      reduceTransparency,
      reduceMotion,
    }),
    [
      theme,
      uiDensity,
      focusZen,
      leftWidth,
      rightWidth,
      fontFamily,
      fontSize,
      lineHeight,
      paraSpacing,
      readingWidth,
      firstLineIndent,
      language,
      typewriterMode,
      editorZoom,
      backgroundImage,
      backgroundName,
      backgroundOpacity,
      backgroundBlur,
      backgroundFit,
      paperOpacity,
      panelOpacity,
      reduceTransparency,
      reduceMotion,
    ],
  );
  const envEffective = useMemo<AnyRow>(
    () => (envPreview ? { ...envBase, ...envPreview } : envBase),
    [envPreview, envBase],
  );
  function startEnvPreview(env: WritingEnvironment, label?: string) {
    flushPendingPreferences();
    if (!envOriginalRef.current) envOriginalRef.current = { ...appearance.current };
    setEnvPreview(env);
    setEnvPreviewLabel(label || null);
  }
  function applyEnvironmentToStates(env: WritingEnvironment) {
    if (env.theme === "light" || env.theme === "warm" || env.theme === "dark")
      setTheme(env.theme);
    setUiDensity(env.uiDensity);
    setFocusZen(env.focusZen);
    setFontFamily(env.fontFamily);
    setFontSize(env.fontSize);
    setLineHeight(env.lineHeight);
    setParaSpacing(env.paraSpacing);
    setReadingWidth(env.readingWidth);
    setTypewriterMode(env.typewriterMode);
    setEditorZoom(env.editorZoom);
    setBackgroundImage(env.backgroundImage);
    setBackgroundName(env.backgroundName);
    setBackgroundOpacity(env.backgroundOpacity);
    setBackgroundBlur(env.backgroundBlur);
    setBackgroundFit(env.backgroundFit as "cover" | "contain" | "tile");
    setPaperOpacity(env.paperOpacity);
    setPanelOpacity(env.panelOpacity);
    setReduceTransparency(env.reduceTransparency);
    if (env.leftWidth != null) setLeftWidth(env.leftWidth);
    if (env.rightWidth != null) setRightWidth(env.rightWidth);
  }
  async function applyEnvPreview(env: WritingEnvironment): Promise<boolean> {
    const r = await patchAppearance(env as AnyRow);
    if (!r.ok) {
      notify(r.error || tr("预设应用失败，设置未更改", "Could not apply preset; settings unchanged"));
      return false;
    }
    applyEnvironmentToStates(env);
    setEnvPreview(null);
    setEnvPreviewLabel(null);
    envOriginalRef.current = null;
    notify(tr("环境已应用", "Environment applied"));
    return true;
  }
  function cancelEnvPreview() {
    const orig = envOriginalRef.current;
    if (orig) applyEnvironmentToStates(orig as WritingEnvironment);
    setEnvPreview(null);
    setEnvPreviewLabel(null);
    envOriginalRef.current = null;
    notify(tr("已取消预览，恢复原设置", "Preview cancelled; previous settings restored"));
  }
  // 关闭设置时结束未确认的预览
  useEffect(() => {
    if (modal !== "settings" && envPreview) cancelEnvPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);
  function updateTypo(
    t: Partial<{
      fontFamily: string;
      fontSize: number;
      lineHeight: number;
      paraSpacing: number;
      readingWidth: number;
      firstLineIndent?: boolean;
    }>,
  ) {
    if (t.fontFamily !== undefined) setFontFamily(t.fontFamily);
    if (t.fontSize !== undefined) setFontSize(t.fontSize);
    if (t.lineHeight !== undefined) setLineHeight(t.lineHeight);
    if (t.paraSpacing !== undefined) setParaSpacing(t.paraSpacing);
    if (t.readingWidth !== undefined) setReadingWidth(t.readingWidth);
    if (t.firstLineIndent !== undefined)
      setFirstLineIndent(t.firstLineIndent);
    persistAppearance(t as any);
  }
  const dirty = useRef(false),
    timer = useRef<number | undefined>(undefined),
    composing = useRef(false),
    editVersion = useRef(0),
    saveInFlight = useRef<Promise<boolean> | null>(null),
    libraryDirtyRef = useRef(false),
    programmaticEdit = useRef(false),
    libraryControlsRef = useRef<{
      isDirty: () => boolean;
      requestLeave: () => Promise<boolean>;
      save: () => Promise<boolean>;
      discard: () => void;
    } | null>(null),
    searchRequest = useRef(""),
    chapterRef = useRef<AnyRow | null>(null),
    findNextRef = useRef<(term?: string) => void>(() => {}),
    centerLineRef = useRef<() => void>(() => {}),
    saveLatest = useRef<(force?: boolean) => Promise<boolean>>(
      async () => false,
    );
  const [today, setToday] = useState(0);
  const loadSeq = useRef(0);
  const load = useCallback(
    async (selectId?: string) => {
      const seq = ++loadSeq.current;
      const r = await api("novels:open", novel.id);
      if (!r.ok || seq !== loadSeq.current) return;
      setNovel(r.data.novel);
      setVolumes(r.data.volumes);
      setChapters(r.data.chapters);
      const id =
        selectId ||
        chapterRef.current?.id ||
        r.data.novel.last_chapter_id ||
        r.data.chapters[0]?.id;
      const meta =
        r.data.chapters.find((x: AnyRow) => x.id === id) ||
        r.data.chapters[0] ||
        null;
      if (!meta) {
        setChapter(null);
        chapterRef.current = null;
        return;
      }
      // 章节列表只含元数据，选中的章节再取整行（含正文 JSON）
      const full = await api("chapters:get", meta.id);
      if (seq !== loadSeq.current) return;
      const row = full.ok && full.data ? full.data : meta;
      setChapter(row);
      chapterRef.current = row;
    },
    [novel.id],
  );
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    api<any>("preferences:get", "appearance").then((r) => {
      if (r.ok && r.data) {
        if (["light", "warm", "dark"].includes(r.data.theme)) setTheme(r.data.theme);
        if (["compact", "comfortable"].includes(r.data.uiDensity))
          setUiDensity(r.data.uiDensity);
        if (typeof r.data.focusZen === "boolean") setFocusZen(r.data.focusZen);
        setLeftWidth(bounded(r.data.leftWidth, 260, 520, 292));
        setRightWidth(bounded(r.data.rightWidth, 300, 520, 380));
        if (readerFonts.some((font) => font.value === r.data.fontFamily))
          setFontFamily(r.data.fontFamily);
        setFontSize(bounded(r.data.fontSize, 14, 30, 17));
        setLineHeight(bounded(r.data.lineHeight, 1.4, 2.4, 1.7));
        setParaSpacing(bounded(r.data.paraSpacing, 0, 1.2, 0.25));
        setReadingWidth(bounded(r.data.readingWidth, 480, 1100, 760));
        setFirstLineIndent(r.data.firstLineIndent !== false);
        setParaSpacing(bounded(r.data.paraSpacing, 0, 2, 0.45));
        setReadingWidth(bounded(r.data.readingWidth, 480, 1100, 760));
        if (r.data.language === "en" || r.data.language === "zh-CN")
          setLanguage(r.data.language);
        if (typeof r.data.typewriterMode === "boolean")
          setTypewriterMode(r.data.typewriterMode);
        setEditorZoom(bounded(r.data.editorZoom, 0.7, 1.8, 1));
        if (typeof r.data.backgroundImage === "string" && r.data.backgroundImage.startsWith("data:image/"))
          setBackgroundImage(r.data.backgroundImage);
        if (typeof r.data.backgroundName === "string")
          setBackgroundName(r.data.backgroundName.slice(0, 260));
        setBackgroundOpacity(bounded(r.data.backgroundOpacity, 0, 0.8, 0.22));
        setBackgroundBlur(bounded(r.data.backgroundBlur, 0, 24, 0));
        if (["cover", "contain", "tile"].includes(r.data.backgroundFit))
          setBackgroundFit(r.data.backgroundFit);
        setPaperOpacity(bounded(r.data.paperOpacity, 0.45, 1, 0.9));
        setPanelOpacity(bounded(r.data.panelOpacity, 0.35, 1, 0.72));
        setReduceTransparency(Boolean(r.data.reduceTransparency));
        setReduceMotion(Boolean(r.data.reduceMotion));
      }
    });
    api<any>("preferences:get", "writing").then((r) => {
      if (r.ok && r.data && typeof r.data.dailyGoal === "number")
        setDailyGoal(Math.floor(bounded(r.data.dailyGoal, 0, 1000000, 0)));
    });
  }, []);
  useEffect(() => {
    document.documentElement.classList.remove(
      "theme-light",
      "theme-dark",
      "theme-warm",
    );
    document.documentElement.classList.add(`theme-${theme}`);
    document.documentElement.style.colorScheme =
      theme === "dark" ? "dark" : "light";
    document.documentElement.classList.toggle(
      "reduce-transparency",
      reduceTransparency,
    );
    // 与「减少透明效果」相互独立：只关动画，不影响材质
    applyReduceMotion(reduceMotion);
  }, [theme, reduceTransparency, reduceMotion]);
  useEffect(() => {
    const end = () => void api("writing:focusEnd");
    const onVis = () => {
      if (document.hidden) end();
    };
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", end);
    return () => {
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", end);
      end();
    };
  }, []);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 1180px)");
    const veryNarrow = window.matchMedia("(max-width: 920px)");
    const adapt = () => {
      if (narrow.matches) setRight(false);
      if (veryNarrow.matches) setLeft(false);
    };
    adapt();
    narrow.addEventListener("change", adapt);
    veryNarrow.addEventListener("change", adapt);
    return () => {
      narrow.removeEventListener("change", adapt);
      veryNarrow.removeEventListener("change", adapt);
    };
  }, []);
  useEffect(
    () =>
      window.zhuwen.onSearchProgress((progress) => {
        if (progress.requestId === searchRequest.current)
          setBookProgress(progress);
      }),
    [],
  );
  useEffect(() => {
    if (!novel?.id) return;
    api("ai:session:patch", {
      novelId: novel.id,
      chapter: chapter
        ? {
            id: chapter.id,
            title: chapter.title,
            plain_text: chapter.plain_text,
            revision: chapter.revision,
          }
        : null,
    });
  }, [novel?.id, chapter?.id, chapter?.title, chapter?.revision]);
  const selectionTimer = useRef<number | undefined>(undefined);
  const pushSelectionRef = useRef<(t: string) => void>(() => {});
  pushSelectionRef.current = (t: string) => {
    window.clearTimeout(selectionTimer.current);
    selectionTimer.current = window.setTimeout(
      () => api("ai:session:patch", { selectionText: t }),
      300,
    );
  };
  const goalTimer = useRef<number | undefined>(undefined);
  function updateWriting(goal: number) {
    const value = Math.floor(bounded(goal, 0, 1000000, 0));
    setDailyGoal(value);
    window.clearTimeout(goalTimer.current);
    goalTimer.current = window.setTimeout(() => {
      api("preferences:set", {
        key: "writing",
        value: { dailyGoal: value },
        merge: true,
      });
    }, 400);
  }
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: false,
          codeBlock: false,
          blockquote: false,
          horizontalRule: false,
        }),
        Placeholder.configure({
          placeholder: () =>
            languageRef.current === "en" ? "Start writing here…" : "从这里开始写作……",
        }),
      ],
      content: emptyDoc,
      editorProps: {
        attributes: { class: "manuscript", spellcheck: "false" },
        transformPastedHTML: (html) =>
          new DOMParser().parseFromString(html, "text/html").body.innerText,
        transformPastedText: (text) => text,
      },
      onUpdate: () => {
        if (composing.current) return;
        editVersion.current += 1;
        dirty.current = true;
        setSaveState("dirty");
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => saveLatest.current(), 1200);
        centerLineRef.current();
        // 程序化更新（AI 采纳/历史恢复等）不计时
        if (!programmaticEdit.current) {
          void api("writing:focusPing", {
            novelId: novel.id,
            chapterId: chapterRef.current?.id || null,
          });
        }
      },
      onSelectionUpdate: ({ editor }) => {
        const selected = editor.state.doc.textBetween(
          editor.state.selection.from,
          editor.state.selection.to,
          "\n",
        );
        pushSelectionRef.current(selected);
        centerLineRef.current();
      },
    },
    [],
  );
  useEffect(() => {
    if (editor) editor.view.dispatch(editor.state.tr);
  }, [editor, language]);
  centerLineRef.current = () => {
    if (!typewriterMode || !editor || composing.current) return;
    requestAnimationFrame(() => {
      const scroller = document.querySelector<HTMLElement>(".editor-scroll");
      if (!scroller) return;
      try {
        const caret = editor.view.coordsAtPos(editor.state.selection.head);
        const box = scroller.getBoundingClientRect();
        const delta = caret.top - (box.top + box.height / 2);
        if (Math.abs(delta) > 2) scroller.scrollTop += delta;
      } catch {}
    });
  };
  useEffect(() => {
    if (!editor || !chapter) return;
    let json = emptyDoc;
    try {
      json = JSON.parse(chapter.content_json);
    } catch {}
    editor.commands.setContent(json, { emitUpdate: false });
    editor.commands.setTextSelection(
      Math.min(chapter.cursor_pos || 0, editor.state.doc.content.size),
    );
    requestAnimationFrame(() => {
      const el = document.querySelector(".editor-scroll");
      if (el) el.scrollTop = chapter.scroll_pos || 0;
      centerLineRef.current();
    });
    dirty.current = false;
    setSaveState("saved");
  }, [editor, chapter?.id]);
  useEffect(() => {
    if (!editor) return;
    (editor.storage as any).zhuwen = {
      markProgrammatic: () => {
        programmaticEdit.current = true;
        window.setTimeout(() => {
          programmaticEdit.current = false;
        }, 0);
      },
    };
  }, [editor]);
  const save = useCallback(
    async (force = false) => {
      if (saveInFlight.current) {
        const previousSaved = await saveInFlight.current;
        if (!previousSaved) return false;
        if (!dirty.current) return true;
      }
      if (!editor || !chapterRef.current || (!dirty.current && !force))
        return true;
      if (composing.current && !force) return false;
      const target = chapterRef.current,
        targetId = target.id,
        version = editVersion.current;
      setSaveState("saving");
      const el = document.querySelector(".editor-scroll");
      const task = (async () => {
        const r = await api("chapters:save", {
          id: targetId,
          baseRevision: target.revision,
          content: editor.getJSON(),
          plainText: editor.getText({ blockSeparator: "\n" }),
          cursorPos: editor.state.selection.anchor,
          scrollPos: el?.scrollTop || 0,
          countPunctuation: true,
        });
        if (r.ok) {
          target.revision = r.data.revision;
          target.word_count = r.data.wordCount;
          target.updated_at = r.data.updatedAt;
          const unchanged =
            chapterRef.current?.id === targetId &&
            editVersion.current === version;
          dirty.current = !unchanged;
          setSaveState(unchanged ? "saved" : "dirty");
          if (unchanged) setLastSavedAt(r.data.updatedAt || new Date().toISOString());
          setChapters((xs) =>
            xs.map((x) => (x.id === targetId ? { ...x, ...target } : x)),
          );
          api<number>("writing:today", novel.id).then(
            (x) => x.ok && setToday(x.data),
          );
          return true;
        }
        setSaveState("error");
        notify(r.error || tr("保存失败，编辑内容仍保留在当前窗口", "Save failed; your edits remain in this window"));
        return false;
      })();
      saveInFlight.current = task;
      let saved = false;
      try {
        saved = await task;
      } catch (error) {
        setSaveState("error");
        notify(
          error instanceof Error
            ? tr(`保存失败：${error.message}`, `Save failed: ${error.message}`)
            : tr("保存失败，编辑内容仍保留在当前窗口", "Save failed; your edits remain in this window"),
        );
      } finally {
        if (saveInFlight.current === task) saveInFlight.current = null;
      }
      if (saved && force && dirty.current) return saveLatest.current(true);
      return saved;
    },
    [editor, notify, novel.id],
  );
  saveLatest.current = save;
  function collectMatches(term: string) {
    const out: { from: number; to: number }[] = [];
    if (!editor || !term) return out;
    const q = term.toLowerCase();
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text) {
        const t = node.text.toLowerCase();
        let i = t.indexOf(q);
        while (i !== -1) {
          out.push({ from: pos + i, to: pos + i + term.length });
          i = t.indexOf(q, i + q.length);
        }
      }
    });
    return out;
  }
  function findNext(term: string = findText) {
    if (!editor || !term) return;
    const matches = collectMatches(term);
    setMatchCount(matches.length);
    if (!matches.length) return notify(tr("本章未找到匹配内容", "No matches in this chapter"));
    const at = editor.state.selection.from;
    const next = matches.find((m) => m.from > at) || matches[0];
    editor.chain().focus().setTextSelection(next).run();
    editor.commands.scrollIntoView();
  }
  findNextRef.current = findNext;
  async function runBookSearch() {
    const query = bookQuery.trim();
    if (!query) {
      setBookResults([]);
      return;
    }
    if (searchRequest.current)
      await api("search:cancel", searchRequest.current);
    const requestId = crypto.randomUUID();
    searchRequest.current = requestId;
    setBookProgress({ scanned: 0, total: chapters.length, matches: 0 });
    setBookSearching(true);
    const r = await api<{ results: AnyRow[]; cancelled: boolean }>("search:novel", {
      novelId: novel.id,
      query,
      requestId,
    });
    if (searchRequest.current !== requestId) return;
    searchRequest.current = "";
    setBookSearching(false);
    if (r.ok) setBookResults(r.data.results);
    else notify(r.error || tr("搜索失败", "Search failed"));
  }
  async function closeBookSearch() {
    if (searchRequest.current) {
      await api("search:cancel", searchRequest.current);
      searchRequest.current = "";
      setBookSearching(false);
    }
    setSearchOpen(false);
  }
  async function openSearchResult(chapterId: string) {
    const target = chapters.find((c) => c.id === chapterId);
    if (!target) return;
    const query = bookQuery.trim();
    setSearchOpen(false);
    await switchChapter(target);
    setFindText(query);
    setReplaceText("");
    setShowReplace(false);
    setFindOpen(true);
    window.setTimeout(() => findNextRef.current(query), 350);
  }
  async function openStats() {
    setStatsOpen(true);
  }
  function replaceCurrent() {
    if (!editor || !findText) return;
    const { from, to } = editor.state.selection;
    const current = editor.state.doc.textBetween(from, to, "");
    if (current.toLowerCase() !== findText.toLowerCase()) return findNext();
    editor.chain().focus().insertContentAt({ from, to }, replaceText).run();
    findNext();
  }
  function replaceAll() {
    if (!editor || !findText) return;
    const matches = collectMatches(findText);
    if (!matches.length) return notify(tr("本章未找到匹配内容", "No matches in this chapter"));
    for (let i = matches.length - 1; i >= 0; i--)
      editor.chain().insertContentAt(matches[i], replaceText).run();
    notify(tr(`已替换 ${matches.length} 处`, `Replaced ${matches.length} matches`));
    setMatchCount(0);
  }
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save(true);
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFocus((x) => !x);
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowReplace(false);
        setFindOpen(true);
      }
      if (mod && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setShowReplace(true);
        setFindOpen(true);
      }
      if (e.key === "Escape") {
        if (pendingTrash) return setPendingTrash(null);
        if (paletteOpen) return setPaletteOpen(false);
        if (ctxMenu) return setCtxMenu(null);
        if (modal) return setModal(null);
        if (titleModal) return setTitleModal(null);
        if (searchOpen) return setSearchOpen(false);
        if (statsOpen) return setStatsOpen(false);
        if (summaryOpen) return setSummaryOpen(false);
        setFindOpen(false);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [
    save,
    paletteOpen,
    ctxMenu,
    modal,
    titleModal,
    pendingTrash,
    searchOpen,
    statsOpen,
    summaryOpen,
  ]);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (dirty.current) save(true);
    },
    [save],
  );
  useEffect(() => {
    const flush = () => {
      window.clearTimeout(timer.current);
      if (dirty.current) void saveLatest.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  useEffect(() => {
    api<number>("writing:today", novel.id).then(
      (x) => x.ok && setToday(x.data),
    );
  }, [novel.id]);
  useEffect(() => {
    registerCloseGuard(async () => {
      const leave = libraryControlsRef.current;
      if (leave?.isDirty()) {
        const ok = await leave.requestLeave();
        if (!ok) {
          notify(
            tr(
              "已取消关闭：资料库有未保存修改",
              "Close cancelled: unsaved story-bible changes",
            ),
          );
          return false;
        }
      }
      flushPendingPreferences();
      const saved = await saveLatest.current(true);
      if (!saved) notify(tr("关闭已取消：请先重新保存正文", "Close cancelled: save the manuscript first"));
      return saved;
    });
    return () => registerCloseGuard(async () => true);
  }, [registerCloseGuard, notify, language]);
  async function switchChapter(next: AnyRow) {
    if (next.id === chapter?.id) return;
    if (!(await save(true))) return;
    const full = await api("chapters:get", next.id);
    const row = full.ok && full.data ? full.data : next;
    setChapter(row);
    chapterRef.current = row;
    api("novels:update", { id: novel.id, last_chapter_id: row.id });
  }
  async function addChapter(volumeId?: string) {
    if (!(await save(true))) return;
    setTitleModal({ mode: "create-chapter", volumeId, value: tr("新建章节", "New chapter") });
  }
  async function addVolume() {
    setTitleModal({ mode: "create-volume", value: tr("第一卷", "Volume 1") });
  }
  async function submitTitleModal() {
    if (!titleModal) return;
    const value = titleModal.value.trim();
    if (!value) return notify(tr("名称不能为空", "Name is required"));
    const m = titleModal;
    setTitleModal(null);
    if (m.mode === "create-chapter") {
      const r = await api("chapters:create", {
        novelId: novel.id,
        volumeId: m.volumeId,
        title: value,
      });
      if (r.ok) load(r.data.id);
      else notify(r.error || tr("章节创建失败", "Could not create chapter"));
    } else if (m.mode === "create-volume") {
      const r = await api("volumes:create", { novelId: novel.id, title: value });
      if (r.ok) load();
      else notify(r.error || tr("卷创建失败", "Could not create volume"));
    } else if (m.mode === "rename-chapter") {
      const r = await api("chapters:updateMeta", { id: m.id, title: value });
      if (r.ok) load(m.id);
      else notify(r.error || tr("章节重命名失败", "Could not rename chapter"));
    } else {
      const r = await api("volumes:update", { id: m.id, title: value });
      if (r.ok) load();
      else notify(r.error || tr("卷重命名失败", "Could not rename volume"));
    }
  }
  async function menuAction(action: string) {
    const m = ctxMenu;
    if (!m) return;
    setCtxMenu(null);
    if (m.type === "chapter") {
      if (action === "rename")
        setTitleModal({ mode: "rename-chapter", id: m.id, value: m.title });
      else if (action === "duplicate") {
        const r = await api("chapters:duplicate", m.id);
        if (r.ok) load(r.data.id);
        else notify(r.error || tr("章节复制失败", "Could not duplicate chapter"));
      } else if (action === "trash") {
        setPendingTrash({ kind: "chapter", id: m.id, title: m.title });
      }
    } else if (action === "rename") {
      setTitleModal({ mode: "rename-volume", id: m.id, value: m.title });
    } else if (action === "trash") {
      setPendingTrash({ kind: "volume", id: m.id, title: m.title });
    }
  }
  async function dropChapter(
    dragId: string,
    volumeId: string | null,
    index: number,
  ) {
    const dragged = chapters.find((c) => c.id === dragId);
    if (!dragged) return;
    const groups = new Map<string | null, AnyRow[]>();
    groups.set(
      null,
      chapters.filter((c) => !c.volume_id && c.id !== dragId),
    );
    volumes.forEach((v) =>
      groups.set(
        v.id,
        chapters.filter((c) => c.volume_id === v.id && c.id !== dragId),
      ),
    );
    const target = groups.get(volumeId);
    if (!target) return;
    const at = Math.max(0, Math.min(index, target.length));
    target.splice(at, 0, { ...dragged, volume_id: volumeId });
    const ordered: AnyRow[] = [...groups.get(null)!];
    volumes.forEach((v) => ordered.push(...(groups.get(v.id) || [])));
    setChapters(ordered);
    if (chapterRef.current?.id === dragId) {
      chapterRef.current = { ...chapterRef.current, volume_id: volumeId };
      setChapter((c) =>
        c && c.id === dragId ? { ...c, volume_id: volumeId } : c,
      );
    }
    const r = await api("chapters:reorder", {
      items: ordered.map((c) => ({
        id: c.id,
        volumeId: c.volume_id || null,
      })),
    });
    if (!r.ok) {
      notify(r.error || tr("排序失败", "Reordering failed"));
      load();
    }
  }
  function resize(side: "left" | "right", e: React.MouseEvent) {
    e.preventDefault();
    const start = e.clientX,
      initial = side === "left" ? leftWidth : rightWidth;
    let last = initial;
    const move = (x: MouseEvent) => {
      const value = Math.max(
        side === "left" ? 260 : 300,
        Math.min(
          520,
          initial + (side === "left" ? x.clientX - start : start - x.clientX),
        ),
      );
      last = value;
      side === "left" ? setLeftWidth(value) : setRightWidth(value);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      persistAppearance(
        side === "left" ? { leftWidth: last } : { rightWidth: last },
      );
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }
  async function back() {
    const leave = libraryControlsRef.current;
    if (leave?.isDirty()) {
      const ok = await leave.requestLeave();
      if (!ok) return;
    }
    if (await save(true)) onBack();
  }
  const modKey = window.zhuwen.platform === "darwin" ? "⌘" : "Ctrl";
  const total = chapters.reduce((n, c) => n + (c.word_count || 0), 0);
  // 专注极简模式：鼠标移到窗口上/下边缘时显出顶栏/状态栏
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!focus || !focusZen || !el) return;
    const onMove = (e: MouseEvent) => {
      const height = el.clientHeight || window.innerHeight;
      el.classList.toggle("reveal-top", e.clientY <= 44);
      el.classList.toggle("reveal-bottom", e.clientY >= height - 40);
    };
    el.addEventListener("mousemove", onMove);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.classList.remove("reveal-top", "reveal-bottom");
    };
  }, [focus, focusZen]);
  const commands = useMemo(() => {
    const cmds: { label: string; hint?: string; run: () => void }[] = [
      {
        label: tr("新建章节", "New chapter"),
        run: () => addChapter(),
      },
      { label: tr("新建卷", "New volume"), run: addVolume },
      { label: tr("立即保存", "Save now"), hint: `${modKey}+S`, run: () => save(true) },
      {
        label: tr("章内查找", "Find in chapter"),
        hint: `${modKey}+F`,
        run: () => {
          setShowReplace(false);
          setFindOpen(true);
        },
      },
      { label: tr("全书查找", "Search book"), run: () => setSearchOpen(true) },
      { label: tr("写作统计", "Writing statistics"), run: openStats },
      { label: tr("章节摘要", "Chapter summary"), run: () => setSummaryOpen(true) },
      { label: tr("小说资料", "Novel information"), run: () => setModal("novel") },
      { label: tr("导入导出与备份", "Import, export & backup"), run: () => setModal("io") },
      { label: tr("打开设置", "Open settings"), run: () => setModal("settings") },
      {
        label: tr("切换主题", "Switch theme"),
        hint: theme,
        run: () => {
          const next =
            theme === "warm" ? "light" : theme === "light" ? "dark" : "warm";
          setTheme(next);
          persistAppearance({ theme: next });
        },
      },
      {
        label: focus ? tr("退出专注模式", "Exit focus mode") : tr("专注模式", "Focus mode"),
        hint: `${modKey}+Shift+F`,
        run: () => setFocus((x) => !x),
      },
      {
        label: typewriterMode ? tr("关闭打字机模式", "Disable typewriter mode") : tr("打字机模式", "Typewriter mode"),
        run: () => {
          const value = !typewriterMode;
          setTypewriterMode(value);
          persistAppearance({ typewriterMode: value });
          if (value) setTimeout(() => centerLineRef.current(), 50);
        },
      },
      {
        label: tr("历史版本", "History"),
        run: () => setLeftView("history"),
      },
      {
        label: tr("资料库", "Story Bible"),
        run: () => setLeftView("library"),
      },
      {
        label: tr("回收站", "Trash"),
        run: () => setLeftView("trash"),
      },
      {
        label: tr("AI 助手浮窗", "AI floating window"),
        run: () => api("ai:float:open"),
      },
      ...chapters.map((c) => ({
        label: tr(`切换到章节：${c.title}`, `Switch to chapter: ${c.title}`),
        hint: `${fmt(c.word_count)} ${tr("字", "words")}`,
        run: () => switchChapter(c),
      })),
    ];
    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chapters,
    theme,
    focus,
    typewriterMode,
    modKey,
    novel.id,
    save,
    editorZoom,
    language,
  ]);
  return (
    <div
      ref={rootRef}
      className={`workspace theme-${envEffective.theme} density-${envEffective.uiDensity} ${focus ? "focus" : ""} ${focus && envEffective.focusZen ? "focus-minimal" : ""} ${envEffective.typewriterMode ? "typewriter-on" : ""}${firstLineIndent === false || (envPreview && (envPreview as any).firstLineIndent === false) ? " no-indent" : ""}${envPreview ? " env-previewing" : ""}`}
      style={
        {
          "--reader-font": envEffective.fontFamily,
          "--reader-size": `${envEffective.fontSize}px`,
          "--reader-leading": String(envEffective.lineHeight ?? 1.7),
          "--reader-para": `${envEffective.paraSpacing ?? 0.25}em`,
          "--reader-width": `${envEffective.readingWidth}px`,
          "--editor-zoom": String(envEffective.editorZoom),
          "--writing-bg-opacity": String(envEffective.backgroundOpacity),
          "--writing-bg-blur": `${envEffective.backgroundBlur}px`,
          "--writing-paper-opacity": String(envEffective.paperOpacity),
        } as React.CSSProperties
      }
    >
      <AppBackdrop appearance={envEffective} />
      <header className="topbar" data-fd-id="workspace-topbar">
        <button className="topbar-back" onClick={back}>
          ← {tx(language, "shelf")}
        </button>
        <button
          className={`icon ${left ? "active" : ""}`}
          title={tr("切换章节栏", "Toggle chapter sidebar")}
          aria-label={tr("切换章节栏", "Toggle chapter sidebar")}
          onClick={() => setLeft((x) => !x)}
        >
          ☰
        </button>
        <div
          className="title"
          title={`${novel.title} / ${chapter?.title || tr("尚无章节", "No chapters")}`}
        >
          <strong>{novel.title}</strong>
          <i>/</i>
          <span>{chapter?.title || tr("尚无章节", "No chapters")}</span>
        </div>
        <div className="spacer" />
        <span className={`topbar-save ${saveState}`} role="status" aria-live="polite">
          {saveState === "saved"
            ? lastSavedAt
              ? `● ${tx(language, "saved")} ${time(lastSavedAt, language)}`
              : `● ${tx(language, "saved")}`
            : saveState === "saving"
              ? `◌ ${tx(language, "saving")}`
              : saveState === "dirty"
                ? `● ${tx(language, "unsaved")}`
                : `! ${tx(language, "saveFailed")}`}
        </span>
        <button
          className="icon"
          title={tx(language, "searchBook")}
          aria-label={tx(language, "searchBook")}
          onClick={() => setSearchOpen(true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        </button>
        <button
          className={focus ? "active" : ""}
          title={tr(`进入沉浸写作，只保留正文与状态栏（${modKey}+Shift+F）`, `Enter distraction-free writing with only the manuscript and status bar (${modKey}+Shift+F)`)}
          onClick={() => setFocus((x) => !x)}
        >
          {focus ? tx(language, "exitFocus") : tx(language, "focus")}
        </button>
        <button
          className={`topbar-ai ${right ? "active" : ""}`}
          aria-pressed={right}
          onClick={() => {
            setRight((value) => !value);
          }}
        >
          {tx(language, "assistant")}
        </button>
        <details className="toolbar-more">
          <summary title={tx(language, "more")} aria-label={tx(language, "more")}>•••</summary>
          <div
            className="toolbar-menu"
            onClick={(event) => {
              const details = event.currentTarget.parentElement;
              if (details instanceof HTMLDetailsElement) details.open = false;
            }}
          >
            <button onClick={() => setSummaryOpen(true)}>
              {tx(language, "summary")}
            </button>
            <button onClick={() => setModal("novel")}>{tx(language, "novelInfo")}</button>
            <button onClick={openStats}>{tx(language, "statistics")}</button>
            <button onClick={() => setModal("io")}>{tx(language, "transfer")}</button>
            <button onClick={() => setModal("settings")}>
              {tx(language, "settings")}
            </button>
          </div>
        </details>
      </header>
      <div className="workbody">
        {left && !focus && (
          <aside
            className={`left-panel left-view-${leftView}`}
            style={{ width: envEffective.leftWidth ?? leftWidth }}
            data-fd-id="workspace-left-panel"
          >
            <nav
              className="workspace-rail"
              aria-label={tr("小说工具", "Novel tools")}
              data-fd-id="workspace-tool-rail"
            >
              <button
                data-view="chapters"
                className={leftView === "chapters" ? "active" : ""}
                title={tx(language, "chapters")}
                aria-label={tx(language, "chapters")}
                onClick={async () => {
                  if (leftView === "library" && libraryControlsRef.current?.isDirty()) {
                    const ok = await libraryControlsRef.current.requestLeave();
                    if (!ok) return;
                  }
                  setLeftView("chapters");
                }}
              >
                <WorkspaceIcon name="chapters" />
              </button>
              <button
                data-view="library"
                className={leftView === "library" ? "active" : ""}
                title={tx(language, "library")}
                aria-label={tx(language, "library")}
                onClick={async () => {
                  if (leftView !== "library" && libraryControlsRef.current?.isDirty()) {
                    const ok = await libraryControlsRef.current.requestLeave();
                    if (!ok) return;
                  }
                  setLeftView("library");
                  if (leftWidth < 340) {
                    setLeftWidth(340);
                    persistAppearance({ leftWidth: 340 });
                  }
                }}
              >
                <WorkspaceIcon name="library" />
              </button>
              <button
                data-view="history"
                className={leftView === "history" ? "active" : ""}
                title={tx(language, "history")}
                aria-label={tx(language, "history")}
                onClick={async () => {
                  if (leftView === "library" && libraryControlsRef.current?.isDirty()) {
                    const ok = await libraryControlsRef.current.requestLeave();
                    if (!ok) return;
                  }
                  setLeftView("history");
                }}
              >
                <WorkspaceIcon name="history" />
              </button>
              <span />
              <button
                data-view="trash"
                className={leftView === "trash" ? "active" : ""}
                title={tx(language, "trash")}
                aria-label={tx(language, "trash")}
                onClick={async () => {
                  if (leftView === "library" && libraryControlsRef.current?.isDirty()) {
                    const ok = await libraryControlsRef.current.requestLeave();
                    if (!ok) return;
                  }
                  setLeftView("trash");
                }}
              >
                <WorkspaceIcon name="trash" />
              </button>
            </nav>
            <div className="left-pane">
              {leftView === "chapters" && (
                <>
                  <div className="panel-head compact-head">
                    <strong>{tx(language, "chapters")}</strong>
                    <div>
                      <button
                        className={batchMode ? "active" : ""}
                        title={tr("批量选择章节，可移动到其他卷或批量删除", "Batch-select chapters to move or delete")}
                        onClick={() => {
                          setBatchMode((x) => !x);
                          setCheckedIds([]);
                          setBatchTarget("");
                        }}
                      >
                        {batchMode ? tr("退出批量", "Exit batch") : tr("批量", "Batch")}
                      </button>
                      <button title={tx(language, "newVolume")} onClick={addVolume}>
                        {tr("＋卷", "+ Volume")}
                      </button>
                      <button title={tx(language, "newChapter")} onClick={() => addChapter()}>
                        {tr("＋章", "+ Chapter")}
                      </button>
                    </div>
                  </div>
            <input
              className="search"
              placeholder={tx(language, "searchChapter")}
              value={chapterSearch}
              onChange={(e) => setChapterSearch(e.target.value)}
            />
            <div className="chapter-tree">
              <Section
                title={tr("未分卷", "Unfiled")}
                volumeId={null}
                rows={chapters.filter((c) => !c.volume_id)}
                current={chapter?.id}
                search={chapterSearch}
                onSelect={switchChapter}
                onAdd={() => addChapter()}
                onMenu={(c, e) =>
                  setCtxMenu({
                    type: "chapter",
                    id: c.id,
                    title: c.title,
                    x: e.clientX,
                    y: e.clientY,
                  })
                }
                onDropChapter={dropChapter}
                language={language}
                batch={batchMode}
                checked={checkedIds}
                onToggle={(id) =>
                  setCheckedIds((xs) =>
                    xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id],
                  )
                }
              />
              {volumes.map((v) => (
                <Section
                  key={v.id}
                  volumeId={v.id}
                  title={v.title}
                  rows={chapters.filter((c) => c.volume_id === v.id)}
                  current={chapter?.id}
                  search={chapterSearch}
                  onSelect={switchChapter}
                  onAdd={() => addChapter(v.id)}
                  onMenu={(c, e) =>
                    setCtxMenu({
                      type: "chapter",
                      id: c.id,
                      title: c.title,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }
                  onDropChapter={dropChapter}
                  language={language}
                  batch={batchMode}
                  checked={checkedIds}
                  onToggle={(id) =>
                    setCheckedIds((xs) =>
                      xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id],
                    )
                  }
                  onVolumeMenu={(e) =>
                    setCtxMenu({
                      type: "volume",
                      id: v.id,
                      title: v.title,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }
                />
              ))}
                  </div>
                  {batchMode && (
                    <div className="batch-bar">
                      <span className="hint">
                        {tr(`已选 ${checkedIds.length} 章`, `${checkedIds.length} selected`)}
                      </span>
                      <button
                        onClick={() =>
                          setCheckedIds(
                            checkedIds.length >= chapters.length
                              ? []
                              : chapters.map((c) => c.id),
                          )
                        }
                      >
                        {checkedIds.length >= chapters.length
                          ? tr("全不选", "Deselect all")
                          : tr("全选", "Select all")}
                      </button>
                      <Select
                        size="compact"
                        value={batchTarget}
                        aria-label={tr("移动到目标卷", "Move to volume")}
                        placeholder={tr("移动到…", "Move to…")}
                        onValueChange={setBatchTarget}
                        options={[
                          { value: "", label: tr("移动到…", "Move to…") },
                          { value: "none", label: tr("未分卷", "Unfiled") },
                          ...volumes.map((v) => ({
                            value: v.id as string,
                            label: v.title as string,
                          })),
                        ]}
                      />
                      <button
                        disabled={!batchTarget || !checkedIds.length}
                        onClick={async () => {
                          const r = await api("chapters:batchMove", {
                            ids: checkedIds,
                            volumeId:
                              batchTarget === "none" ? null : batchTarget,
                          });
                          if (r.ok) {
                            notify(tr(`已移动 ${r.data} 章`, `Moved ${r.data} chapters`));
                            setCheckedIds([]);
                            setBatchTarget("");
                            load(chapter?.id);
                          } else notify(r.error || tr("移动失败", "Move failed"));
                        }}
                      >
                        {tr("移动", "Move")}
                      </button>
                      <button
                        className="danger-text"
                        disabled={!checkedIds.length}
                        onClick={() =>
                          setPendingTrash({ kind: "chapters", ids: checkedIds })
                        }
                      >
                        {tr("删除", "Delete")}
                      </button>
                    </div>
                  )}
                </>
              )}
              {leftView === "library" && (
                <Suspense fallback={<Empty title={tr("正在载入资料库", "Loading story bible")} text={tr("请稍候……", "Please wait…")} />}>
                  <LibraryPanel
                    novel={novel}
                    chapter={chapter}
                    chapters={chapters}
                    volumes={volumes}
                    onSelectChapter={(targetChapter) => void switchChapter(targetChapter)}
                    notify={notify}
                    language={language}
                    onDirtyChange={(d) => {
                      libraryDirtyRef.current = d;
                    }}
                    onControls={(c) => {
                      libraryControlsRef.current = c;
                    }}
                  />
                </Suspense>
              )}
              {leftView === "history" && (
                <Suspense fallback={<Empty title={tr("正在载入历史", "Loading history")} text={tr("请稍候……", "Please wait…")} />}>
                  <HistoryPanel chapter={chapter} reload={() => load(chapter?.id)} notify={notify} language={language} />
                </Suspense>
              )}
              {leftView === "trash" && (
                <Suspense fallback={<Empty title={tr("正在载入回收站", "Loading Trash")} text={tr("请稍候……", "Please wait…")} />}>
                  <TrashPanel novel={novel} reload={load} notify={notify} language={language} />
                </Suspense>
              )}
            </div>
            <div
              className="resizer right-edge"
              onMouseDown={(e) => resize("left", e)}
            />
          </aside>
        )}
        <main
          className={`editor-area ${envEffective.backgroundImage ? "has-writing-bg" : ""}`}
          data-fd-id="workspace-editor"
        >
          {chapter ? (
            <>
              <div className="chapter-title">
                <input
                  value={chapter.title}
                  onChange={(e) => {
                    const title = e.target.value;
                    setChapter({ ...chapter, title });
                    chapterRef.current = { ...chapterRef.current!, title };
                    setChapters((xs) =>
                      xs.map((x) =>
                        x.id === chapter.id ? { ...x, title } : x,
                      ),
                    );
                  }}
                  onBlur={async () => {
                    const r = await api("chapters:updateMeta", {
                      id: chapter.id,
                      title: chapter.title,
                    });
                    if (!r.ok) notify(r.error || tr("章节标题保存失败", "Could not save chapter title"));
                  }}
                />
                <Select
                  size="compact"
                  value={chapter.status || "draft"}
                  aria-label={tr("章节状态", "Chapter status")}
                  onValueChange={async (status) => {
                    const r = await api("chapters:updateMeta", {
                      id: chapter.id,
                      status,
                    });
                    if (r.ok) load(chapter.id);
                    else notify(r.error || tr("章节状态保存失败", "Could not save chapter status"));
                  }}
                  options={[
                    { value: "draft", label: tr("草稿", "Draft") },
                    { value: "review", label: tr("待修改", "Needs revision") },
                    { value: "done", label: tr("已完成", "Complete") },
                  ]}
                />
              </div>
              {findOpen && (
                <div className="find-bar">
                  <input
                    autoFocus
                    placeholder={tr("查找本章", "Find in chapter")}
                    value={findText}
                    onChange={(e) => setFindText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        findNext();
                      }
                    }}
                  />
                  {showReplace && (
                    <input
                      placeholder={tr("替换为", "Replace with")}
                      value={replaceText}
                      onChange={(e) => setReplaceText(e.target.value)}
                    />
                  )}
                  <button onClick={() => findNext()}>{tr("下一个", "Next")}</button>
                  {showReplace && (
                    <>
                      <button onClick={replaceCurrent}>{tr("替换", "Replace")}</button>
                      <button onClick={replaceAll}>{tr("全部替换", "Replace all")}</button>
                    </>
                  )}
                  {matchCount > 0 && (
                    <span className="find-info">{tr(`${matchCount} 处`, `${matchCount} matches`)}</span>
                  )}
                  <button
                    className="icon"
                    title={tr("关闭", "Close")}
                    onClick={() => setFindOpen(false)}
                  >
                    ×
                  </button>
                </div>
              )}
              <div
                className="editor-scroll"
                onScroll={(e) => {
                  if (chapterRef.current)
                    chapterRef.current.scroll_pos = e.currentTarget.scrollTop;
                }}
              >
                <EditorContent
                  editor={editor}
                  onCompositionStart={() => {
                    composing.current = true;
                    window.clearTimeout(timer.current);
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                    editVersion.current += 1;
                    dirty.current = true;
                    setSaveState("dirty");
                    timer.current = window.setTimeout(() => save(), 1200);
                    centerLineRef.current();
                  }}
                />
              </div>
            </>
          ) : (
            <Empty
              title={tr("还没有章节", "No chapters yet")}
              text={tr("新建章节后即可开始写作。", "Create a chapter to start writing.")}
              action={
                <button className="primary" onClick={() => addChapter()}>
                  {tr("新建章节", "New chapter")}
                </button>
              }
            />
          )}
          <footer className="status" data-fd-id="workspace-statusbar">
            <span className={`save ${saveState}`} role="status" aria-live="polite">
              {saveState === "saved"
                ? `● ${tx(language, "saved")}`
                : saveState === "saving"
                  ? `◌ ${tx(language, "saving")}`
                  : saveState === "dirty"
                    ? `● ${tx(language, "unsaved")}`
                    : `! ${tx(language, "saveFailed")}`}
            </span>
            {saveState === "error" && (
              <button onClick={() => save(true)}>{tr("重新保存", "Save again")}</button>
            )}
            {/* 整合字数：避免本章/全书/今日数字三处重复 */}
            <span className="status-words" title={tr("本章 / 全书字数", "Chapter / book words")}>
              {tr("本章", "Ch")} {fmt(chapter?.word_count || 0)}
              {" · "}
              {tr("全书", "Book")} {fmt(total)}
              {today !== 0 && (
                <>
                  {" · "}
                  {tr("今日", "Today")} {today > 0 ? "+" : ""}
                  {fmt(today)}
                </>
              )}
            </span>
            <SelectionWordCount editor={editor} language={language} />
            <DailyGoalMeter
              today={today}
              dailyGoal={dailyGoal}
              language={language}
              scope={novel.id}
              compact
              onOpenStats={openStats}
            />
            <div className="status-tools">
              <button
                className={typewriterMode ? "active" : ""}
                title={tr("打字机模式：当前输入行保持在编辑区中央", "Typewriter mode: keep the active line centered")}
                onClick={() => {
                  const value = !typewriterMode;
                  setTypewriterMode(value);
                  persistAppearance({ typewriterMode: value });
                  if (value) setTimeout(() => centerLineRef.current(), 50);
                }}
              >
                {tx(language, "typewriter")}
              </button>
              <div className="status-zoom" title={tr("编辑区缩放", "Editor zoom")}>
                <button
                  aria-label={tr("缩小编辑区", "Zoom out editor")}
                  onClick={() => {
                    const value = Math.max(
                      0.7,
                      Math.round((editorZoom - 0.1) * 10) / 10,
                    );
                    setEditorZoom(value);
                    persistAppearance({ editorZoom: value });
                  }}
                >
                  −
                </button>
                <span>{Math.round(editorZoom * 100)}%</span>
                <button
                  aria-label={tr("放大编辑区", "Zoom in editor")}
                  onClick={() => {
                    const value = Math.min(
                      1.8,
                      Math.round((editorZoom + 0.1) * 10) / 10,
                    );
                    setEditorZoom(value);
                    persistAppearance({ editorZoom: value });
                  }}
                >
                  ＋
                </button>
              </div>
            </div>
          </footer>
        </main>
        {right && !focus && (
          <aside
            className="right-panel"
            style={{ width: aiExpanded ? "min(72vw, 900px)" : (envEffective.rightWidth ?? rightWidth) }}
            data-fd-id="workspace-ai-panel"
          >
            <div
              className="resizer left-edge"
              onMouseDown={(e) => resize("right", e)}
            />
            <Suspense fallback={<Empty title={tr("正在载入助手", "Loading assistant")} text={tr("请稍候……", "Please wait…")} />}>
              <AiPanel
                novel={novel}
                chapter={chapter}
                editor={editor}
                save={save}
                notify={notify}
                language={language}
                expanded={aiExpanded}
                onToggleExpand={setAiExpanded}
              />
            </Suspense>
            <button
              className="collapse-right"
              title={tr("收起侧栏", "Collapse sidebar")}
              onClick={() => setRight(false)}
            >
              ›
            </button>
          </aside>
        )}
      </div>
      {ctxMenu && (
        <>
          <div className="menu-overlay" onMouseDown={() => setCtxMenu(null)} />
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <button onClick={() => menuAction("rename")}>{tr("重命名", "Rename")}</button>
            {ctxMenu.type === "chapter" && (
              <button onClick={() => menuAction("duplicate")}>{tr("复制章节", "Duplicate chapter")}</button>
            )}
            <button
              className="danger-text"
              onClick={() => menuAction("trash")}
            >
              {ctxMenu.type === "chapter" ? tr("移入回收站", "Move to Trash") : tr("删除卷", "Delete volume")}
            </button>
          </div>
        </>
      )}
      {titleModal && (
        <Modal
          title={
            titleModal.mode === "create-chapter"
              ? tr("新建章节", "New chapter")
              : titleModal.mode === "rename-chapter"
                ? tr("重命名章节", "Rename chapter")
                : titleModal.mode === "create-volume"
                  ? tr("新建卷", "New volume")
                  : tr("重命名卷", "Rename volume")
          }
          close={() => setTitleModal(null)}
        >
          <div className="title-modal">
            <input
              autoFocus
              value={titleModal.value}
              onChange={(e) =>
                setTitleModal({ ...titleModal, value: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submitTitleModal();
                }
              }}
            />
            <div className="row end">
              <button onClick={() => setTitleModal(null)}>{tr("取消", "Cancel")}</button>
              <button className="primary" onClick={submitTitleModal}>
                {tr("确定", "OK")}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {pendingTrash && (
        <ConfirmDialog
          title={tr("移入回收站", "Move to Trash")}
          message={
            pendingTrash.kind === "chapter"
              ? tr(
                  `将“${pendingTrash.title}”移入回收站？`,
                  `Move “${pendingTrash.title}” to Trash?`,
                )
              : pendingTrash.kind === "volume"
                ? tr(
                    `删除卷“${pendingTrash.title}”？卷内章节会一并移入回收站，可在回收站恢复。`,
                    `Delete volume “${pendingTrash.title}”? Its chapters will also move to Trash and can be restored.`,
                  )
                : tr(
                    `将选中的 ${pendingTrash.ids.length} 章移入回收站？`,
                    `Move ${pendingTrash.ids.length} selected chapters to trash?`,
                  )
          }
          confirmLabel={tr("移入回收站", "Move to Trash")}
          cancelLabel={tr("取消", "Cancel")}
          danger
          onCancel={() => setPendingTrash(null)}
          onConfirm={async () => {
            const target = pendingTrash;
            if (!target) return;
            setPendingTrash(null);
            if (target.kind === "chapter") {
              if (target.id === chapter?.id && !(await save(true))) return;
              const r = await api("chapters:trash", target.id);
              if (r.ok) load();
              else
                notify(
                  r.error ||
                    tr("章节删除失败", "Could not move chapter to Trash"),
                );
            } else if (target.kind === "volume") {
              const r = await api("volumes:trash", target.id);
              if (r.ok) load();
              else notify(r.error || tr("卷删除失败", "Could not delete volume"));
            } else {
              if (chapter && target.ids.includes(chapter.id)) await save(true);
              const r = await api("chapters:batchTrash", { ids: target.ids });
              if (r.ok) {
                notify(
                  tr(
                    `已移入回收站 ${r.data} 章`,
                    `${r.data} chapters moved to trash`,
                  ),
                );
                setCheckedIds([]);
                load();
              } else notify(r.error || tr("删除失败", "Delete failed"));
            }
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          commands={commands}
          close={() => setPaletteOpen(false)}
          language={language}
        />
      )}
      {modal === "settings" && (
        <Modal title={tr("设置", "Settings")} close={() => setModal(null)}>
          <Suspense fallback={null}>
          <Settings
            notify={notify}
            typography={{
              fontFamily: envEffective.fontFamily,
              fontSize: envEffective.fontSize,
              lineHeight: envEffective.lineHeight,
              paraSpacing: envEffective.paraSpacing,
              readingWidth: envEffective.readingWidth,
            }}
            onChangeTypography={updateTypo}
            dailyGoal={dailyGoal}
            onDailyGoal={updateWriting}
            language={language}
            presetProps={{
              environment: buildEnvironment(
                envEffective,
                envEffective,
                { leftWidth: envEffective.leftWidth, rightWidth: envEffective.rightWidth },
                true,
              ),
              previewing: Boolean(envPreview),
              previewLabel: envPreviewLabel,
              onPreview: startEnvPreview,
              onApply: applyEnvPreview,
              onCancelPreview: cancelEnvPreview,
            }}
            onLanguage={(value) => {
              setLanguage(value);
              onLanguageChange(value);
              persistAppearance({ language: value });
            }}
            personalization={{
              theme: envEffective.theme,
              uiDensity: envEffective.uiDensity,
              focusZen: envEffective.focusZen,
              typewriterMode: envEffective.typewriterMode,
              editorZoom: envEffective.editorZoom,
              backgroundImage: envEffective.backgroundImage,
              backgroundName: envEffective.backgroundName,
              backgroundOpacity: envEffective.backgroundOpacity,
              backgroundBlur: envEffective.backgroundBlur,
              backgroundFit: envEffective.backgroundFit,
              paperOpacity: envEffective.paperOpacity,
              panelOpacity: envEffective.panelOpacity,
              reduceTransparency: envEffective.reduceTransparency,
              reduceMotion: envEffective.reduceMotion,
            }}
            onPersonalization={(next) => {
              if (next.theme !== undefined) setTheme(next.theme);
              if (next.uiDensity !== undefined) setUiDensity(next.uiDensity);
              if (next.focusZen !== undefined) setFocusZen(next.focusZen);
              if (next.typewriterMode !== undefined)
                setTypewriterMode(next.typewriterMode);
              if (next.editorZoom !== undefined) setEditorZoom(next.editorZoom);
              if (next.backgroundImage !== undefined)
                setBackgroundImage(next.backgroundImage);
              if (next.backgroundName !== undefined)
                setBackgroundName(next.backgroundName);
              if (next.backgroundOpacity !== undefined)
                setBackgroundOpacity(next.backgroundOpacity);
              if (next.backgroundBlur !== undefined)
                setBackgroundBlur(next.backgroundBlur);
              if (next.backgroundFit !== undefined)
                setBackgroundFit(next.backgroundFit);
              if (next.panelOpacity !== undefined) setPanelOpacity(next.panelOpacity);
              if (next.paperOpacity !== undefined)
                setPaperOpacity(next.paperOpacity);
              if ((next as any).reduceTransparency !== undefined)
                setReduceTransparency(Boolean((next as any).reduceTransparency));
              if ((next as any).reduceMotion !== undefined)
                setReduceMotion(Boolean((next as any).reduceMotion));
              persistAppearance(next);
            }}
          />
          </Suspense>
        </Modal>
      )}
      {modal === "novel" && (
        <NovelEdit
          novel={novel}
          language={language}
          close={() => setModal(null)}
          notify={notify}
          onSaved={async () => {
            await load(chapter?.id);
          }}
        />
      )}
      {modal === "io" && (
        <Modal title={tr("导入、导出与备份", "Import, export & backup")} close={() => setModal(null)}>
          <Suspense fallback={null}>
            <IoPanel
              novel={novel}
              chapter={chapter}
              onImported={onBack}
              notify={notify}
              language={language}
            />
          </Suspense>
        </Modal>
      )}
      {searchOpen && (
        <Modal title={tr("全书查找", "Search book")} close={closeBookSearch}>
          <div className="book-search">
            <div className="row">
              <input
                autoFocus
                placeholder={tr("输入关键词，回车搜索", "Enter keywords and press Enter")}
                value={bookQuery}
                onChange={(e) => setBookQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runBookSearch();
                  }
                }}
              />
              <button
                className={bookSearching ? "danger-text" : "primary"}
                onClick={() =>
                  bookSearching
                    ? void api("search:cancel", searchRequest.current)
                    : void runBookSearch()
                }
              >
                {bookSearching ? tr("停止", "Stop") : tr("搜索", "Search")}
              </button>
            </div>
            {bookSearching && (
              <div className="search-progress">
                <i style={{ width: `${bookProgress.total ? (bookProgress.scanned / bookProgress.total) * 100 : 0}%` }} />
                <span>{tr(`已扫描 ${bookProgress.scanned} / ${bookProgress.total} 章，找到 ${bookProgress.matches} 章`, `Scanned ${bookProgress.scanned} / ${bookProgress.total} chapters; ${bookProgress.matches} matched`)}</span>
              </div>
            )}
            {!bookSearching && bookQuery.trim() && !bookResults.length && (
              <p className="hint">{tr(`没有找到包含“${bookQuery.trim()}”的章节。`, `No chapters contain “${bookQuery.trim()}”.`)}</p>
            )}
            <div className="search-results">
              {bookResults.map((r) => (
                <button
                  key={r.chapterId}
                  onClick={() => openSearchResult(r.chapterId)}
                >
                  <b>
                    {r.title}
                    <small>{tr(`${r.count} 处`, `${r.count} matches`)}</small>
                  </b>
                  <span>{r.snippet}</span>
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
      {statsOpen && (
        <Modal title={tr("写作统计", "Writing statistics")} close={() => setStatsOpen(false)}>
          <WritingStatsCenter
            language={language}
            novelId={novel.id}
            dailyGoal={dailyGoal}
            onDailyGoal={updateWriting}
          />
        </Modal>
      )}
      {summaryOpen && (
        <Suspense fallback={null}>
          <SummaryModal
            chapter={chapter}
            close={() => setSummaryOpen(false)}
            reload={() => load(chapter?.id)}
            notify={notify}
            language={language}
          />
        </Suspense>
      )}
    </div>
  );
}

export function Section({
  title,
  volumeId,
  rows,
  current,
  search,
  onSelect,
  onAdd,
  onMenu,
  onVolumeMenu,
  onDropChapter,
  language = "zh-CN",
  batch,
  checked,
  onToggle,
}: {
  title: string;
  volumeId: string | null;
  rows: AnyRow[];
  current?: string;
  search: string;
  onSelect: (x: AnyRow) => void;
  onAdd: () => void;
  onMenu: (x: AnyRow, e: React.MouseEvent) => void;
  onVolumeMenu?: (e: React.MouseEvent) => void;
  onDropChapter: (id: string, volumeId: string | null, index: number) => void;
  language?: UiLanguage;
  batch?: boolean;
  checked?: string[];
  onToggle?: (id: string) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const list = rows.filter((x) =>
    x.title.toLowerCase().includes(search.toLowerCase()),
  );
  if (search && !list.length) return null;
  const reorder = !search;
  return (
    <section
      className={`tree-section ${over === "section" ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if (!reorder) return;
        e.preventDefault();
        setOver("section");
      }}
      onDragLeave={() => setOver((x) => (x === "section" ? null : x))}
      onDrop={(e) => {
        if (!reorder) return;
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain");
        setOver(null);
        if (id) onDropChapter(id, volumeId, list.length);
      }}
    >
      <div className="volume">
        <button
          className="volume-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          onDoubleClick={(e) => onVolumeMenu?.(e)}
          title={onVolumeMenu ? (language === "en" ? "Double-click or use the button to manage this volume" : "双击或点右侧按钮管理卷") : undefined}
        >
          <span>{collapsed && !search ? "›" : "⌄"}</span> {title}
        </button>
        <button title={language === "en" ? "Create a chapter here" : "在这里新建章节"} onClick={onAdd}>
          ＋
        </button>
        {onVolumeMenu && (
          <button
            className="icon"
            title={language === "en" ? "Rename / delete volume" : "重命名 / 删除卷"}
            onClick={(e) => {
              e.stopPropagation();
              onVolumeMenu(e);
            }}
          >
            •••
          </button>
        )}
      </div>
      {(!collapsed || Boolean(search)) && list.map((c, i) => (
        <div
          key={c.id}
          draggable={reorder && !batch}
          role="button"
          tabIndex={0}
          aria-current={current === c.id ? "page" : undefined}
          className={`chapter-row ${current === c.id ? "active" : ""} ${over === c.id ? "drag-over" : ""} ${batch && checked?.includes(c.id) ? "checked" : ""}`}
          onClick={() => (batch ? onToggle?.(c.id) : onSelect(c))}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              batch ? onToggle?.(c.id) : onSelect(c);
            }
          }}
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", c.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (!reorder) return;
            e.preventDefault();
            e.stopPropagation();
            if (over !== c.id) setOver(c.id);
          }}
          onDragLeave={() => setOver((x) => (x === c.id ? null : x))}
          onDrop={(e) => {
            if (!reorder) return;
            e.preventDefault();
            e.stopPropagation();
            const id = e.dataTransfer.getData("text/plain");
            setOver(null);
            if (id && id !== c.id) onDropChapter(id, volumeId, i);
          }}
        >
          {batch ? (
            <input
              type="checkbox"
              checked={checked?.includes(c.id) || false}
              onChange={() => onToggle?.(c.id)}
              onClick={(e) => e.stopPropagation()}
              aria-label={language === "en" ? "Select chapter" : "选择章节"}
            />
          ) : (
            <span className={`dot ${c.status}`} />
          )}
          <div>
            <b>{c.title}</b>
            <small>{fmt(c.word_count)} {language === "en" ? "words" : "字"}</small>
            {!batch && (
              <button
                className="more"
                title={language === "en" ? "Chapter actions" : "章节操作"}
                onClick={(e) => {
                  e.stopPropagation();
                  onMenu(c, e);
                }}
              >
                •••
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

export default Workspace;
type Command = { label: string; hint?: string; run: () => void };

export function CommandPalette({
  commands,
  close,
  language = "zh-CN",
}: {
  commands: Command[];
  close: () => void;
  language?: UiLanguage;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const list = useMemo(
    () =>
      commands
        .filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 12),
    [commands, query],
  );
  useEffect(() => setSelected(0), [query]);
  return (
    <div
      className="palette-bg"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="palette">
        <input
          autoFocus
          placeholder={language === "en" ? "Type a command or chapter; ↑↓ to select, Enter to run" : "输入命令或章节名，↑↓ 选择，Enter 执行"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, list.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const cmd = list[selected];
              if (cmd) {
                close();
                cmd.run();
              }
            }
          }}
        />
        <div className="palette-list">
          {list.map((c, i) => (
            <button
              key={c.label}
              className={i === selected ? "active" : ""}
              onMouseEnter={() => setSelected(i)}
              onClick={() => {
                close();
                c.run();
              }}
            >
              <span>{c.label}</span>
              {c.hint && <small>{c.hint}</small>}
            </button>
          ))}
          {!list.length && <p className="hint">{language === "en" ? "No matching commands" : "没有匹配的命令"}</p>}
        </div>
      </div>
    </div>
  );
}
