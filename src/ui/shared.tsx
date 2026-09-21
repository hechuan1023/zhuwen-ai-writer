import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export type AnyRow = Record<string, any>;
type Result<T = any> = {
  ok: boolean;
  data: T;
  error?: string;
  conflict?: boolean;
};
export const api = <T = any,>(channel: string, payload?: unknown) =>
  window.zhuwen.invoke<Result<T>>(channel, payload).catch((error: unknown) => ({
    ok: false,
    data: undefined as T,
    error: error instanceof Error ? error.message : String(error),
  }));
/** 退出前立即提交渲染端待发送的 AI 草稿（由 AiPanel 注册，App 在 before-close 时调用） */
export const aiDraftFlusher = { current: () => {} };
export function useAiSessionStore() {
  const [session, setSession] = useState<AnyRow | null>(null);
  useEffect(() => {
    let live = true;
    api("ai:session:get").then((r) => {
      if (live && r.ok) setSession(r.data);
    });
    const off = window.zhuwen.onAiSession((d) => setSession(d));
    return () => {
      live = false;
      off();
    };
  }, []);
  const patch = useCallback((p: AnyRow) => api("ai:session:patch", p), []);
  return [session, patch] as const;
}
export const emptyDoc = { type: "doc", content: [{ type: "paragraph" }] };
export const fmt = (n: number) => new Intl.NumberFormat("zh-CN").format(n || 0);

