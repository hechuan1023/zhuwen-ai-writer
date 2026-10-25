import { useEffect, useMemo, useState } from "react";
import { api, parseJson, UiLanguage } from "./shared";
import { Select, type SelectOption } from "./select";
import { normalizeSceneManuscriptLink, normalizeSceneTargetWords, normalizeSceneWritingStatus, sceneManuscriptExcerptWords, SCENE_WRITING_STATUSES, verifySceneManuscriptLink } from "../scene-fields";
import { buildPlotlineMatrix, filterScenesByPov, filterScenesByTrack, groupScenesForTimeline, sceneCustomFields, scenePlotlines, scenePovOptions, sceneTags, sceneTrackOptions } from "./scene-planner-model";

type SceneRow = Record<string, any>;

export function ScenePlanner({
  scenes,
  chapters,
  volumes,
  currentChapter,
  chapterSaved,
  language,
  onClose,
  onOpenScene,
  onDraftScene,
  onCreateScene,
  onOpenChapter,
  onChapterStatusChange,
  onSceneWritingStatusChange,
  onSceneArchiveChange,
  onMoveScene,
  notify,
  canReorder,
  canRelinkSelection,
  onRelinkManuscript,
}: {
  scenes: SceneRow[];
  chapters: SceneRow[];
  volumes: SceneRow[];
  currentChapter: SceneRow | null;
  chapterSaved: boolean;
  language: UiLanguage;
  onClose: () => void;
  onOpenScene: (scene: SceneRow) => void;
  onDraftScene: (scene: SceneRow) => void;
  onCreateScene: (chapter?: SceneRow) => void;
  onOpenChapter: (chapter: SceneRow) => void;
  onChapterStatusChange: (chapterId: string, status: string) => void;
  onSceneWritingStatusChange: (scene: SceneRow, status: string) => Promise<boolean>;
  onSceneArchiveChange: (scene: SceneRow, archived: boolean) => Promise<boolean>;
  onMoveScene: (sceneId: string, chapterId: string | null, beforeId?: string) => void;
  notify: (message: string) => void;
  canReorder: boolean;
  canRelinkSelection: boolean;
  onRelinkManuscript: (scene: SceneRow) => Promise<boolean>;
}) {
  const tr = (zh: string, en: string) => language === "en" ? en : zh;
  const [volumeFilter, setVolumeFilter] = useState(currentChapter?.volume_id || "all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sceneStatusFilter, setSceneStatusFilter] = useState("all");
  const [povFilter, setPovFilter] = useState("all");
  const [trackFilter, setTrackFilter] = useState("all");
  const [viewMode, setViewMode] = useState<"board" | "outline" | "timeline" | "matrix" | "archive">("board");
  const [draggingId, setDraggingId] = useState("");
  const [statusBusyId, setStatusBusyId] = useState("");
  const [sceneStatusBusyId, setSceneStatusBusyId] = useState("");
  const [archiveBusyId, setArchiveBusyId] = useState("");
  useEffect(() => {
    if (volumeFilter !== "all" && volumeFilter !== "unvolumed" && !volumes.some((volume) => volume.id === volumeFilter))
      setVolumeFilter("all");
  }, [volumeFilter, volumes]);
  const dataFor = (scene: SceneRow) => ({ ...parseJson(scene.content_json), ...scene });
  const manuscriptMetricFor = (scene: SceneRow) => {
    const link = normalizeSceneManuscriptLink(dataFor(scene).manuscriptLink);
    if (!link) return null;
    const words = sceneManuscriptExcerptWords(link);
    if (String(scene.chapter_id || "") !== link.chapterId) return { state: "moved", words, chapterTitle: link.chapterTitle };
    if (currentChapter?.id !== link.chapterId) return { state: "other_chapter", words, chapterTitle: link.chapterTitle };
    if (!chapterSaved) return { state: "unsaved", words, chapterTitle: link.chapterTitle };
    const match = verifySceneManuscriptLink(currentChapter.plain_text, link);
    const state = match === "missing" && Number(currentChapter.revision || 0) <= link.chapterRevision ? "pending" : match;
    return { state, words, chapterTitle: link.chapterTitle };
  };
  const archivedScenes = useMemo(
    () => scenes.filter((scene) => Boolean(parseJson(scene.content_json).archivedAt)),
    [scenes],
  );
  const planningScenes = useMemo(
    () => scenes.filter((scene) => !parseJson(scene.content_json).archivedAt),
    [scenes],
  );
  const orderedScenes = useMemo(
    () => [...(viewMode === "archive" ? archivedScenes : planningScenes)]
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)),
    [archivedScenes, planningScenes, viewMode],
  );
  const sceneTargetTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const scene of orderedScenes) {
      const chapterId = String(scene.chapter_id || "");
      const target = normalizeSceneTargetWords(dataFor(scene).targetWords) || 0;
      if (chapterId && target) totals.set(chapterId, (totals.get(chapterId) || 0) + target);
    }
    return totals;
  }, [orderedScenes]);
  const targetShare = (scene: SceneRow) => {
    const chapterId = String(scene.chapter_id || "");
    const target = normalizeSceneTargetWords(dataFor(scene).targetWords) || 0;
    const total = sceneTargetTotals.get(chapterId) || 0;
    return target && total ? Math.round(target / total * 100) : 0;
  };
  const visibleChapters = chapters.filter((chapter) =>
    (volumeFilter === "all" ? true : volumeFilter === "unvolumed" ? !chapter.volume_id : chapter.volume_id === volumeFilter) &&
    (statusFilter === "all" || (chapter.status || "draft") === statusFilter),
  );
  const maxChapterWords = visibleChapters.reduce(
    (maximum, chapter) => Math.max(maximum, Math.max(0, Number(chapter.word_count) || 0)),
    0,
  );
  const chapterWords = (chapter: SceneRow) => Math.max(0, Number(chapter.word_count) || 0);
  const chapterLengthPercent = (chapter: SceneRow) => maxChapterWords
    ? Math.round(chapterWords(chapter) / maxChapterWords * 100)
    : 0;
  const formatWords = (value: number) => new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN").format(value);
  const statusOptions = [
    { value: "all", label: tr("全部状态", "All statuses") },
    { value: "draft", label: tr("草稿", "Draft") },
    { value: "review", label: tr("待修改", "Needs revision") },
    { value: "done", label: tr("已完成", "Complete") },
  ];
  const statusName = (status: string) => statusOptions.find((option) => option.value === status)?.label || tr("草稿", "Draft");
  const writingStatusOptions: SelectOption[] = [
    { value: "planned", label: tr("计划中", "Planned") },
    { value: "drafting", label: tr("写作中", "Drafting") },
    { value: "revision", label: tr("待修订", "Needs revision") },
    { value: "final", label: tr("已定稿", "Final") },
    ...[...new Set(orderedScenes.map((scene) => normalizeSceneWritingStatus(dataFor(scene).writingStatus)))]
      .filter((status) => !SCENE_WRITING_STATUSES.includes(status as typeof SCENE_WRITING_STATUSES[number]))
      .map((status) => ({ value: status, label: status })),
  ];
  const sceneStatusOptions = [
    { value: "all", label: tr("全部进度", "All progress") },
    ...writingStatusOptions,
  ];
  const sceneStatusName = (status: unknown) => writingStatusOptions.find((option) => option.value === normalizeSceneWritingStatus(status))?.label || normalizeSceneWritingStatus(status);
  const sceneStatusTone = (status: unknown) => {
    const normalized = normalizeSceneWritingStatus(status);
    return SCENE_WRITING_STATUSES.includes(normalized as typeof SCENE_WRITING_STATUSES[number]) ? normalized : "custom";
  };
  const povs = scenePovOptions(orderedScenes);
  const povOptions = [
    { value: "all", label: tr("全部视角（" + orderedScenes.length + "）", "All POVs (" + orderedScenes.length + ")") },
    { value: "__unassigned__", label: tr("未标注视角", "Unlabeled POV") },
    ...povs.map(({ value, count }) => ({ value, label: value + " (" + count + ")" })),
  ];
  const tracks = sceneTrackOptions(orderedScenes);
  const trackOptions = [
    { value: "all", label: tr("全部剧情线 / 标签 / 属性", "All plotlines / labels / properties") },
    { value: "__unlabeled__", label: tr("未标记", "Unlabeled") },
    ...tracks.map(({ value, kind, label, count }) => ({ value, label: `${label} (${count})`, hint: kind === "plotline" ? tr("剧情线", "Plotline") : kind === "custom" ? tr("自定义属性", "Custom property") : tr("标签", "Tag") })),
  ];
  const povFilterExists = povFilter === "all" || povFilter === "__unassigned__" || povs.some((item) => item.value === povFilter);
  const trackFilterExists = trackFilter === "all" || trackFilter === "__unlabeled__" || tracks.some((item) => item.value === trackFilter);
  useEffect(() => {
    if (!povFilterExists) setPovFilter("all");
  }, [povFilterExists]);
  useEffect(() => {
    if (!trackFilterExists) setTrackFilter("all");
  }, [trackFilterExists]);
  const updateChapterStatus = async (chapter: SceneRow, status: string) => {
    if (statusBusyId || status === (chapter.status || "draft")) return;
    setStatusBusyId(chapter.id);
    const result = await api("chapters:updateMeta", { id: chapter.id, status });
    setStatusBusyId("");
    if (result.ok) onChapterStatusChange(chapter.id, status);
    else notify(result.error || tr("章节状态保存失败", "Could not save chapter status"));
  };
  const updateSceneStatus = async (scene: SceneRow, status: string) => {
    const next = normalizeSceneWritingStatus(status);
    if (sceneStatusBusyId || next === normalizeSceneWritingStatus(dataFor(scene).writingStatus)) return;
    setSceneStatusBusyId(scene.id);
    try {
      await onSceneWritingStatusChange(scene, next);
    } catch {
      notify(tr("场景进度保存失败", "Could not save scene progress"));
    } finally {
      setSceneStatusBusyId("");
    }
  };
  const updateSceneArchive = async (scene: SceneRow, archived: boolean) => {
    if (archiveBusyId) return;
    setArchiveBusyId(scene.id);
    try {
      const saved = await onSceneArchiveChange(scene, archived);
      if (!saved) notify(archived ? tr("场景归档失败", "Could not archive scene") : tr("场景恢复失败", "Could not restore scene"));
    } catch {
      notify(archived ? tr("场景归档失败", "Could not archive scene") : tr("场景恢复失败", "Could not restore scene"));
    } finally {
      setArchiveBusyId("");
    }
  };
  const knownChapterIds = new Set(chapters.map((chapter) => chapter.id));
  const visibleScenes = useMemo(
    () => filterScenesByTrack(filterScenesByPov(orderedScenes, povFilter), trackFilter)
      .filter((scene) => sceneStatusFilter === "all" || normalizeSceneWritingStatus(dataFor(scene).writingStatus) === sceneStatusFilter),
    [orderedScenes, povFilter, trackFilter, sceneStatusFilter],
  );
  const unassigned = visibleScenes.filter((scene) => !scene.chapter_id || !knownChapterIds.has(scene.chapter_id));
  const assignedCount = visibleScenes.length - unassigned.length;
  const timelineGroups = useMemo(
    () => groupScenesForTimeline(visibleChapters, visibleScenes),
    [visibleChapters, visibleScenes],
  );
  const plotlineMatrix = useMemo(
    () => buildPlotlineMatrix(visibleChapters, visibleScenes),
    [visibleChapters, visibleScenes],
  );
  const canReorderVisible = canReorder && povFilter === "all" && trackFilter === "all" && sceneStatusFilter === "all";
  const volumeOptions = [
    { value: "all", label: tr("全部卷", "All volumes") },
    { value: "unvolumed", label: tr("未分卷", "No volume") },
    ...volumes.map((volume) => ({ value: volume.id, label: volume.title })),
  ];
  const dropOn = (event: React.DragEvent, chapterId: string | null, beforeId?: string) => {
    event.preventDefault();
    const sceneId = event.dataTransfer.getData("text/plain") || draggingId;
    if (sceneId) onMoveScene(sceneId, chapterId, beforeId);
    setDraggingId("");
  };

  return (
    <section className="scene-planner" aria-label={tr("场景规划板", "Scene planning board")} data-fd-id="scene-planner">
      <header className="scene-planner-head">
        <div className="scene-planner-heading">
          <span className="scene-planner-eyebrow">{tr("小说资料库 / 章节细纲", "STORY BIBLE / SCENE OUTLINE")}</span>
          <h1>{tr("场景规划板", "Scene planner")}</h1>
          <p>{tr("按卷浏览章节，把目标、冲突、回报和章末钩子排进连载节奏。拖动卡片可调整顺序或更换所属章节。", "Arrange scene goals, conflict, payoff, and chapter hooks across your serial. Drag cards to reorder or reassign them.")}</p>
        </div>
        <div className="scene-planner-actions">
          <div className="scene-planner-filter">
            <label>{tr("查看范围", "Volume")}</label>
            <Select language={language} value={volumeFilter} aria-label={tr("按卷筛选", "Filter by volume")} onValueChange={setVolumeFilter} options={volumeOptions} />
          </div>
          <div className="scene-planner-filter scene-planner-status-filter">
            <label>{tr("章节状态", "Chapter status")}</label>
            <Select language={language} value={statusFilter} aria-label={tr("按章节状态筛选", "Filter by chapter status")} onValueChange={setStatusFilter} options={statusOptions} />
          </div>
          <div className="scene-planner-filter scene-planner-writing-status-filter">
            <label>{tr("场景写作进度", "Scene writing status")}</label>
            <Select language={language} searchable value={sceneStatusFilter} aria-label={tr("按场景写作进度筛选", "Filter by scene writing status")} onValueChange={setSceneStatusFilter} options={sceneStatusOptions} />
          </div>
          <div className="scene-planner-filter scene-planner-pov-filter">
            <label>{tr("视角人物", "POV")}</label>
            <Select language={language} value={povFilter} aria-label={tr("按视角人物筛选", "Filter by point of view")} onValueChange={setPovFilter} options={povOptions} />
          </div>
          <div className="scene-planner-filter scene-planner-tag-filter">
            <label>{tr("剧情线 / 标签 / 属性", "Plotline / label / property")}</label>
            <Select language={language} searchable value={trackFilter} aria-label={tr("按剧情线、标签或自定义属性筛选", "Filter by plotline, label, or custom property")} onValueChange={setTrackFilter} options={trackOptions} />
          </div>
          <button className="primary" onClick={() => onCreateScene()}>{tr("＋ 新建场景", "+ New scene")}</button>
          <button className="scene-planner-close" onClick={onClose}>{tr("返回资料库", "Back to story bible")}</button>
        </div>
      </header>

      <div className="scene-planner-summary" aria-live="polite">
        <span><b>{visibleScenes.length}</b> {tr("个场景", "scenes")}</span>
        <span><b>{assignedCount}</b> {tr("已关联章节", "assigned")}</span>
        <span><b>{unassigned.length}</b> {tr("待安排", "unassigned")}</span>
        <span>{tr("章节", "Chapters")} · {chapters.filter((item) => (item.status || "draft") === "draft").length} {tr("草稿", "draft")} / {chapters.filter((item) => item.status === "review").length} {tr("待修改", "review")} / {chapters.filter((item) => item.status === "done").length} {tr("完成", "done")}</span>
        <div className="scene-planner-view-switch" role="group" aria-label={tr("规划视图", "Planning view")} data-fd-id="scene-planner-view-switch">
          <button type="button" className={viewMode === "board" ? "active" : ""} aria-pressed={viewMode === "board"} onClick={() => setViewMode("board")}>{tr("规划板", "Board")}</button>
          <button type="button" className={viewMode === "outline" ? "active" : ""} aria-pressed={viewMode === "outline"} onClick={() => setViewMode("outline")}>{tr("大纲表", "Outliner")}</button>
          <button type="button" className={viewMode === "timeline" ? "active" : ""} aria-pressed={viewMode === "timeline"} onClick={() => setViewMode("timeline")}>{tr("时间线", "Timeline")}</button>
          <button type="button" className={viewMode === "matrix" ? "active" : ""} aria-pressed={viewMode === "matrix"} onClick={() => setViewMode("matrix")}>{tr("剧情矩阵", "Matrix")}</button>
          <button type="button" className={viewMode === "archive" ? "active" : ""} aria-pressed={viewMode === "archive"} onClick={() => setViewMode("archive")}>{tr(`已归档 (${archivedScenes.length})`, `Archived (${archivedScenes.length})`)}</button>
        </div>
        <small>{viewMode === "archive" ? tr("归档场景不会出现在活动规划板与剧情矩阵中；可随时恢复。", "Archived scenes are hidden from active planning and the plot matrix; restore them at any time.") : viewMode === "matrix" ? tr("矩阵按章节汇总剧情线覆盖；点场景标题可打开细纲。", "Matrix summarizes plotline coverage by chapter; click a scene to open its outline.") : viewMode === "outline" ? tr("按章节顺序查看场景元数据；点击列名排序，点击场景名编辑细纲。排序仅影响当前视图。", "Review scene metadata in chapter order. Click a column to sort or a scene to edit; sorting only affects this view.") : canReorderVisible ? tr("拖动卡片可调整章节与顺序 · 点击标题编辑细纲", "Drag to reorder or change chapter · Click a title to edit") : tr("筛选结果仅供查看；清除视角、剧情线、标签或场景进度筛选后可调整顺序。", "Filtered results are view-only; clear POV, plotline, label, or scene progress filters to reorder.")}</small>
      </div>

      {viewMode === "board" ? <div className="scene-board-scroll" data-fd-id="scene-board-columns">
        <div className="scene-board-columns">
          <section
            className="scene-lane scene-lane-unassigned"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => dropOn(event, null)}
            data-fd-id="scene-lane-unassigned"
          >
            <header className="scene-lane-head">
              <div><span className="scene-lane-index">—</span><div><b>{tr("待安排", "Unassigned")}</b><small>{tr("尚未关联章节", "No chapter yet")}</small></div></div>
              <span className="scene-lane-count">{unassigned.length}</span>
            </header>
            <div className="scene-lane-cards">
                  {unassigned.map((scene) => <SceneCard key={scene.id} scene={dataFor(scene)} writingStatusOptions={writingStatusOptions} targetShare={null} manuscriptMetric={manuscriptMetricFor(scene)} canRelinkSelection={false} onRelinkManuscript={() => Promise.resolve(false)} dragging={draggingId === scene.id} canReorder={canReorderVisible} canDraft={false} writingStatusBusy={Boolean(sceneStatusBusyId)} onWritingStatusChange={(status) => void updateSceneStatus(scene, status)} language={language} onOpen={() => onOpenScene(scene)} onDraft={() => onDraftScene(scene)} onDragStart={(event) => { setDraggingId(scene.id); event.dataTransfer.setData("text/plain", scene.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDraggingId("")} onDrop={(event) => dropOn(event, null, scene.id)} />)}
              {!unassigned.length && <div className="scene-lane-empty">{canReorderVisible ? tr("把未安排的场景拖到这里", "Drop unassigned scenes here") : tr("当前筛选下没有待安排场景", "No unassigned scenes match these filters")}</div>}
            </div>
            <button className="scene-lane-add" onClick={() => onCreateScene()}>{tr("＋ 添加场景", "+ Add scene")}</button>
          </section>

          {visibleChapters.map((chapter, index) => {
            const laneScenes = visibleScenes.filter((scene) => scene.chapter_id === chapter.id);
            const volume = volumes.find((item) => item.id === chapter.volume_id);
            return (
              <section
                className={`scene-lane ${chapter.id === currentChapter?.id ? "current" : ""}`}
                key={chapter.id}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => dropOn(event, chapter.id)}
                data-fd-id={`scene-lane-${chapter.id}`}
              >
                <header className="scene-lane-head">
                  <div><span className="scene-lane-index">{String(index + 1).padStart(2, "0")}</span><div><small>{volume?.title || tr("未分卷", "No volume")}{chapter.id === currentChapter?.id ? ` · ${tr("当前章", "OPEN")}` : ""}</small><b>{chapter.title}</b></div></div>
                  <span className="scene-lane-count">{laneScenes.length}</span>
                </header>
                <div className="scene-chapter-length" title={tr("与当前显示章节比较的实际正文篇幅，不代表目标完成度", "Actual manuscript length relative to visible chapters; not target progress")}>
                  <div className="scene-chapter-length-track" aria-hidden="true"><span style={{ width: `${chapterLengthPercent(chapter)}%` }} /></div>
                  <small>{formatWords(chapterWords(chapter))} {tr("字", "words")}</small>
                </div>
                <button className="scene-lane-open" onClick={() => onOpenChapter(chapter)}>{tr("打开章节正文", "Open chapter")}</button>
                <div className={`scene-lane-status status-${chapter.status || "draft"}`}>
                  <span>{tr("章节进度", "Chapter status")}</span>
                  <Select
                    size="compact"
                    language={language}
                    value={chapter.status || "draft"}
                    aria-label={tr(`${chapter.title}章节状态`, `Status for ${chapter.title}`)}
                    disabled={statusBusyId === chapter.id}
                    options={statusOptions.filter((option) => option.value !== "all")}
                    onValueChange={(status) => void updateChapterStatus(chapter, status)}
                  />
                </div>
                <div className="scene-lane-cards">
                  {laneScenes.map((scene) => <SceneCard key={scene.id} scene={dataFor(scene)} writingStatusOptions={writingStatusOptions} targetShare={targetShare(scene)} manuscriptMetric={manuscriptMetricFor(scene)} canRelinkSelection={canRelinkSelection && currentChapter?.id === chapter.id} onRelinkManuscript={() => onRelinkManuscript(scene)} dragging={draggingId === scene.id} canReorder={canReorderVisible} canDraft writingStatusBusy={Boolean(sceneStatusBusyId)} onWritingStatusChange={(status) => void updateSceneStatus(scene, status)} language={language} onOpen={() => onOpenScene(scene)} onDraft={() => onDraftScene(scene)} onDragStart={(event) => { setDraggingId(scene.id); event.dataTransfer.setData("text/plain", scene.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDraggingId("")} onDrop={(event) => dropOn(event, chapter.id, scene.id)} />)}
                  {!laneScenes.length && <div className="scene-lane-empty">{povFilter === "all" && trackFilter === "all" ? tr("拖入一个场景，开始拆解本章推进", "Drop a scene here to plan this chapter") : tr("当前筛选下暂无场景", "No scenes match these filters")}</div>}
                </div>
                <button className="scene-lane-add" onClick={() => onCreateScene(chapter)}>{tr("＋ 添加到本章", "+ Add to chapter")}</button>
              </section>
            );
          })}
          {!visibleChapters.length && <div className="scene-board-no-chapters"><span>{tr("当前筛选范围内没有章节。", "No chapters match the current filters.")}</span><button type="button" onClick={() => { setVolumeFilter("all"); setStatusFilter("all"); setSceneStatusFilter("all"); setPovFilter("all"); setTrackFilter("all"); }}>{tr("清除筛选", "Clear filters")}</button></div>}
          <button className="scene-lane-new-chapter" onClick={() => onCreateScene()}>{tr("＋ 新场景", "+ New scene")}</button>
        </div>
      </div> : viewMode === "outline" ? <SceneOutliner scenes={visibleScenes} chapters={chapters} volumes={volumes} writingStatusOptions={writingStatusOptions} sceneStatusBusy={Boolean(sceneStatusBusyId)} language={language} onOpenScene={onOpenScene} onWritingStatusChange={(scene, status) => void updateSceneStatus(scene, status)} /> : viewMode === "timeline" ? <div className="scene-timeline-scroll" data-fd-id="scene-timeline">
        <div className="scene-timeline-note">{tr("按章节顺序与已保存的场景顺序排列。时间标签保留作者原文，不会被解析成日期；需调整顺序时切回规划板拖动。", "Ordered by chapter and saved scene order. Time markers remain author-written labels and are not parsed as dates; switch to Board to reorder.")}</div>
        <div className="scene-timeline-groups">
          {timelineGroups.map(({ chapter, scenes: chapterScenes }, chapterIndex) => {
            const volume = volumes.find((item) => item.id === chapter.volume_id);
            return <section className={`scene-timeline-chapter status-${chapter.status || "draft"}`} key={chapter.id} data-fd-id={`timeline-chapter-${chapter.id}`}>
              <header className="scene-timeline-chapter-head">
                <span className="scene-timeline-chapter-index">{String(chapterIndex + 1).padStart(2, "0")}</span>
                <div><small>{volume?.title || tr("未分卷", "No volume")} · {statusName(chapter.status || "draft")}</small><h2>{chapter.title}</h2><div className="scene-timeline-length" title={tr("与当前显示章节比较的实际正文篇幅，不代表目标完成度", "Actual manuscript length relative to visible chapters; not target progress")}><span className="scene-timeline-length-track" aria-hidden="true"><i style={{ width: `${chapterLengthPercent(chapter)}%` }} /></span><small>{formatWords(chapterWords(chapter))} {tr("字", "words")}</small></div></div>
                <button type="button" onClick={() => onOpenChapter(chapter)}>{tr("打开章节", "Open chapter")}</button>
              </header>
              {chapterScenes.length ? <div className="scene-timeline-events">
                {chapterScenes.map((scene, sceneIndex) => {
                  const data = dataFor(scene);
                  return <article className="scene-timeline-event" key={scene.id} data-fd-id={`timeline-scene-${scene.id}`}>
                    <span className="scene-timeline-marker" aria-hidden="true">{sceneIndex + 1}</span>
                    <div className="scene-timeline-card">
                      <header><span className="scene-timeline-time">{data.when || tr("未填写时间标记", "No time marker")}</span>{data.plotRole && <span className="scene-timeline-role">{data.plotRole}</span>}{scenePlotlines(data).slice(0, 2).map((plotline) => <span className="scene-timeline-tag plotline" key={`plotline:${plotline}`}>{plotline}</span>)}{sceneTags(data).slice(0, 2).map((tag) => <span className="scene-timeline-tag" key={`tag:${tag}`}>{tag}</span>)}{sceneCustomFields(data).slice(0, 2).map((field) => <span className="scene-timeline-tag custom" key={`custom:${field.key}`} title={`${field.key}: ${field.value}`}>{field.key}: {field.value}</span>)}</header>
                      <div className={`scene-timeline-status state-${sceneStatusTone(data.writingStatus)}`}>
                        <span>{tr("写作进度", "Writing status")}</span>
                        <Select language={language} searchable size="compact" value={normalizeSceneWritingStatus(data.writingStatus)} missingLabel={normalizeSceneWritingStatus(data.writingStatus)} aria-label={tr(`${scene.title || "场景"}写作进度`, `Writing status for ${scene.title || "scene"}`)} disabled={Boolean(sceneStatusBusyId)} options={writingStatusOptions} onValueChange={(status) => void updateSceneStatus(scene, status)} />
                      </div>
                      <button type="button" className="scene-timeline-title" onClick={() => onOpenScene(scene)}>{scene.title || tr("未命名场景", "Untitled scene")}</button>
                      {normalizeSceneTargetWords(data.targetWords) != null && <div className="scene-timeline-target" title={tr("相对条表示该场景目标字数占本章所有已规划场景目标字数的比例，不是写作进度", "The bar shows this scene's share of all planned scene targets in this chapter, not writing progress")}><span>{tr("目标", "Target")} {formatWords(normalizeSceneTargetWords(data.targetWords) || 0)} {tr("字", "words")}</span><span>{targetShare(scene)}%</span><i aria-hidden="true"><b style={{ width: `${targetShare(scene)}%` }} /></i></div>}
                      {data.body && <p>{data.body}</p>}
                      {(data.coolPoint || data.hook) && <small>{data.coolPoint && `${tr("回报", "Payoff")}: ${data.coolPoint}`}{data.coolPoint && data.hook ? " · " : ""}{data.hook && `${tr("章末钩子", "Hook")}: ${data.hook}`}</small>}
                      <footer><span>{data.cast ? data.cast.split(/[,，、;；]+/).filter(Boolean).slice(0, 4).join(" · ") : tr("未记录出场人物", "No cast notes")}</span><button type="button" title={tr("把细纲带入 AI 面板，检查后再发送", "Bring outline to AI for review")} onClick={() => onDraftScene(scene)}>{tr("✦ AI 起草", "✦ Draft with AI")}</button></footer>
                    </div>
                  </article>;
                })}
              </div> : <div className="scene-timeline-empty">{tr("本章尚未安排场景", "No scenes planned for this chapter")}</div>}
            </section>;
          })}
          {unassigned.length > 0 && <section className="scene-timeline-unassigned" data-fd-id="timeline-unassigned">
            <header><b>{tr("待安排场景", "Unassigned scenes")}</b><small>{tr("这些场景不进入叙事顺序", "Not included in story order")}</small></header>
            <div>{unassigned.map((scene) => <button type="button" key={scene.id} onClick={() => onOpenScene(scene)}>{scene.title || tr("未命名场景", "Untitled scene")}</button>)}</div>
          </section>}
          {!timelineGroups.length && <div className="scene-board-no-chapters"><span>{tr("当前筛选范围内没有章节。", "No chapters match the current filters.")}</span><button type="button" onClick={() => { setVolumeFilter("all"); setStatusFilter("all"); setSceneStatusFilter("all"); setPovFilter("all"); setTrackFilter("all"); }}>{tr("清除筛选", "Clear filters")}</button></div>}
        </div>
      </div> : viewMode === "archive" ? <div className="scene-archive-scroll" data-fd-id="scene-archive-list">
        {visibleScenes.length ? <div className="scene-archive-list">{visibleScenes.map((scene) => {
          const data = dataFor(scene);
          const linkedChapter = chapters.find((item) => item.id === scene.chapter_id);
          return <article className="scene-archive-row" key={scene.id} data-fd-id={`scene-archive-${scene.id}`}>
            <div><b>{scene.title || tr("未命名场景", "Untitled scene")}</b><small>{linkedChapter?.title || tr("未安排章节", "Unassigned chapter")} · {tr("归档于", "Archived")} {String(data.archivedAt || "").slice(0, 10)}</small>{data.plotRole && <p>{data.plotRole}</p>}</div>
            <button type="button" onClick={() => onOpenScene(scene)}>{tr("打开细纲", "Open outline")}</button>
            <button type="button" className="primary" disabled={archiveBusyId === scene.id} onClick={() => void updateSceneArchive(scene, false)}>{archiveBusyId === scene.id ? tr("恢复中…", "Restoring…") : tr("恢复", "Restore")}</button>
          </article>;
        })}</div> : <div className="scene-archive-empty"><b>{tr("归档区为空", "No archived scenes")}</b><span>{tr("从细纲编辑器归档暂时不参与规划的场景；之后可在这里恢复。", "Archive scenes from the outline editor when they are out of active planning. Restore them here later.")}</span></div>}
      </div> : <div className="scene-matrix-scroll" data-fd-id="scene-plotline-matrix">
        <div className="scene-matrix-note">{tr("每格列出该章节属于对应剧情线的场景。矩阵只读，未安排到章节的场景不计入；可用上方视角与标签筛选缩小范围。", "Each cell lists scenes in that chapter assigned to the plotline. The matrix is read-only and excludes unassigned scenes; use the POV and label filters above to narrow the view.")}</div>
        {plotlineMatrix.plotlines.length ? <table className="scene-matrix-table">
          <thead><tr><th scope="col">{tr("章节", "Chapter")}</th>{plotlineMatrix.plotlines.map((plotline) => <th scope="col" key={plotline}>{plotline}</th>)}</tr></thead>
          <tbody>{plotlineMatrix.rows.map(({ chapter, scenesByPlotline }) => <tr key={chapter.id}>
            <th scope="row"><small>{volumes.find((item) => item.id === chapter.volume_id)?.title || tr("未分卷", "No volume")}</small><b>{chapter.title || tr("未命名章节", "Untitled chapter")}</b></th>
            {plotlineMatrix.plotlines.map((plotline) => {
              const cellScenes = scenesByPlotline[plotline] || [];
              return <td key={plotline} className={cellScenes.length ? "populated" : "empty"}>
                {cellScenes.length ? <>
                  <span className="scene-matrix-count">{cellScenes.length}</span>
                  <div>{cellScenes.slice(0, 4).map((scene: SceneRow) => <button type="button" key={scene.id} onClick={() => onOpenScene(scene)}>{scene.title || tr("未命名场景", "Untitled scene")}</button>)}
                    {cellScenes.length > 4 && <small>{tr(`另有 ${cellScenes.length - 4} 个场景`, `${cellScenes.length - 4} more`)}</small>}</div>
                </> : <span className="scene-matrix-dash">—</span>}
              </td>;
            })}
          </tr>)}</tbody>
        </table> : <div className="scene-board-no-chapters"><span>{tr("还没有已关联章节的剧情线场景。请在场景细纲中标记剧情线并关联章节。", "No assigned scenes have plotlines yet. Add plotlines to scene outlines and assign them to chapters.")}</span></div>}
      </div>}
    </section>
  );
}
function SceneCard({
  scene,
  writingStatusOptions,
  targetShare,
  manuscriptMetric,
  canRelinkSelection,
  onRelinkManuscript,
  dragging,
  canReorder,
  language,
  onOpen,
  onDraft,
  canDraft,
  writingStatusBusy,
  onWritingStatusChange,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  scene: SceneRow;
  writingStatusOptions: SelectOption[];
  targetShare: number | null;
  manuscriptMetric: { state: string; words: number; chapterTitle: string } | null;
  canRelinkSelection: boolean;
  onRelinkManuscript: () => Promise<boolean>;
  dragging: boolean;
  canReorder: boolean;
  language: UiLanguage;
  onOpen: () => void;
  onDraft: () => void;
  canDraft: boolean;
  writingStatusBusy: boolean;
  onWritingStatusChange: (status: string) => void;
  onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
}) {
  const tr = (zh: string, en: string) => language === "en" ? en : zh;
  const targetWords = normalizeSceneTargetWords(scene.targetWords);
  const writingStatus = normalizeSceneWritingStatus(scene.writingStatus);
  const writingStatusTone = SCENE_WRITING_STATUSES.includes(writingStatus as typeof SCENE_WRITING_STATUSES[number]) ? writingStatus : "custom";
  const formattedTarget = targetWords == null ? "" : new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN").format(targetWords);
  const formatSceneWords = (value: number) => new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN").format(value);
  return (
    <article
      className={`scene-card ${dragging ? "dragging" : ""}`}
      draggable={canReorder}
      onDragStart={(event) => {
        if (!canReorder || (event.target as HTMLElement).closest("button,input,[role='combobox']")) {
          event.preventDefault();
          return;
        }
        onDragStart(event);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.stopPropagation(); onDrop(event); }}
      data-fd-id={`scene-card-${scene.id}`}
    >
      <div className="scene-card-top"><span className="scene-drag-grip" aria-hidden="true">⠿</span><span className={`scene-status ${scene.status === "confirmed" ? "confirmed" : ""}`}>{scene.status === "confirmed" ? tr("已确认", "Canon") : tr("待确认", "Draft")}</span><span className="scene-card-sort">↕</span></div>
      <button className="scene-card-title" onClick={onOpen}>{scene.title || tr("未命名场景", "Untitled scene")}</button>
      <div className={`scene-card-writing-state state-${writingStatusTone}`}>
        <span>{tr("写作进度", "Writing status")}</span>
        <Select
          language={language}
          searchable
          size="compact"
          value={writingStatus}
          missingLabel={writingStatus}
          aria-label={tr(`${scene.title || "场景"}写作进度`, `Writing status for ${scene.title || "scene"}`)}
          disabled={writingStatusBusy}
          options={writingStatusOptions}
          onValueChange={onWritingStatusChange}
        />
      </div>
      {targetWords != null && <div className="scene-card-target" title={tr("相对条表示该场景目标字数占本章所有已规划场景目标字数的比例，不是写作进度", "The bar shows this scene's share of all planned scene targets in this chapter, not writing progress")}><span>{tr("目标", "Target")} {formattedTarget} {tr("字", "words")}</span>{targetShare != null && <><small>{targetShare}%</small><i aria-hidden="true"><b style={{ width: `${targetShare}%` }} /></i></>}</div>}
      {manuscriptMetric && <div className={`scene-card-manuscript state-${manuscriptMetric.state}`} title={tr("仅当关联位置与正文校验指纹一致时，才按该片段计算实写进度；正文编辑导致失配时需重新关联。", "Actual progress appears only while the linked position and manuscript fingerprint match; relink after edits make the anchor stale.")}>
        {manuscriptMetric.state === "matched" ? <>
          <span>{targetWords != null ? tr(`正文 ${formatSceneWords(manuscriptMetric.words)} / ${formattedTarget} 字`, `Text ${formatSceneWords(manuscriptMetric.words)} / ${formattedTarget} words`) : tr(`正文已核对 · ${formatSceneWords(manuscriptMetric.words)} 字`, `Text verified · ${formatSceneWords(manuscriptMetric.words)} words`)}</span>
          {targetWords != null && <><small>{Math.min(100, Math.round(manuscriptMetric.words / targetWords * 100))}%</small><i aria-hidden="true"><b style={{ width: `${Math.min(100, Math.round(manuscriptMetric.words / targetWords * 100))}%` }} /></i></>}
        </> : <span>{manuscriptMetric.state === "missing" ? tr("正文位置或内容已变化", "Excerpt moved or changed") : manuscriptMetric.state === "pending" ? tr("选区已关联 · 保存正文后核对", "Selection linked · save the manuscript to verify") : manuscriptMetric.state === "unsaved" ? tr("正文有未保存修改 · 保存后核对进度", "Manuscript has unsaved edits · save to verify progress") : manuscriptMetric.state === "moved" ? tr(`场景已换章 · 正文关联仍在《${manuscriptMetric.chapterTitle || "原章节"}》`, `Scene moved · excerpt remains in ${manuscriptMetric.chapterTitle || "source chapter"}`) : tr(`正文片段关联 · ${formatSceneWords(manuscriptMetric.words)} 字 · 打开《${manuscriptMetric.chapterTitle || "来源章节"}》核对`, `Excerpt linked · ${formatSceneWords(manuscriptMetric.words)} words · open ${manuscriptMetric.chapterTitle || "source chapter"} to verify`)}</span>}
        {(manuscriptMetric.state === "missing" || manuscriptMetric.state === "moved") && <button type="button" className="scene-card-relink" disabled={!canRelinkSelection} title={!canRelinkSelection ? tr("请先在当前章节保存正文并选中要关联的片段", "Save the current chapter and select the passage to link") : tr("将当前正文选区重新关联到此场景", "Relink the current manuscript selection to this scene")} onClick={(event) => { event.stopPropagation(); void onRelinkManuscript(); }}>{tr("重新关联选区", "Relink selection")}</button>}
      </div>}
      {scene.plotRole && <p className="scene-card-role">{scene.plotRole}</p>}
      {scene.body && <p className="scene-card-body">{scene.body}</p>}
      {(scene.coolPoint || scene.hook) && <div className="scene-card-payoff">{scene.coolPoint && <span><i>✦</i>{scene.coolPoint}</span>}{scene.hook && <span><i>↗</i>{scene.hook}</span>}</div>}
      {scene.cast && <div className="scene-card-cast">{scene.cast.split(/[,，、;；]+/).filter(Boolean).slice(0, 4).map((person: string) => <span key={person}>{person.trim()}</span>)}</div>}
      {(scenePlotlines(scene).length > 0 || sceneTags(scene).length > 0 || sceneCustomFields(scene).length > 0) && <div className="scene-card-tags">{scenePlotlines(scene).slice(0, 2).map((plotline) => <span className="plotline" key={`plotline:${plotline}`} title={tr("剧情线", "Plotline")}>{plotline}</span>)}{sceneTags(scene).slice(0, 2).map((tag) => <span key={`tag:${tag}`} title={tr("场景标签", "Scene tag")}>{tag}</span>)}{sceneCustomFields(scene).slice(0, 2).map((field) => <span className="custom" key={`custom:${field.key}`} title={`${field.key}: ${field.value}`}>{field.key}: {field.value}</span>)}</div>}
      {scene.when && <small className="scene-card-when">{scene.when}</small>}
      <button className="scene-card-draft" type="button" disabled={!canDraft} title={!canDraft ? tr("请先把场景分配到章节", "Assign this scene to a chapter first") : tr("把细纲带入 AI 面板，检查后再发送", "Bring this outline to AI; review before sending")} onClick={(event) => { event.stopPropagation(); onDraft(); }}>{tr("✦ 用 AI 起草", "✦ Draft with AI")}</button>
    </article>
  );
}

function SceneOutliner({
  scenes,
  chapters,
  volumes,
  writingStatusOptions,
  sceneStatusBusy,
  language,
  onOpenScene,
  onWritingStatusChange,
}: {
  scenes: SceneRow[];
  chapters: SceneRow[];
  volumes: SceneRow[];
  writingStatusOptions: SelectOption[];
  sceneStatusBusy: boolean;
  language: UiLanguage;
  onOpenScene: (scene: SceneRow) => void;
  onWritingStatusChange: (scene: SceneRow, status: string) => void;
}) {
  const tr = (zh: string, en: string) => language === "en" ? en : zh;
  const [sort, setSort] = useState<{ key: "order" | "title" | "chapter" | "status" | "target"; direction: 1 | -1 }>({ key: "order", direction: 1 });
  const chapterOrder = new Map(chapters.map((chapter, index) => [String(chapter.id), index]));
  const chapterById = new Map(chapters.map((chapter) => [String(chapter.id), chapter]));
  const volumeById = new Map(volumes.map((volume) => [String(volume.id), volume]));
  const dataFor = (scene: SceneRow) => ({ ...parseJson(scene.content_json), ...scene });
  const collator = new Intl.Collator(language === "en" ? "en-US" : "zh-CN", { numeric: true, sensitivity: "base" });
  const sortedScenes = useMemo(() => {
    if (sort.key === "order") return scenes;
    return [...scenes].sort((left, right) => {
      const a = dataFor(left);
      const b = dataFor(right);
      let comparison = 0;
      if (sort.key === "title") comparison = collator.compare(String(left.title || ""), String(right.title || ""));
      if (sort.key === "chapter") {
        comparison = (chapterOrder.get(String(left.chapter_id || "")) ?? Number.MAX_SAFE_INTEGER) - (chapterOrder.get(String(right.chapter_id || "")) ?? Number.MAX_SAFE_INTEGER);
        if (comparison === 0) comparison = Number(left.sort_order || 0) - Number(right.sort_order || 0);
      }
      if (sort.key === "status") comparison = collator.compare(normalizeSceneWritingStatus(a.writingStatus), normalizeSceneWritingStatus(b.writingStatus));
      if (sort.key === "target") comparison = (normalizeSceneTargetWords(a.targetWords) ?? -1) - (normalizeSceneTargetWords(b.targetWords) ?? -1);
      return comparison * sort.direction || Number(left.sort_order || 0) - Number(right.sort_order || 0);
    });
  }, [scenes, sort, collator, chapterOrder]);
  const toggleSort = (key: typeof sort.key) => setSort((current) => ({
    key,
    direction: current.key === key ? (current.direction === 1 ? -1 : 1) : 1,
  }));
  const sortHeader = (key: typeof sort.key, label: string) => <th scope="col" aria-sort={sort.key === key ? sort.direction === 1 ? "ascending" : "descending" : "none"}>
    <button type="button" onClick={() => toggleSort(key)} aria-label={tr(`按${label}排序`, `Sort by ${label}`)}>{label}{sort.key === key && <span aria-hidden="true">{sort.direction === 1 ? " ↑" : " ↓"}</span>}</button>
  </th>;
  const formatWords = (value: number) => new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN").format(value);

  return <div className="scene-outliner-scroll" data-fd-id="scene-outliner">
    {sortedScenes.length ? <table className="scene-outliner-table">
      <thead><tr>
        <th scope="col" className="scene-outliner-index">#</th>
        {sortHeader("title", tr("场景", "Scene"))}
        {sortHeader("chapter", tr("章节", "Chapter"))}
        {sortHeader("status", tr("写作进度", "Status"))}
        {sortHeader("target", tr("目标字数", "Target"))}
        <th scope="col">{tr("视角", "POV")}</th>
        <th scope="col">{tr("剧情线 / 标签", "Plotlines / tags")}</th>
        <th scope="col">{tr("时间标记", "When")}</th>
      </tr></thead>
      <tbody>{sortedScenes.map((scene, index) => {
        const data = dataFor(scene);
        const chapter = chapterById.get(String(scene.chapter_id || ""));
        const volume = chapter ? volumeById.get(String(chapter.volume_id || "")) : null;
        const labels = [...scenePlotlines(data), ...sceneTags(data), ...sceneCustomFields(data).map((field) => `${field.key}: ${field.value}`)];
        return <tr key={scene.id} data-fd-id={`scene-outliner-row-${scene.id}`}>
          <td className="scene-outliner-index">{index + 1}</td>
          <td className="scene-outliner-title"><button type="button" onClick={() => onOpenScene(scene)} title={String(scene.title || tr("未命名场景", "Untitled scene"))}>{scene.title || tr("未命名场景", "Untitled scene")}</button>{data.plotRole && <small>{data.plotRole}</small>}</td>
          <td className="scene-outliner-chapter"><span>{chapter?.title || tr("未安排", "Unassigned")}</span>{chapter && <small>{volume?.title || tr("未分卷", "No volume")}</small>}</td>
          <td><div className={`scene-outliner-status-cell state-${SCENE_WRITING_STATUSES.includes(normalizeSceneWritingStatus(data.writingStatus) as typeof SCENE_WRITING_STATUSES[number]) ? normalizeSceneWritingStatus(data.writingStatus) : "custom"}`}>
            <Select language={language} searchable size="compact" value={normalizeSceneWritingStatus(data.writingStatus)} missingLabel={normalizeSceneWritingStatus(data.writingStatus)} aria-label={tr(`${scene.title || "场景"}写作进度`, `Writing status for ${scene.title || "scene"}`)} disabled={sceneStatusBusy} options={writingStatusOptions} onValueChange={(status) => onWritingStatusChange(scene, status)} />
          </div></td>
          <td className="scene-outliner-number">{normalizeSceneTargetWords(data.targetWords) == null ? "—" : formatWords(normalizeSceneTargetWords(data.targetWords) || 0)}</td>
          <td>{data.pov || "—"}</td>
          <td className="scene-outliner-labels" title={labels.join(" · ")}>{labels.length ? labels.join(" · ") : "—"}</td>
          <td className="scene-outliner-when" title={String(data.when || "")}>{data.when || "—"}</td>
        </tr>;
      })}</tbody>
    </table> : <div className="scene-outliner-empty">{tr("当前筛选下没有场景。", "No scenes match the current filters.")}</div>}
  </div>;
}
