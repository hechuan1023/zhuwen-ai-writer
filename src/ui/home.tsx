import { useEffect, useMemo, useState } from "react";
import { api, fmt, time, Empty, Modal, ConfirmDialog, AnyRow, UiLanguage } from "./shared";
import { CreateNovel, NovelTrash } from "./shelf";
import { NovelEdit } from "./novel-edit";
import { DailyGoalMeter } from "./daily-goal";
import { WritingStatsCenter } from "./stats-center";
import { patchAppearance, patchWriting } from "./prefs";
import { applyReduceMotion } from "./motion";
import { Select } from "./select";

type Props = {
  language: UiLanguage;
  setLanguage: (l: UiLanguage) => void;
  novels: AnyRow[];
  loading?: boolean;
  sort: string;
  setSort: (s: string) => void;
  archived: boolean;
  setArchived: (v: boolean) => void;
  loadShelf: () => Promise<void> | void;
  notify: (s: string) => void;
  openNovel: (id: string) => void;
};

export function CreativeHome({
  language,
  setLanguage,
  novels,
  loading,
  sort,
  setSort,
  archived,
  setArchived,
  loadShelf,
  notify,
  openNovel,
}: Props) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<AnyRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // 待确认移入回收站的小说
  const [trashTarget, setTrashTarget] = useState<AnyRow | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [today, setToday] = useState(0);
  const [dailyGoal, setDailyGoal] = useState(0);
  const [appearance, setAppearance] = useState<AnyRow>({});
  const [theme, setTheme] = useState<"warm" | "light" | "dark">("warm");

  useEffect(() => {
    api<AnyRow>("preferences:get", "appearance").then((r) => {
      if (!r.ok || !r.data) return;
      setAppearance(r.data);
      if (r.data.theme === "light" || r.data.theme === "dark" || r.data.theme === "warm")
        setTheme(r.data.theme);
      document.documentElement.classList.toggle(
        "reduce-transparency",
        Boolean(r.data.reduceTransparency),
      );
      applyReduceMotion(Boolean(r.data.reduceMotion));
    });
    api<AnyRow>("preferences:get", "writing").then((r) => {
      if (r.ok && typeof r.data?.dailyGoal === "number")
        setDailyGoal(Math.max(0, Math.floor(r.data.dailyGoal)));
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.remove("theme-light", "theme-dark", "theme-warm");
    document.documentElement.classList.add(`theme-${theme}`);
    document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
  }, [theme]);

  useEffect(() => {
    const loadToday = () => {
      api<number>("writing:today", "").then((r) => {
        if (r.ok) setToday(Number(r.data) || 0);
      });
    };
    loadToday();
    const id = window.setInterval(loadToday, 60_000);
    return () => window.clearInterval(id);
  }, [novels.length]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return novels.filter((n) =>
      `${n.title || ""}${n.author || ""}${n.genre || ""}`.toLowerCase().includes(q),
    );
  }, [novels, search]);

  const recent = useMemo(() => {
    if (!novels.length) return null;
    return [...novels].sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    )[0];
  }, [novels]);

  async function setGoal(n: number) {
    const value = Math.max(0, Math.floor(n));
    setDailyGoal(value);
    const r = await patchWriting({ dailyGoal: value });
    if (!r.ok)
      notify(r.error || tr("每日目标保存失败", "Could not save daily goal"));
  }

  async function cycleTheme() {
    const next = theme === "warm" ? "light" : theme === "light" ? "dark" : "warm";
    const prev = theme;
    setTheme(next);
    setAppearance((a) => ({ ...a, theme: next }));
    const r = await patchAppearance({ theme: next });
    if (!r.ok) {
      setTheme(prev);
      notify(r.error || tr("主题保存失败", "Could not save theme"));
    }
  }

  return (
    <div className="home" data-fd-id="creative-home">
      <div className="home-shell">
        <header className="home-top">
          <div className="home-brand">
            <h1>铸文</h1>
            <p>{tr("安静写作，安心保存", "Quiet writing, safe manuscripts")}</p>
          </div>
          <div className="row">
            <button onClick={cycleTheme} title={tr("切换主题", "Switch theme")}>
              {theme === "warm" ? tr("暖纸", "Warm") : theme === "light" ? tr("雾白", "Mist") : tr("墨夜", "Ink")}
            </button>
            <button onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")}>
              {language === "en" ? "中文" : "EN"}
            </button>
            <button onClick={() => setTrashOpen(true)}>{tr("回收站", "Trash")}</button>
            <button className="primary" data-fd-id="home-create-novel" onClick={() => setCreating(true)}>
              ＋ {tr("新建小说", "New novel")}
            </button>
          </div>
        </header>

        <section className="home-hero">
          <div className="glass-surface home-continue">
            <div className="eyebrow">{tr("继续创作", "Continue writing")}</div>
            {recent ? (
              <>
                <h2>{recent.title}</h2>
                <div className="meta">
                  {recent.last_chapter_title
                    ? `${tr("上次写到", "Last chapter")}: ${recent.last_chapter_title}`
                    : tr("打开上次编辑的作品", "Open your most recent novel")}
                  <br />
                  {tr("编辑于", "Edited")} {time(recent.updated_at, language)} ·{" "}
                  {fmt(recent.word_count || 0)} {tr("字", "w")} ·{" "}
                  {recent.chapter_count || 0} {tr("章", "ch")}
                </div>
                <div className="actions">
                  <button className="primary" onClick={() => openNovel(recent.id)}>
                    ▶ {tr("继续上次写作", "Continue")}
                  </button>
                  <button onClick={() => setEditing(recent)}>{tr("作品资料", "Details")}</button>
                </div>
              </>
            ) : (
              <>
                <h2>{tr("从第一本书开始", "Start your first book")}</h2>
                <div className="meta">
                  {tr("创建小说后即可分卷、写章节，并接入 AI 助手。", "Create a novel to organize volumes, chapters, and AI assistance.")}
                </div>
                <div className="actions">
                  <button className="primary" onClick={() => setCreating(true)}>
                    {tr("创建小说", "Create novel")}
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="glass-surface home-today">
            <h3>{tr("今日创作", "Today")}</h3>
            <div className="big tabular">
              {fmt(today)}
              <span>{tr("字净增", "net words")}</span>
            </div>
            <DailyGoalMeter
              today={today}
              dailyGoal={dailyGoal}
              language={language}
              scope={null}
              onOpenStats={() => setStatsOpen(true)}
            />
            <button onClick={() => setStatsOpen(true)}>{tr("打开写作统计", "Open statistics")}</button>
          </div>
        </section>

        <div className="home-tools">
          <input
            type="search"
            placeholder={tr("搜索书名、作者或题材", "Search title, author, genre")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            size="compact"
            language={language}
            value={sort}
            aria-label={tr("排序", "Sort")}
            onValueChange={setSort}
            options={[
              { value: "recent", label: tr("最近编辑", "Recent") },
              { value: "created", label: tr("创建时间", "Created") },
              { value: "title", label: tr("书名", "Title") },
            ]}
          />
          <button onClick={() => setArchived(!archived)}>
            {archived ? tr("返回书架", "Back to shelf") : tr("查看归档", "Archived")}
          </button>
          <span className="spacer" />
          <span className="hint">
            {filtered.length} {tr("部作品", "works")}
          </span>
        </div>

        <div className="home-section-title">
          <h3>{archived ? tr("归档作品", "Archived") : tr("全部作品", "Library")}</h3>
        </div>

        {loading && !novels.length ? (
          <Empty
            title={tr("正在载入书架…", "Loading library…")}
            text={tr("请稍候", "Please wait")}
          />
        ) : filtered.length ? (
          <div className="books-grid">
            {filtered.map((n) => (
              <article
                className="book-card"
                key={n.id}
                tabIndex={0}
                onClick={() => openNovel(n.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openNovel(n.id);
                  }
                }}
              >
                <div className="cover">
                  {n.cover_path ? (
                    <img src={n.cover_path} alt="" />
                  ) : (
                    <>
                      <span>铸文</span>
                      <b>{String(n.title || "").slice(0, 8)}</b>
                    </>
                  )}
                </div>
                <div className="info">
                  <h4 title={n.title}>{n.title}</h4>
                  <p>
                    {n.author || tr("未署名", "Unnamed")} · {n.genre || tr("未分类", "Uncategorized")}
                  </p>
                  <small>
                    {fmt(n.word_count || 0)} {tr("字", "w")} · {n.chapter_count || 0} {tr("章", "ch")}
                  </small>
                  {n.last_chapter_title && (
                    <small className="last-read" title={n.last_chapter_title}>
                      {tr("上次写到", "Last")}: {n.last_chapter_title}
                    </small>
                  )}
                  <small>{time(n.updated_at, language)}</small>
                </div>
                <div className="menu">
                  <button
                    type="button"
                    aria-label={tr("更多操作", "More")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuFor === n.id ? null : n.id);
                    }}
                  >
                    •••
                  </button>
                  {menuFor === n.id && (
                    <div
                      className="menu-panel"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => {
                          setMenuFor(null);
                          setEditing(n);
                        }}
                      >
                        {tr("编辑资料", "Edit")}
                      </button>
                      <button
                        onClick={async () => {
                          setMenuFor(null);
                          const r = await api("novels:update", {
                            id: n.id,
                            archived: archived ? 0 : 1,
                          });
                          if (r.ok) loadShelf();
                          else notify(r.error || tr("更新失败", "Update failed"));
                        }}
                      >
                        {archived ? tr("取消归档", "Unarchive") : tr("归档", "Archive")}
                      </button>
                      <button
                        className="danger-text"
                        onClick={() => {
                          setMenuFor(null);
                          setTrashTarget(n);
                        }}
                      >
                        {tr("移入回收站", "Trash")}
                      </button>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : search.trim() && novels.length ? (
          <Empty
            title={tr("没有匹配的作品", "No matching novels")}
            text={tr("试试其它关键词，或清空搜索。", "Try another keyword or clear the search.")}
            action={
              <button onClick={() => setSearch("")}>{tr("清空搜索", "Clear search")}</button>
            }
          />
        ) : (
          <Empty
            title={archived ? tr("没有已归档小说", "No archived novels") : tr("书架还是空的", "Shelf is empty")}
            text={
              archived
                ? tr("归档的作品会出现在这里", "Archived novels appear here")
                : tr("创建第一本小说，开始写作。", "Create your first novel to start writing.")
            }
            action={
              !archived ? (
                <button className="primary" data-fd-id="home-create-novel-empty" onClick={() => setCreating(true)}>
                  {tr("创建小说", "Create novel")}
                </button>
              ) : undefined
            }
          />
        )}
      </div>

      {editing && (
        <NovelEdit
          novel={editing}
          language={language}
          close={() => setEditing(null)}
          notify={notify}
          onSaved={loadShelf}
        />
      )}
      {creating && (
        <CreateNovel
          language={language}
          close={() => setCreating(false)}
          notify={notify}
          onCreated={async (id) => {
            setCreating(false);
            await loadShelf();
            await openNovel(id);
          }}
        />
      )}
      {trashOpen && (
        <NovelTrash
          language={language}
          close={() => setTrashOpen(false)}
          notify={notify}
          reload={loadShelf}
        />
      )}
      {statsOpen && (
        <Modal title={tr("写作统计", "Writing statistics")} close={() => setStatsOpen(false)}>
          <WritingStatsCenter
            language={language}
            novels={novels}
            dailyGoal={dailyGoal}
            onDailyGoal={setGoal}
          />
        </Modal>
      )}
      {trashTarget && (
        <ConfirmDialog
          title={tr("移入回收站", "Move to Trash")}
          message={tr(
            `将《${trashTarget.title}》移入回收站？可在回收站恢复。`,
            `Move “${trashTarget.title}” to Trash? You can restore it later.`,
          )}
          confirmLabel={tr("移入回收站", "Move to Trash")}
          cancelLabel={tr("取消", "Cancel")}
          danger
          onCancel={() => setTrashTarget(null)}
          onConfirm={async () => {
            const target = trashTarget;
            if (!target) return;
            setTrashTarget(null);
            const r = await api("novels:trash", target.id);
            if (r.ok) loadShelf();
            else notify(r.error || tr("删除失败", "Delete failed"));
          }}
        />
      )}
    </div>
  );
}