/** 有效写作时长：统一格式化 */
export function formatFocusDuration(ms: number, language: UiLanguage = "zh-CN") {
  const total = Math.max(0, Math.floor(Number(ms) || 0));
  if (total === 0) return language === "en" ? "0 min" : "0 分钟";
  if (total < 60_000)
    return language === "en" ? `${Math.round(total / 1000)}s` : `${Math.round(total / 1000)} 秒`;
  const totalMin = Math.floor(total / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (language === "en") return h ? `${h}h ${m}m` : `${m}m`;
  return h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}
export const time = (s: string, language: UiLanguage = "zh-CN") =>
  s
    ? new Date(s).toLocaleString(language === "en" ? "en-US" : "zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
export type UiLanguage = "zh-CN" | "en";
export const UiLanguageContext = createContext<UiLanguage>("zh-CN");
export const UI = {
  "zh-CN": {
    shelf: "书架",
    focus: "专注模式",
    exitFocus: "退出专注",
    summary: "摘要",
    library: "资料库",
    settings: "设置",
    assistant: "AI 助手",
    chapters: "章节",
    searchChapter: "搜索章节",
    typewriter: "打字机",
    project: "小说项目",
    saved: "已保存",
    saving: "保存中",
    unsaved: "待保存",
    saveFailed: "保存失败",
    searchBook: "全书查找",
    novelInfo: "小说资料",
    statistics: "写作统计",
    transfer: "导入导出与备份",
    more: "更多操作",
    newVolume: "新建卷",
    newChapter: "新建章节",
    history: "历史版本",
    trash: "回收站",
    chapterWords: "本章",
    bookWords: "全书",
    selectedWords: "已选",
    todayWords: "今日净增",
    words: "字",
    tagline: "安静写作，安心保存",
    continueWriting: "继续上次写作",
    createNovel: "创建小说",
    searchNovels: "搜索书名、作者或题材",
    recentEdited: "最近编辑",
    createdTime: "创建时间",
    titleSort: "书名",
    archive: "查看归档",
    backShelf: "返回书架",
    emptyShelf: "书架还是空的",
    emptyShelfText: "创建第一本小说，开始写作。",
    noArchive: "没有已归档小说",
    noArchiveText: "归档的小说会出现在这里",
    unnamed: "未署名",
    uncategorized: "未分类",
    chaptersUnit: "章",
    edit: "编辑",
    restore: "恢复",
    archiveAction: "归档",
    delete: "删除",
  },
  en: {
    shelf: "Library",
    focus: "Focus",
    exitFocus: "Exit Focus",
    summary: "Summary",
    library: "Story Bible",
    settings: "Settings",
    assistant: "AI Assistant",
    chapters: "Chapters",
    searchChapter: "Search chapters",
    typewriter: "Typewriter",
    project: "Novel Project",
    saved: "Saved",
    saving: "Saving",
    unsaved: "Unsaved",
    saveFailed: "Save failed",
    searchBook: "Search book",
    novelInfo: "Novel info",
    statistics: "Writing statistics",
    transfer: "Import, export & backup",
    more: "More actions",
    newVolume: "New volume",
    newChapter: "New chapter",
    history: "History",
    trash: "Trash",
    chapterWords: "Chapter",
    bookWords: "Book",
    selectedWords: "Selected",
    todayWords: "Today",
    words: "words",
    tagline: "Write quietly. Save with confidence.",
    continueWriting: "Continue writing",
    createNovel: "Create novel",
    searchNovels: "Search title, author, or genre",
    recentEdited: "Recently edited",
    createdTime: "Created date",
    titleSort: "Title",
    archive: "View archive",
    backShelf: "Back to library",
    emptyShelf: "Your library is empty",
    emptyShelfText: "Create your first novel and begin writing.",
    noArchive: "No archived novels",
    noArchiveText: "Archived novels will appear here.",
    unnamed: "Unnamed",
    uncategorized: "Uncategorized",
    chaptersUnit: "chapters",
    edit: "Edit",
    restore: "Restore",
    archiveAction: "Archive",
    delete: "Delete",
  },
} as const;
export const tx = (lang: UiLanguage, key: keyof (typeof UI)["zh-CN"]) => UI[lang][key];

export function DiffModal({
  title,
  beforeLabel,
  afterLabel,
  before,
  after,
  close,
  applyLabel,
  onApply,
}: {
  title: string;
  beforeLabel: string;
  afterLabel: string;
  before: string;
  after: string;
  close: () => void;
  applyLabel?: string;
  onApply?: () => void;
}) {
  const language = useContext(UiLanguageContext);
  const diff = useMemo(() => diffLines(before, after), [before, after]);
  return (
    <Modal title={title} close={close}>
      <div className="diff-view">
        <div className="diff-legend">
          <span className="del">－ {beforeLabel}</span>
          <span className="add">＋ {afterLabel}</span>
        </div>
        <div className="diff">
          {diff.map((d, i) => (
            <div key={i} className={`diff-line ${d.type}`}>
              <span className="diff-sign">
                {d.type === "add" ? "＋" : d.type === "del" ? "－" : "　"}
              </span>
              <span className="diff-text">{d.text || " "}</span>
            </div>
          ))}
        </div>
        <div className="row end">
          <button onClick={close}>{language === "en" ? "Close" : "关闭"}</button>
          {applyLabel && onApply && (
            <button className="primary" onClick={onApply}>
              {applyLabel}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export const kinds = [
  ["outline", "故事大纲"],
  ["character", "人物卡"],
  ["world", "世界设定"],
  ["inspiration", "灵感笔记"],
  ["timeline", "时间线"],
  ["foreshadow", "伏笔"],
  ["relation", "人物关系"],
];
export const readerFonts = [
  {
    label: "宋体（衬线）",
    value: '"Noto Serif SC","Source Han Serif SC",SimSun,serif',
  },
  {
    label: "黑体（无衬线）",
    value: '"Noto Sans SC","Microsoft YaHei","PingFang SC",sans-serif',
  },
  { label: "楷体", value: "STKaiti,KaiTi,serif" },
  { label: "系统默认", value: "system-ui,sans-serif" },
];
export const kindNames: Record<string, string> = {
  selection: "选中文字",
  chapter: "章节",
  summary: "章节摘要",
  continuation: "续写上文",
  outline: "故事大纲",
  character: "人物卡",
  world: "世界设定",
  inspiration: "灵感笔记",
};
const kindNamesEn: Record<string, string> = {
  selection: "Selection",
  chapter: "Chapter",
  summary: "Chapter summary",
  continuation: "Previous passage",
  outline: "Outline",
  character: "Character",
  world: "Worldbuilding",
  inspiration: "Idea",
  timeline: "Timeline",
  foreshadow: "Foreshadowing",
  relation: "Relationship",
};
export const kindNameFor = (kind: string, language: UiLanguage) =>
  (language === "en" ? kindNamesEn : kindNames)[kind] || kind;

const promptNamesEn: Record<string, string> = {
  讨论剧情: "Discuss plot",
  保持文风润色: "Polish in the same voice",
  检查逻辑: "Check logic",
  检查人物对白: "Check character dialogue",
  优化节奏: "Improve pacing",
  生成章节摘要: "Generate chapter summary",
  人物起名: "Name a character",
  地点起名: "Name a place",
  场景描写: "Describe a scene",
  续写建议: "Continuation ideas",
};
export const promptNameFor = (name: string, builtin: unknown, language: UiLanguage) =>
  language === "en" && builtin ? promptNamesEn[name] || name : name;
export type DiffLine = { type: "same" | "del" | "add"; text: string };
export function diffLines(before: string, after: string): DiffLine[] {
  const A = before.split("\n");
  const B = after.split("\n");
  let prefix = 0;
  while (prefix < A.length && prefix < B.length && A[prefix] === B[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < A.length - prefix &&
    suffix < B.length - prefix &&
    A[A.length - 1 - suffix] === B[B.length - 1 - suffix]
  )
    suffix++;
  const head = A.slice(0, prefix).map((text) => ({ type: "same" as const, text }));
  const tail = suffix
    ? A.slice(A.length - suffix).map((text) => ({ type: "same" as const, text }))
    : [];
  const a = A.slice(prefix, A.length - suffix || A.length);
  const b = B.slice(prefix, B.length - suffix || B.length);
  const n = a.length;
  const m = b.length;
  if (n * m > 400000)
    return [
      ...head,
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
      ...tail,
    ];
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [...head];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return [...out, ...tail];
}

export function parseJson(s: string) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
export function parseTags(s: string) {
  try {
    return JSON.parse(s || "[]").join("，");
  } catch {
    return "";
  }
}

export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: any;
}) {
  const language = useContext(UiLanguageContext);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  const titleId = useId();
  closeRef.current = close;
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusTimer = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const preferred =
        dialog?.querySelector<HTMLElement>(
          ".modal-content [autofocus], .modal-content input:not([disabled]), .modal-content textarea:not([disabled]), .modal-content select:not([disabled]), .modal-content button:not([disabled]), .modal-content [tabindex]:not([tabindex='-1'])",
        ) || dialog?.querySelector<HTMLElement>("button:not([disabled])");
      (preferred || dialog)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog']"));
      if (!dialog || dialogs.at(-1) !== dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);
  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button onClick={close} aria-label={language === "en" ? `Close ${title}` : `关闭${title}`}>×</button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} close={onCancel}>
      <p className="hint" style={{ margin: 0 }}>{message}</p>
      <div className="row end" style={{ marginTop: 16 }}>
        <button onClick={onCancel}>{cancelLabel}</button>
        <button
          className={danger ? "danger" : "primary"}
          data-fd-id="confirm-ok"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function PromptDialog({
  title,
  label,
  initial,
  placeholder,
  confirmLabel,
  cancelLabel,
  danger,
  validate,
  validateHint,
  onConfirm,
  onCancel,
}: {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 危险操作：确认按钮使用警示样式 */
  danger?: boolean;
  /**
   * 校验输入，接收原始值（未 trim）。返回 false 时禁用确认按钮。
   * 默认要求非空。用于「必须逐字输入某个词」的不可逆操作强确认。
   */
  validate?: (value: string) => boolean;
  /** 校验失败且已有输入时显示的提示 */
  validateHint?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial || "");
  const ok = validate ? validate(value) : Boolean(value.trim());
  const showHint = Boolean(validateHint) && !ok && value.length > 0;
  return (
    <Modal title={title} close={onCancel}>
      <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {label}
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          aria-describedby={showHint ? `${title}-hint` : undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && ok) {
              e.preventDefault();
              onConfirm(value.trim());
            }
          }}
        />
      </label>
      {showHint && (
        <p className="hint" id={`${title}-hint`} style={{ margin: "8px 0 0" }}>
          {validateHint}
        </p>
      )}
      <div className="row end" style={{ marginTop: 16 }}>
        <button onClick={onCancel}>{cancelLabel}</button>
        <button
          className={danger ? "danger" : "primary"}
          data-fd-id="prompt-ok"
          disabled={!ok}
          onClick={() => onConfirm(value.trim())}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: any;
}) {
  return (
    <div className="empty">
      <div>✦</div>
      <b>{title}</b>
      <p>{text}</p>
      {action}
    </div>
  );
}
