import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api, useAiSessionStore, Empty, AnyRow, UiLanguage, UiLanguageContext } from "./ui/shared";
import { CreativeHome } from "./ui/home";
import { Onboarding } from "./ui/onboarding";
import { patchAppearance, markOnboardingDone } from "./ui/prefs";

const Workspace = lazy(() => import("./ui/workspace"));
const AiPanel = lazy(() =>
  import("./ui/ai-panel").then((m) => ({ default: m.AiPanel })),
);

export default function App() {
  const closeGuard = useRef<() => Promise<boolean>>(async () => true);
  const [language, setLanguage] = useState<UiLanguage>("zh-CN");
  const [page, setPage] = useState<"shelf" | "work">("shelf"),
    [novels, setNovels] = useState<AnyRow[]>([]),
    [novel, setNovel] = useState<AnyRow | null>(null);
  const [sort, setSort] = useState("recent"),
    [archived, setArchived] = useState(false);
  const [toast, setToast] = useState("");
  const [onboarding, setOnboarding] = useState(false);
  const notify = useCallback((s: string) => {
    setToast(s);
    setTimeout(() => setToast(""), 3500);
  }, []);
  const registerCloseGuard = useCallback((guard: () => Promise<boolean>) => {
    closeGuard.current = guard;
  }, []);
  const loadShelf = useCallback(async () => {
    const r = await api("novels:list", { sort, archived });
    if (r.ok) setNovels(r.data);
  }, [sort, archived]);
  useEffect(() => {
    loadShelf();
  }, [loadShelf]);
  useEffect(() => {
    api<AnyRow>("preferences:get", "appearance").then((result) => {
      if (!result.ok || !result.data) return;
      if (result.data.language === "en" || result.data.language === "zh-CN")
        setLanguage(result.data.language);
      const theme =
        result.data.theme === "light" || result.data.theme === "dark"
          ? result.data.theme
          : "warm";
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
        Boolean(result.data.reduceTransparency),
      );
    });
    api<AnyRow>("preferences:get", "onboarding").then((r) => {
      if (r.ok && !r.data?.done) setOnboarding(true);
    });
  }, []);
  useEffect(
    () =>
      window.zhuwen.onBeforeClose(async () => {
        if (await closeGuard.current()) await api("app:close-ready");
      }),
    [],
  );
  async function openNovel(id: string) {
    const r = await api("novels:open", id);
    if (r.ok) {
      setNovel(r.data.novel);
      setPage("work");
    }
  }
  if (page === "shelf")
    return (
      <UiLanguageContext.Provider value={language}>
        <CreativeHome
          language={language}
          setLanguage={setLanguage}
          novels={novels}
          sort={sort}
          setSort={setSort}
          archived={archived}
          setArchived={setArchived}
          loadShelf={loadShelf}
          notify={notify}
          openNovel={openNovel}
        />
        {onboarding && (
          <Onboarding
            language={language}
            onPickTheme={(t) => {
              document.documentElement.classList.remove(
                "theme-light",
                "theme-dark",
                "theme-warm",
              );
              document.documentElement.classList.add(`theme-${t}`);
              void patchAppearance({ theme: t });
            }}
            close={() => {
              setOnboarding(false);
              void markOnboardingDone().then((r) => {
                if (!r.ok) notify(language === "en"
                  ? "Could not save welcome preference; it may show again."
                  : "欢迎偏好未能保存，下次可能再次显示。");
              });
            }}
          />
        )}
        {toast && (
          <div className="toast" role="status" aria-live="polite">
            {toast}
          </div>
        )}
      </UiLanguageContext.Provider>
    );
  return (
    <UiLanguageContext.Provider value={language}>
    <Suspense fallback={<Empty title={language === "en" ? "Opening novel" : "正在打开作品"} text={language === "en" ? "Please wait…" : "请稍候……"} />}>
      <Workspace
        initial={novel!}
        onLanguageChange={setLanguage}
        registerCloseGuard={registerCloseGuard}
        onBack={() => {
          setPage("shelf");
          setNovel(null);
          loadShelf();
        }}
        notify={notify}
      />
    </Suspense>
    {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </UiLanguageContext.Provider>
  );
}

export function AiFloatApp() {
  const [session] = useAiSessionStore();
  const [language, setLanguage] = useState<UiLanguage>("zh-CN");
  const [toast, setToast] = useState("");
  const notify = useCallback((s: string) => {
    setToast(s);
    window.setTimeout(() => setToast(""), 3500);
  }, []);
  const novel = { id: session?.novelId || "" };
  const chapter = session?.chapter || null;
  useEffect(() => {
    api<AnyRow>("preferences:get", "appearance").then((result) => {
      if (result.ok && (result.data?.language === "en" || result.data?.language === "zh-CN"))
        setLanguage(result.data.language);
      if (result.ok && result.data?.theme) {
        document.documentElement.classList.add(`theme-${result.data.theme}`);
      }
      if (result.ok && result.data?.reduceTransparency)
        document.documentElement.classList.add("reduce-transparency");
    });
  }, []);
  return (
    <UiLanguageContext.Provider value={language}>
    <div className="workspace float-window">
      <div className="float-topbar">
        <strong>{language === "en" ? "Zhuwen · AI Assistant" : "铸文 · AI 助手"}</strong>
        <span>{session?.chapter?.title || (language === "en" ? "No chapter selected" : "未选择章节")}</span>
        <button onClick={() => api("ai:float:close")}>{language === "en" ? "Close" : "收起"}</button>
      </div>
      <aside className="right-panel float-panel">
        {session ? (
          <Suspense fallback={<Empty title={language === "en" ? "Loading assistant" : "正在载入助手"} text={language === "en" ? "Please wait…" : "请稍候……"} />}>
            <AiPanel novel={novel} chapter={chapter} notify={notify} float language={language} />
          </Suspense>
        ) : (
          <Empty title={language === "en" ? "Loading conversation" : "正在载入会话"} text={language === "en" ? "Please wait…" : "请稍候……"} />
        )}
      </aside>
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </div>
    </UiLanguageContext.Provider>
  );
}
