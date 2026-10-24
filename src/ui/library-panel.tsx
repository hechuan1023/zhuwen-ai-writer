import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, time, parseJson, parseTags, Empty, ConfirmDialog, kinds, AnyRow, UiLanguage } from "./shared";
import {
  editorToLibraryContent,
  libraryContentToEditor,
  normalizeLibraryDraft,
  pickNames,
  scanLibraryHealth,
} from "./library-model";
import { Select } from "./select";
import { ScenePlanner } from "./scene-planner";

export type LibraryLeaveControls = {
  isDirty: () => boolean;
  /** true=可以离开（已保存或放弃）；false=取消 */
  requestLeave: () => Promise<boolean>;
  save: () => Promise<boolean>;
  discard: () => void;
};

export function LibraryPanel({
  novel,
  chapter,
  chapters = [],
  volumes = [],
  onSelectChapter,
  onDraftScene,
  sourceNavigationRequest,
  onSourceNavigationConsumed,
  notify,
  language = "zh-CN",
  onDirtyChange,
  onControls,
}: {
  novel: AnyRow;
  chapter: AnyRow | null;
  chapters?: AnyRow[];
  volumes?: AnyRow[];
  onSelectChapter?: (chapter: AnyRow) => void;
  onDraftScene?: (scene: AnyRow, chapter: AnyRow) => void;
  sourceNavigationRequest?: { nonce: string; kind: string; sourceId: string } | null;
  onSourceNavigationConsumed?: () => void;
  notify: (s: string) => void;
  language?: UiLanguage;
  onDirtyChange?: (dirty: boolean) => void;
  onControls?: (c: LibraryLeaveControls | null) => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const kindLabel = (key: string, fallback = key) =>
    language === "en"
      ? ({ outline: "Outline", scene: "Scene outline", character: "Characters", world: "World", inspiration: "Ideas", timeline: "Timeline", foreshadow: "Foreshadowing", relation: "Relationships" } as Record<string, string>)[key] || fallback
      : fallback;
  const [kind, setKind] = useState("outline"),
    [items, setItems] = useState<AnyRow[]>([]),
    [loadedKind, setLoadedKind] = useState(""),
    [allItems, setAllItems] = useState<AnyRow[]>([]),
    [presence, setPresence] = useState<Record<string, AnyRow>>({}),
    [presenceTotal, setPresenceTotal] = useState(0),
    [search, setSearch] = useState(""),
    [editing, setEditing] = useState<AnyRow | null>(null),
    [baseline, setBaseline] = useState<AnyRow | null>(null),
    [saveBusy, setSaveBusy] = useState(false),
    [graphOpen, setGraphOpen] = useState(false),
    [plannerOpen, setPlannerOpen] = useState(false),
    [listError, setListError] = useState(""),
    [healthOpen, setHealthOpen] = useState(false),
    [healthIssues, setHealthIssues] = useState<ReturnType<typeof scanLibraryHealth>>([]),
    [nameOpen, setNameOpen] = useState(false),
    [nameKind, setNameKind] = useState("person"),
    [names, setNames] = useState<string[]>([]),
    [trashTarget, setTrashTarget] = useState<AnyRow | null>(null),
    [leavePrompt, setLeavePrompt] = useState<
      null | { resolve: (ok: boolean) => void }
    >(null);
  const draftVersion = useRef(0);
  const listSeq = useRef(0);
  const openedSourceRequest = useRef("");
  const leaveResolver = useRef<((ok: boolean) => void) | null>(null);

  const toEditorModel = (row: AnyRow): AnyRow => libraryContentToEditor(row);
  const normalizeDraft = (d: AnyRow | null) => normalizeLibraryDraft(kind, d);

  const dirty =
    Boolean(editing) &&
    normalizeDraft(editing) !== normalizeDraft(baseline);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    const controls: LibraryLeaveControls = {
      isDirty: () => dirty && Boolean(editing),
      save: () => saveThenMaybe(),
      discard: () => {
        setEditing(null);
        setBaseline(null);
      },
      requestLeave: () =>
        new Promise<boolean>((resolve) => {
          if (!dirty || !editing) {
            resolve(true);
            return;
          }
          leaveResolver.current = resolve;
          setLeavePrompt({ resolve });
        }),
    };
    onControls?.(controls);
    return () => onControls?.(null);
  }, [dirty, Boolean(editing), onControls]);

  function resolveLeave(ok: boolean) {
    const r = leaveResolver.current;
    leaveResolver.current = null;
    setLeavePrompt(null);
    r?.(ok);
  }

  function updateEditing(patch: AnyRow) {
    draftVersion.current += 1;
    setEditing((prev: AnyRow | null) => ({ ...(prev || {}), ...patch }));
  }

  function openEditor(row: AnyRow | null, seed: AnyRow = {}) {
    const apply = () => {
      draftVersion.current += 1;
      if (row) {
        const model = toEditorModel(row);
        setEditing(model);
        setBaseline(model);
      } else {
        const blank = { title: "", body: "", status: "idea", kind, ...seed };
        setEditing(blank);
        setBaseline(blank);
      }
    };
    if (editing && dirty) {
      leaveResolver.current = (ok: boolean) => {
        setLeavePrompt(null);
        if (ok) apply();
      };
      setLeavePrompt({ resolve: leaveResolver.current });
      return;
    }
    apply();
  }

  function closeEditor(force = false) {
    if (!force && dirty) {
      leaveResolver.current = (ok: boolean) => {
        setLeavePrompt(null);
        if (ok) {
          draftVersion.current += 1;
          setEditing(null);
          setBaseline(null);
        }
      };
      setLeavePrompt({ resolve: leaveResolver.current });
      return;
    }
    draftVersion.current += 1;
    setEditing(null);
    setBaseline(null);
  }

  function switchKind(nextKind: string) {
    const go = () => {
      draftVersion.current += 1;
      setKind(nextKind);
      setPlannerOpen(false);
      setEditing(null);
      setBaseline(null);
    };
    if (editing && dirty) {
      leaveResolver.current = (ok: boolean) => {
        setLeavePrompt(null);
        if (ok) go();
      };
      setLeavePrompt({ resolve: leaveResolver.current });
      return;
    }
    go();
  }

  async function saveThenMaybe(nextAction?: () => void): Promise<boolean> {
    if (saveBusy) return false;
    if (!editing?.title) {
      notify(tr("请输入资料标题", "Enter a title"));
      return false;
    }
    const snapshot = { ...editing };
    const versionAtSave = draftVersion.current;
    const content = editorToLibraryContent(kind, snapshot);
    setSaveBusy(true);
    const result = await api("library:save", {
      ...snapshot,
      novelId: novel.id,
      kind,
      content,
      tags: String(snapshot.tagsText ?? parseTags(snapshot.tags_json) ?? "")
        .split(/[,，]/)
        .filter(Boolean),
      chapterId: kind === "scene" ? snapshot.chapter_id || null : snapshot.chapter_id || chapter?.id,
    });
    setSaveBusy(false);
    if (!result.ok) {
      notify(
        result.error ||
          tr("资料保存失败，内容已保留", "Save failed; your edits were kept"),
      );
      return false;
    }
    load();
    notify(tr("资料已保存", "Story-bible item saved"));
    // 保存期间又有新编辑：保留草稿，仅刷新 baseline 为已保存快照
    if (draftVersion.current !== versionAtSave) {
      setBaseline(snapshot);
      return false;
    }
    setBaseline(snapshot);
    if (nextAction) nextAction();
    else {
      setEditing(null);
      setBaseline(null);
    }
    return true;
  }

  /** 软删除：只写 deleted_at，条目进入回收站，可恢复（trash:restore） */
  async function trashItem(id: string) {
    const result = await api("library:trash", id);
    if (!result.ok) {
      notify(result.error || tr("移入回收站失败", "Failed to move to trash"));
      return false;
    }
    load();
    notify(tr("已移入回收站", "Moved to trash"));
    return true;
  }

  const deferredSearch = useDeferredValue(search);
  const load = useCallback(() => {
    const seq = ++listSeq.current;
    setListError("");
    setLoadedKind("");
    setItems([]);
    api("library:list", {
      novelId: novel.id,
      kind,
      search: deferredSearch,
    }).then((r) => {
      if (seq !== listSeq.current) return;
      if (!r.ok) {
        setListError(r.error || "list failed");
        setLoadedKind(kind);
        return;
      }
      setItems(r.data);
      setLoadedKind(kind);
    });
  }, [novel.id, kind, deferredSearch]);
  useEffect(() => {
    load();
  }, [load]);
  // 全量资料仅在切换作品时拉取，搜索不触发
  useEffect(() => {
    let live = true;
    api("library:listAll", novel.id).then((r) => {
      if (r.ok && live) setAllItems(r.data);
    });
    return () => {
      live = false;
    };
  }, [novel.id]);
  useEffect(() => {
    const request = sourceNavigationRequest;
    if (!request || openedSourceRequest.current === request.nonce) return;
    if (search.trim()) {
      setSearch("");
      return;
    }
    if (kind !== request.kind) {
      switchKind(request.kind);
      return;
    }
    if (loadedKind !== kind) return;
    if (listError) {
      onSourceNavigationConsumed?.();
      notify(listError);
      return;
    }
    const source = items.find((item) => item.id === request.sourceId);
    if (!source) {
      onSourceNavigationConsumed?.();
      notify(tr("原始资料已不存在，但本次 AI 引用快照仍保存在对话中。", "The original material no longer exists, but its snapshot is preserved in this conversation."));
      return;
    }
    openedSourceRequest.current = request.nonce;
    openEditor(source);
    onSourceNavigationConsumed?.();
  }, [sourceNavigationRequest, kind, items, search, loadedKind, listError]);
  useEffect(() => {
    if (!editing && !graphOpen && !trashTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 确认弹窗优先关闭，避免连带触发后面的「未保存」提示
      if (trashTarget) {
        setTrashTarget(null);
        return;
      }
      if (graphOpen) {
        setGraphOpen(false);
        return;
      }
      if (saveBusy) return;
      // 有未保存时交给 leavePrompt，不直接关
      closeEditor();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [Boolean(editing), graphOpen, saveBusy, dirty, Boolean(trashTarget)]);
  // 出场统计在主进程完成，避免把全书正文拉进渲染进程
  useEffect(() => {
    let live = true;
    const entries = allItems
      .filter((x) => x.kind === "character")
      .map((x) => {
        let alias: string[] = [];
        try {
          alias = String(JSON.parse(x.content_json || "{}").alias || "")
            .split(/[,，、;；]+/)
            .filter(Boolean);
        } catch {}
        return [x.title, ...alias];
      });
    if (!entries.length) {
      setPresence({});
      setPresenceTotal(0);
      return;
    }
    api("characters:presence", { novelId: novel.id, entries }).then((r) => {
      if (r.ok && live) {
        setPresence(r.data.presence || {});
        setPresenceTotal(r.data.total || 0);
      }
    });
    return () => {
      live = false;
    };
  }, [novel.id, allItems]);
  const parsed = (x: AnyRow) => ({ ...x, ...parseJson(x.content_json) });
  const characterNames = allItems
    .filter((x) => x.kind === "character")
    .map((x) => x.title);
  const sortedItems =
    kind === "timeline"
      ? [...items].sort((a, b) =>
          String(parseJson(a.content_json).when || "").localeCompare(
            String(parseJson(b.content_json).when || ""),
          ),
        )
      : items;
  async function moveScene(sceneId: string, chapterId: string | null, beforeId?: string) {
    if (search.trim()) return;
    if (sceneId === beforeId) return;
    const scenes = [...items].filter((item) => item.kind === "scene").sort(
      (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0),
    );
    const moved = scenes.find((item) => item.id === sceneId);
    if (!moved) return;
    const withoutMoved = scenes.filter((item) => item.id !== sceneId);
    const destination = withoutMoved.filter((item) => (item.chapter_id || null) === chapterId);
    const insertAt = beforeId ? destination.findIndex((item) => item.id === beforeId) : -1;
    if (insertAt < 0) destination.push({ ...moved, chapter_id: chapterId });
    else destination.splice(insertAt, 0, { ...moved, chapter_id: chapterId });
    const laneFor = (id: string | null) => id === chapterId
      ? destination
      : withoutMoved.filter((item) => (item.chapter_id || null) === id);
    const knownChapterIds = new Set(chapters.map((item) => item.id));
    const lanes = [laneFor(null), ...chapters.map((item) => laneFor(item.id))];
    const orphaned = withoutMoved.filter((item) => item.chapter_id && !knownChapterIds.has(item.chapter_id));
    const ordered: AnyRow[] = [...lanes.flat(), ...orphaned]
      .map((item, index) => ({ ...item, sort_order: index }));
    const result = await api("library:reorderScenes", {
      novelId: novel.id,
      items: ordered.map((item) => ({ id: item.id, chapterId: item.chapter_id || null, sortOrder: item.sort_order })),
    });
    if (!result.ok) {
      notify(result.error || tr("场景顺序保存失败", "Could not save scene order"));
      return;
    }
    setItems((current) => current.map((item) => {
      const updated = ordered.find((entry) => entry.id === item.id);
      return updated ? { ...item, chapter_id: updated.chapter_id, sort_order: updated.sort_order } : item;
    }).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)));
  }
  const detailTarget = document.querySelector(".editor-area");
  return (
    <>
      <div className="panel-head">
        <strong>{tr("小说资料库", "Story Bible")}</strong>
        <button
          onClick={() => {
            setHealthIssues(scanLibraryHealth(allItems, language));
            setHealthOpen(true);
          }}
        >
          {tr("体检", "Health")}
        </button>
        <button
          onClick={() => {
            setNames(pickNames(nameKind, 8));
            setNameOpen(true);
          }}
        >
          {tr("命名", "Names")}
        </button>
        {kind === "scene" && <button className={plannerOpen ? "active" : ""} aria-pressed={plannerOpen} onClick={() => setPlannerOpen(true)}>{tr("规划板", "Planner")}</button>}
        <button
          onClick={() => openEditor(null)}
        >
          {tr("＋ 新建", "+ New")}
        </button>
      </div>
      {healthOpen && (
        <div className="modal-bg" role="dialog" aria-modal="true" data-fd-id="library-health">
          <div className="modal" style={{ width: "min(480px, 92vw)" }}>
            <header>
              <h2>{tr("资料体检", "Story bible health")}</h2>
              <button onClick={() => setHealthOpen(false)} aria-label={tr("关闭", "Close")}>×</button>
            </header>
            <div className="modal-content">
              <p className="hint">{tr("仅检查资料字段，不读取或修改正文。", "Checks story-bible fields only; manuscript untouched.")}</p>
              {healthIssues.length === 0 && (
                <p className="hint">{tr("未发现问题", "No issues found")}</p>
              )}
              <ul style={{ paddingLeft: 16, margin: "8px 0" }}>
                {healthIssues.map((issue, i) => (
                  <li key={i} style={{ color: issue.level === "error" ? "var(--danger)" : issue.level === "warn" ? "var(--warning)" : "var(--muted)", marginBottom: 6 }}>
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {nameOpen && (
        <div className="modal-bg" role="dialog" aria-modal="true" data-fd-id="library-names">
          <div className="modal" style={{ width: "min(420px, 92vw)" }}>
            <header>
              <h2>{tr("灵感命名", "Name generator")}</h2>
              <button onClick={() => setNameOpen(false)} aria-label={tr("关闭", "Close")}>×</button>
            </header>
            <div className="modal-content">
              <div className="row" style={{ marginBottom: 10 }}>
                <Select
                  size="compact"
                  value={nameKind}
                  aria-label={tr("命名类型", "Name type")}
                  onValueChange={(v) => {
                    setNameKind(v);
                    setNames(pickNames(v, 8));
                  }}
                  options={Object.entries({
                    person: tr("人名", "Characters"),
                    place: tr("地名", "Places"),
                    faction: tr("势力", "Factions"),
                    item: tr("物品", "Items"),
                    skill: tr("功法", "Skills"),
                    monster: tr("怪物", "Creatures"),
                  }).map(([value, label]) => ({ value, label }))}
                />
                <button onClick={() => setNames(pickNames(nameKind, 8))}>{tr("换一批", "Shuffle")}</button>
              </div>
              <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                {names.map((n) => (
                  <span key={n} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--panel-2)" }}>{n}</span>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 10 }}>{tr("本地词库离线可用，不会请求外部 AI。", "Local word bank; no external AI call.")}</p>
            </div>
          </div>
        </div>
      )}
      <div className="kind-tabs">
        {kinds.map((k) => (
          <button
            className={kind === k[0] ? "active" : ""}
            onClick={() => switchKind(k[0])}
            key={k[0]}
          >
            {kindLabel(k[0], k[1])}
          </button>
        ))}
      </div>
      <input
        className="search"
        placeholder={tr("搜索标题、正文或标签", "Search title, content, or tags")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {editing && detailTarget && createPortal(
        <section className="library-detail-surface" aria-label={tr("资料详情编辑", "Edit story-bible item")}>
          <header>
            <div>
              <small>{tr("小说资料库", "Story Bible")}</small>
              <strong>{editing.id ? tr("编辑", "Edit ") : tr("新建", "New ")}{kindLabel(kind, kinds.find((x) => x[0] === kind)?.[1])}</strong>
            </div>
            <button className="icon" title={tr("关闭资料编辑", "Close editor")} aria-label={tr("关闭资料编辑", "Close editor")} onClick={() => closeEditor()}>×</button>
          </header>
          <div className="library-edit">
          <input
            autoFocus
            placeholder={tr("标题", "Title")}
            value={editing.title}
            onChange={(e) => updateEditing({ title: e.target.value })}
          />
          {kind === "character" && (
            <>
              <input
                placeholder={tr("别名，用逗号分隔", "Aliases, comma-separated")}
                value={editing.alias || ""}
                onChange={(e) => updateEditing({ alias: e.target.value })}
              />
              <input
                placeholder={tr("核心气质 / 防崩关键词", "Core temperament / anti-collapse keywords")}
                value={editing.temperament || ""}
                onChange={(e) => updateEditing({ temperament: e.target.value })}
              />
              <input
                placeholder={tr("知识边界（做不到/不知道的事）", "Knowledge bounds")}
                value={editing.knowledge || ""}
                onChange={(e) => updateEditing({ knowledge: e.target.value })}
              />
              <input
                placeholder={tr("避雷/底线（不可为）", "Taboo / hard limits")}
                value={editing.taboo || ""}
                onChange={(e) => updateEditing({ taboo: e.target.value })}
              />
              <input
                placeholder={tr("防崩清单（写作时对照）", "Consistency checklist")}
                value={editing.checklist || ""}
                onChange={(e) => updateEditing({ checklist: e.target.value })}
              />
            </>
          )}
          {kind === "world" && (
            <Select
              value={editing.category || ""}
              aria-label={tr("世界设定分类", "World category")}
              onValueChange={(v) => updateEditing({ category: v })}
              options={[
                { value: "", label: tr("未分类", "Uncategorized") },
                { value: "地点", label: tr("地点", "Location") },
                { value: "势力", label: tr("势力", "Faction") },
                { value: "规则", label: tr("规则", "Rule") },
                { value: "历史事件", label: tr("历史事件", "Historical event") },
                { value: "专有名词", label: tr("专有名词", "Term") },
                { value: "物品", label: tr("物品", "Object") },
              ]}
            />
          )}
          {kind === "scene" && (
            <>
              <input
                placeholder={tr("场景位置或补充定位（如：祠堂后门）", "Scene location or note (e.g. back entrance)")}
                value={editing.when || ""}
                onChange={(e) => updateEditing({ when: e.target.value })}
              />
              <Select
                value={editing.chapter_id || ""}
                aria-label={tr("关联所属章节", "Linked chapter")}
                onValueChange={(v) => updateEditing({ chapter_id: v || null })}
                options={[
                  { value: "", label: tr("未安排到具体章节", "Unassigned") },
                  ...chapters.map((item) => ({
                    value: item.id,
                    label: `${volumes.find((volume) => volume.id === item.volume_id)?.title ? `${volumes.find((volume) => volume.id === item.volume_id)?.title} · ` : ""}${item.title}`,
                  })),
                ]}
              />
              <input
                placeholder={tr("剧情作用", "Plot role")}
                value={editing.plotRole || ""}
                onChange={(e) => updateEditing({ plotRole: e.target.value })}
              />
              <input
                placeholder={tr("爽点 / 钩子", "Highlight / hook")}
                value={editing.coolPoint || ""}
                onChange={(e) => updateEditing({ coolPoint: e.target.value })}
              />
              <input
                placeholder={tr("章末钩子", "Chapter-end hook")}
                value={editing.hook || ""}
                onChange={(e) => updateEditing({ hook: e.target.value })}
              />
              <input
                placeholder={tr("出场人物（逗号分隔）", "Cast")}
                value={editing.cast || ""}
                onChange={(e) => updateEditing({ cast: e.target.value })}
              />
            </>
          )}
          {kind === "timeline" && (
            <input
              placeholder={tr("时间点，如：第一卷·第三日", "Time, e.g. Volume 1 · Day 3")}
              value={editing.when || ""}
              onChange={(e) => updateEditing({ when: e.target.value })}
            />
          )}
          {kind === "relation" && (
            <div className="grid2">
              <input
                placeholder={tr("人物 A", "Character A")}
                list="character-names"
                value={editing.from || ""}
                onChange={(e) =>
                  updateEditing({ from: e.target.value })
                }
              />
              <input
                placeholder={tr("人物 B", "Character B")}
                list="character-names"
                value={editing.to || ""}
                onChange={(e) => updateEditing({ to: e.target.value })}
              />
            </div>
          )}
          <textarea
            placeholder={
              kind === "relation"
                ? tr("关系说明（如：师徒 / 相互利用 / 旧识）", "Relationship (e.g. mentor / rivals / old friends)")
                : kind === "timeline"
                  ? tr("事件描述", "Event description")
                  : kind === "scene"
                    ? tr("场景细纲：目标、冲突、结果", "Scene outline: goal, conflict, outcome")
                    : kind === "foreshadow"
                      ? tr("伏笔内容（埋下什么）", "Foreshadow content (what is planted)")
                      : kind === "character"
                    ? tr("身份背景 / 概述", "Background / overview")
                    : tr("内容", "Content")
            }
            value={editing.body ?? ""}
            onChange={(e) => updateEditing({ body: e.target.value })}
          />
          {kind === "character" && (
            <>
              <textarea
                rows={2}
                placeholder={tr("外貌", "Appearance")}
                value={editing.appearance || ""}
                onChange={(e) =>
                  updateEditing({ appearance: e.target.value })
                }
              />
              <textarea
                rows={2}
                placeholder={tr("性格", "Personality")}
                value={editing.personality || ""}
                onChange={(e) =>
                  updateEditing({ personality: e.target.value })
                }
              />
              <textarea
                rows={2}
                placeholder={tr("外在目标", "External goal")}
                value={editing.goal || ""}
                onChange={(e) =>
                  updateEditing({ goal: e.target.value })
                }
              />
              <textarea
                rows={2}
                placeholder={tr("内在动机", "Inner motivation")}
                value={editing.motive || ""}
                onChange={(e) =>
                  updateEditing({ motive: e.target.value })
                }
              />
              <textarea
                rows={2}
                placeholder={tr("内在矛盾", "Inner conflict")}
                value={editing.conflict || ""}
                onChange={(e) =>
                  updateEditing({ conflict: e.target.value })
                }
              />
              <textarea
                rows={2}
                placeholder={tr("语言习惯", "Speech patterns")}
                value={editing.speech || ""}
                onChange={(e) =>
                  updateEditing({ speech: e.target.value })
                }
              />
              <textarea
                rows={2}
                placeholder={tr("备注", "Notes")}
                value={editing.note || ""}
                onChange={(e) =>
                  updateEditing({ note: e.target.value })
                }
              />
            </>
          )}
          {kind === "foreshadow" && (
            <>
              <input
                placeholder={tr("埋设位置（如：第 3 章·祠堂）", "Planted at (e.g. Ch.3 · shrine)")}
                value={editing.plantAt || ""}
                onChange={(e) =>
                  updateEditing({ plantAt: e.target.value })
                }
              />
              <input
                placeholder={tr("计划回收（如：第 80 章）", "Planned payoff (e.g. Ch.80)")}
                value={editing.planAt || ""}
                onChange={(e) =>
                  updateEditing({ planAt: e.target.value })
                }
              />
              <textarea
                placeholder={tr("回收说明（何时、以何种方式回收）", "Payoff notes (when and how it is resolved)")}
                value={editing.payoff || ""}
                onChange={(e) =>
                  updateEditing({ payoff: e.target.value })
                }
              />
              <textarea
                rows={2}
                placeholder={tr("前置条件（回收成立所需的前置）", "Prerequisites for the payoff")}
                value={editing.prereq || ""}
                onChange={(e) =>
                  updateEditing({ prereq: e.target.value })
                }
              />
              <textarea
                rows={2}
                placeholder={tr("回收后的效果（改变了什么）", "Effect after the payoff")}
                value={editing.effect || ""}
                onChange={(e) =>
                  updateEditing({ effect: e.target.value })
                }
              />
              <Select
                value={editing.importance || ""}
                aria-label={tr("伏笔重要度", "Foreshadow importance")}
                onValueChange={(v) => updateEditing({ importance: v })}
                options={[
                  { value: "", label: tr("未标注", "Unrated") },
                  { value: "高", label: tr("高", "High") },
                  { value: "中", label: tr("中", "Medium") },
                  { value: "低", label: tr("低", "Low") },
                ]}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={Boolean(editing.resolved)}
                  onChange={(e) =>
                    updateEditing({ resolved: e.target.checked })
                  }
                />
                {tr("已回收", "Resolved")}
              </label>
            </>
          )}
          <input
            placeholder={tr("标签，用逗号分隔", "Tags, separated by commas")}
            value={editing.tagsText ?? parseTags(editing.tags_json)}
            onChange={(e) =>
              updateEditing({ tagsText: e.target.value })
            }
          />
          <Select
            value={editing.status || "idea"}
            aria-label={tr("资料状态", "Item status")}
            onValueChange={(v) => updateEditing({ status: v })}
            options={[
              { value: "idea", label: tr("待确认", "Unconfirmed") },
              { value: "confirmed", label: tr("正式设定", "Canon") },
            ]}
          />
          <datalist id="character-names">
            {characterNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <div className="row">
            {editing.id && (
              <button
                className="danger-text"
                data-fd-id="library-trash"
                onClick={() => setTrashTarget(editing)}
              >
                {tr("移入回收站", "Move to trash")}
              </button>
            )}
            <span className="spacer" />
            <button onClick={() => setEditing(null)}>{tr("取消", "Cancel")}</button>
            <button className="primary" disabled={saveBusy} onClick={() => saveThenMaybe()}>
              {saveBusy ? tr("保存中…", "Saving…") : tr("保存", "Save")}
            </button>
          </div>
          </div>
        </section>,
        detailTarget,
      )}
      {plannerOpen && detailTarget && createPortal(
        <ScenePlanner
          scenes={items.filter((item) => item.kind === "scene")}
          chapters={chapters}
          volumes={volumes}
          currentChapter={chapter}
          language={language}
          onClose={() => setPlannerOpen(false)}
          onOpenScene={(scene) => openEditor(scene)}
          onDraftScene={(scene) => {
            const targetChapter = chapters.find((item) => item.id === scene.chapter_id);
            if (targetChapter) {
              onDraftScene?.(scene, targetChapter);
              setPlannerOpen(false);
            }
          }}
          onCreateScene={(targetChapter) => openEditor(null, targetChapter ? { chapter_id: targetChapter.id } : {})}
          onOpenChapter={(targetChapter) => onSelectChapter?.(targetChapter)}
          onMoveScene={(sceneId, chapterId, beforeId) => void moveScene(sceneId, chapterId, beforeId)}
          canReorder={!search.trim()}
        />,
        detailTarget,
      )}
      <div className="library-list">
          {kind === "relation" && (
            <RelationGraph relations={items.map(parsed)} onExpand={() => setGraphOpen(true)} language={language} />
          )}
          {sortedItems.map((x) => {
            const c = parseJson(x.content_json);
            const pres =
              kind === "character" ? presence[x.title] : undefined;
            return (
              <article
                onClick={() => openEditor(x)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openEditor(x);
                  }
                }}
                tabIndex={0}
                aria-label={tr(`编辑${x.title}`, `Edit ${x.title}`)}
                key={x.id}
              >
                <div>
                  <b>
                    {kind === "relation"
                      ? `${c.from || "?"} — ${c.label || tr("关系", "relationship")} → ${c.to || "?"}`
                      : x.title}
                  </b>
                  {kind === "foreshadow" ? (
                    <span
                      className={`badge ${c.resolved ? "confirmed" : "idea"}`}
                    >
                      {c.resolved ? tr("已回收", "Resolved") : tr("待回收", "Pending")}
                    </span>
                  ) : (
                    <span className={`badge ${x.status}`}>
                      {x.status === "confirmed" ? tr("正式设定", "Canon") : tr("待确认", "Unconfirmed")}
                    </span>
                  )}
                  {kind === "world" && c.category && (
                    <span className="badge idea">{c.category}</span>
                  )}
                  {kind === "foreshadow" && c.importance && (
                    <span className="badge idea">
                      {c.importance === "高"
                        ? tr("高", "High")
                        : c.importance === "中"
                          ? tr("中", "Medium")
                          : c.importance === "低"
                            ? tr("低", "Low")
                            : c.importance}
                    </span>
                  )}
                  {pres && (
                    <span
                      className={`badge ${pres.appearances ? "confirmed" : "idea"}`}
                      title={tr(`按全书 ${presenceTotal} 章顺序统计`, `Calculated across ${presenceTotal} chapters`)}
                    >
                      {pres.appearances
                        ? tr(`出场 ${pres.appearances} 章${
                            pres.sinceLast >= 3
                              ? ` · 已 ${pres.sinceLast} 章未出场`
                              : ""
                          }`, `Appears in ${pres.appearances} chapters${pres.sinceLast >= 3 ? ` · absent for ${pres.sinceLast} chapters` : ""}`)
                        : tr("未出场", "Not present")}
                    </span>
                  )}
                </div>
                <p>
                  {kind === "timeline"
                    ? `${c.when || ""} ${c.body || ""}`
                    : c.body}
                </p>
                <small>
                  {kind === "foreshadow" && (c.plantAt || c.planAt)
                    ? tr(
                        `埋设：${c.plantAt || "未填"} · 计划回收：${c.planAt || "未填"} · `,
                        `Planted: ${c.plantAt || "—"} · Payoff: ${c.planAt || "—"} · `,
                      )
                    : ""}
                  {kind === "character" && c.alias
                    ? tr(`别名：${c.alias} · `, `Aliases: ${c.alias} · `)
                    : ""}
                  {parseTags(x.tags_json)} · {time(x.updated_at, language)}
                </small>
              </article>
            );
          })}
          {!sortedItems.length && (
            <Empty
              title={tr("暂无资料", "No items yet")}
              text={tr("在这里整理大纲、人物、世界、灵感、时间线、伏笔和人物关系。", "Organize outlines, characters, worldbuilding, ideas, timelines, foreshadowing, and relationships here.")}
            />
          )}
      </div>
      {graphOpen && detailTarget && createPortal(
        <section className="library-detail-surface relation-detail" aria-label={tr("人物关系图", "Relationship graph")}>
          <header>
            <div><small>{tr("小说资料库", "Story Bible")}</small><strong>{tr("人物关系图", "Relationship graph")}</strong></div>
            <button className="icon" title={tr("关闭关系图", "Close relationship graph")} aria-label={tr("关闭关系图", "Close relationship graph")} onClick={() => setGraphOpen(false)}>×</button>
          </header>
          <RelationGraph relations={items.map(parsed)} large language={language} />
        </section>,
        detailTarget,
      )}
      {listError && (
        <p className="hint" style={{ color: "var(--danger)" }} role="alert">
          {listError}{" "}
          <button type="button" onClick={load}>
            {tr("重试", "Retry")}
          </button>
        </p>
      )}
      {leavePrompt && (
        <div className="modal-bg" role="dialog" aria-modal="true" data-fd-id="library-leave">
          <div className="modal" style={{ width: "min(420px, 92vw)" }}>
            <header>
              <h2>{tr("资料尚未保存", "Unsaved story-bible changes")}</h2>
            </header>
            <div className="modal-content">
              <p className="hint">
                {tr(
                  "当前资料有未保存修改。离开将丢失这些修改。",
                  "This item has unsaved changes. Leaving will discard them.",
                )}
              </p>
              <div className="row end" style={{ marginTop: 16, flexWrap: "wrap" }}>
                <button data-fd-id="library-keep" onClick={() => resolveLeave(false)}>
                  {tr("继续编辑", "Keep editing")}
                </button>
                <button
                  className="danger"
                  data-fd-id="library-discard"
                  disabled={saveBusy}
                  onClick={() => {
                    draftVersion.current += 1;
                    setEditing(null);
                    setBaseline(null);
                    resolveLeave(true);
                  }}
                >
                  {tr("放弃修改", "Discard")}
                </button>
                <button
                  className="primary"
                  data-fd-id="library-save-continue"
                  disabled={saveBusy}
                  onClick={async () => {
                    const ok = await saveThenMaybe();
                    if (ok) resolveLeave(true);
                  }}
                >
                  {saveBusy
                    ? tr("保存中…", "Saving…")
                    : tr("保存并继续", "Save and continue")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {trashTarget && (
        <ConfirmDialog
          title={tr("移入回收站", "Move to trash")}
          message={tr(
            `将「${trashTarget.title}」移入回收站？可在回收站恢复。`,
            `Move “${trashTarget.title}” to trash? You can restore it later from the trash.`,
          )}
          confirmLabel={tr("移入回收站", "Move to trash")}
          cancelLabel={tr("取消", "Cancel")}
          danger
          onCancel={() => setTrashTarget(null)}
          onConfirm={async () => {
            const target = trashTarget;
            setTrashTarget(null);
            // 仅删除成功才关闭编辑器，失败时保留现场让用户重试
            if (await trashItem(target.id)) {
              draftVersion.current += 1;
              setEditing(null);
              setBaseline(null);
            }
          }}
        />
      )}
    </>
  );
}

export function RelationGraph({
  relations,
  onExpand,
  large = false,
  language = "zh-CN",
}: {
  relations: AnyRow[];
  onExpand?: () => void;
  large?: boolean;
  language?: UiLanguage;
}) {
  const nodes = Array.from(
    new Set(relations.flatMap((r) => [r.from, r.to]).filter(Boolean)),
  ) as string[];
  if (nodes.length < 2) return null;
  const size = 320,
    cx = size / 2,
    cy = size / 2,
    rad = size / 2 - 52;
  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n, { x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
  });
  return (
    <div className={`relation-graph-wrap ${large ? "large" : ""}`}>
      {onExpand && <button className="graph-expand" onClick={onExpand}>{language === "en" ? "Expand" : "放大查看"}</button>}
      <svg className="relation-graph" viewBox={`0 0 ${size} ${size}`}>
        {relations.map((r, i) => {
          const a = pos.get(r.from);
          const b = pos.get(r.to);
          if (!a || !b || r.from === r.to) return null;
          return (
            <g key={i}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              {r.label && (
                <text
                  x={(a.x + b.x) / 2}
                  y={(a.y + b.y) / 2 - 4}
                  className="edge-label"
                >
                  {r.label}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n)!;
          return (
            <g key={n}>
              <circle cx={p.x} cy={p.y} r="24" />
              <text x={p.x} y={p.y + 4} className="node-label">
                {n.length > 4 ? n.slice(0, 4) : n}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
