import { useEffect, useMemo, useState } from "react";
import { api, parseJson, UiLanguage } from "./shared";
import { Select } from "./select";
import { filterScenesByPov, groupScenesForTimeline, scenePovOptions } from "./scene-planner-model";

type SceneRow = Record<string, any>;

export function ScenePlanner({
  scenes,
  chapters,
  volumes,
  currentChapter,
  language,
  onClose,
  onOpenScene,
  onDraftScene,
  onCreateScene,
  onOpenChapter,
  onChapterStatusChange,
  onMoveScene,
  notify,
  canReorder,
}: {
  scenes: SceneRow[];
  chapters: SceneRow[];
  volumes: SceneRow[];
  currentChapter: SceneRow | null;
  language: UiLanguage;
  onClose: () => void;
  onOpenScene: (scene: SceneRow) => void;
  onDraftScene: (scene: SceneRow) => void;
  onCreateScene: (chapter?: SceneRow) => void;
  onOpenChapter: (chapter: SceneRow) => void;
  onChapterStatusChange: (chapterId: string, status: string) => void;
  onMoveScene: (sceneId: string, chapterId: string | null, beforeId?: string) => void;
  notify: (message: string) => void;
  canReorder: boolean;
}) {
  const tr = (zh: string, en: string) => language === "en" ? en : zh;
  const [volumeFilter, setVolumeFilter] = useState(currentChapter?.volume_id || "all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [povFilter, setPovFilter] = useState("all");
  const [viewMode, setViewMode] = useState<"board" | "timeline">("board");
  const [draggingId, setDraggingId] = useState("");
  const [statusBusyId, setStatusBusyId] = useState("");
  useEffect(() => {
    if (volumeFilter !== "all" && volumeFilter !== "unvolumed" && !volumes.some((volume) => volume.id === volumeFilter))
      setVolumeFilter("all");
  }, [volumeFilter, volumes]);
  const dataFor = (scene: SceneRow) => ({ ...parseJson(scene.content_json), ...scene });
  const orderedScenes = useMemo(
    () => [...scenes].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)),
    [scenes],
  );
  const visibleChapters = chapters.filter((chapter) =>
    (volumeFilter === "all" ? true : volumeFilter === "unvolumed" ? !chapter.volume_id : chapter.volume_id === volumeFilter) &&
    (statusFilter === "all" || (chapter.status || "draft") === statusFilter),
  );
  const statusOptions = [
    { value: "all", label: tr("全部状态", "All statuses") },
    { value: "draft", label: tr("草稿", "Draft") },
    { value: "review", label: tr("待修改", "Needs revision") },
    { value: "done", label: tr("已完成", "Complete") },
  ];
  const statusName = (status: string) => statusOptions.find((option) => option.value === status)?.label || tr("草稿", "Draft");
  const povs = scenePovOptions(orderedScenes);
  const povOptions = [
    { value: "all", label: tr("全部视角（" + orderedScenes.length + "）", "All POVs (" + orderedScenes.length + ")") },
    { value: "__no_pov__", label: tr("未标注视角", "Unlabeled POV") },
    ...povs.map(({ value, count }) => ({ value, label: value + " (" + count + ")" })),
  ];
  const updateChapterStatus = async (chapter: SceneRow, status: string) => {
    if (statusBusyId || status === (chapter.status || "draft")) return;
    setStatusBusyId(chapter.id);
    const result = await api("chapters:updateMeta", { id: chapter.id, status });
    setStatusBusyId("");
    if (result.ok) onChapterStatusChange(chapter.id, status);
    else notify(result.error || tr("章节状态保存失败", "Could not save chapter status"));
  };
  const knownChapterIds = new Set(chapters.map((chapter) => chapter.id));
  const visibleScenes = useMemo(() => filterScenesByPov(orderedScenes, povFilter), [orderedScenes, povFilter]);
  const unassigned = visibleScenes.filter((scene) => !scene.chapter_id || !knownChapterIds.has(scene.chapter_id));
  const assignedCount = visibleScenes.length - unassigned.length;
  const timelineGroups = useMemo(
    () => groupScenesForTimeline(visibleChapters, visibleScenes),
    [visibleChapters, visibleScenes],
  );
  const canReorderVisible = canReorder && povFilter === "all";
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
            <Select value={volumeFilter} aria-label={tr("按卷筛选", "Filter by volume")} onValueChange={setVolumeFilter} options={volumeOptions} />
          </div>
          <div className="scene-planner-filter scene-planner-status-filter">
            <label>{tr("章节状态", "Chapter status")}</label>
            <Select value={statusFilter} aria-label={tr("按章节状态筛选", "Filter by chapter status")} onValueChange={setStatusFilter} options={statusOptions} />
          </div>
          <div className="scene-planner-filter scene-planner-pov-filter">
            <label>{tr("视角人物", "POV")}</label>
            <Select value={povFilter} aria-label={tr("按视角人物筛选", "Filter by point of view")} onValueChange={setPovFilter} options={povOptions} />
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
          <button type="button" className={viewMode === "timeline" ? "active" : ""} aria-pressed={viewMode === "timeline"} onClick={() => setViewMode("timeline")}>{tr("时间线", "Timeline")}</button>
        </div>
        <small>{canReorderVisible ? tr("拖动卡片可调整章节与顺序 · 点击标题编辑细纲", "Drag to reorder or change chapter · Click a title to edit") : tr("搜索或视角筛选结果仅供查看；清除筛选后可调整顺序。", "Search and POV-filtered results are view-only; clear filters to reorder.")}</small>
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
              {unassigned.map((scene) => <SceneCard key={scene.id} scene={dataFor(scene)} dragging={draggingId === scene.id} canReorder={canReorder} canDraft={false} language={language} onOpen={() => onOpenScene(scene)} onDraft={() => onDraftScene(scene)} onDragStart={(event) => { setDraggingId(scene.id); event.dataTransfer.setData("text/plain", scene.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDraggingId("")} onDrop={(event) => dropOn(event, null, scene.id)} />)}
              {!unassigned.length && <div className="scene-lane-empty">{tr("把未安排的场景拖到这里", "Drop unassigned scenes here")}</div>}
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
                <button className="scene-lane-open" onClick={() => onOpenChapter(chapter)}>{tr("打开章节正文", "Open chapter")}</button>
                <div className={`scene-lane-status status-${chapter.status || "draft"}`}>
                  <span>{tr("章节进度", "Chapter status")}</span>
                  <Select
                    size="compact"
                    value={chapter.status || "draft"}
                    aria-label={tr(`${chapter.title}章节状态`, `Status for ${chapter.title}`)}
                    disabled={statusBusyId === chapter.id}
                    options={statusOptions.filter((option) => option.value !== "all")}
                    onValueChange={(status) => void updateChapterStatus(chapter, status)}
                  />
                </div>
                <div className="scene-lane-cards">
                  {laneScenes.map((scene) => <SceneCard key={scene.id} scene={dataFor(scene)} dragging={draggingId === scene.id} canReorder={canReorderVisible} canDraft language={language} onOpen={() => onOpenScene(scene)} onDraft={() => onDraftScene(scene)} onDragStart={(event) => { setDraggingId(scene.id); event.dataTransfer.setData("text/plain", scene.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDraggingId("")} onDrop={(event) => dropOn(event, chapter.id, scene.id)} />)}
                  {!laneScenes.length && <div className="scene-lane-empty">{povFilter === "all" ? tr("拖入一个场景，开始拆解本章推进", "Drop a scene here to plan this chapter") : tr("这个视角下暂无场景", "No scenes for this POV")}</div>}
                </div>
                <button className="scene-lane-add" onClick={() => onCreateScene(chapter)}>{tr("＋ 添加到本章", "+ Add to chapter")}</button>
              </section>
            );
          })}
          {!visibleChapters.length && <div className="scene-board-no-chapters"><span>{tr("当前筛选范围内没有章节。", "No chapters match the current filters.")}</span><button type="button" onClick={() => { setVolumeFilter("all"); setStatusFilter("all"); }}>{tr("清除筛选", "Clear filters")}</button></div>}
          <button className="scene-lane-new-chapter" onClick={() => onCreateScene()}>{tr("＋ 新场景", "+ New scene")}</button>
        </div>
      </div> : <div className="scene-timeline-scroll" data-fd-id="scene-timeline">
        <div className="scene-timeline-note">{tr("按章节顺序与已保存的场景顺序排列。时间标签保留作者原文，不会被解析成日期；需调整顺序时切回规划板拖动。", "Ordered by chapter and saved scene order. Time markers remain author-written labels and are not parsed as dates; switch to Board to reorder.")}</div>
        <div className="scene-timeline-groups">
          {timelineGroups.map(({ chapter, scenes: chapterScenes }, chapterIndex) => {
            const volume = volumes.find((item) => item.id === chapter.volume_id);
            return <section className={`scene-timeline-chapter status-${chapter.status || "draft"}`} key={chapter.id} data-fd-id={`timeline-chapter-${chapter.id}`}>
              <header className="scene-timeline-chapter-head">
                <span className="scene-timeline-chapter-index">{String(chapterIndex + 1).padStart(2, "0")}</span>
                <div><small>{volume?.title || tr("未分卷", "No volume")} · {statusName(chapter.status || "draft")}</small><h2>{chapter.title}</h2></div>
                <button type="button" onClick={() => onOpenChapter(chapter)}>{tr("打开章节", "Open chapter")}</button>
              </header>
              {chapterScenes.length ? <div className="scene-timeline-events">
                {chapterScenes.map((scene, sceneIndex) => {
                  const data = dataFor(scene);
                  return <article className="scene-timeline-event" key={scene.id} data-fd-id={`timeline-scene-${scene.id}`}>
                    <span className="scene-timeline-marker" aria-hidden="true">{sceneIndex + 1}</span>
                    <div className="scene-timeline-card">
                      <header><span className="scene-timeline-time">{data.when || tr("未填写时间标记", "No time marker")}</span>{data.plotRole && <span className="scene-timeline-role">{data.plotRole}</span>}</header>
                      <button type="button" className="scene-timeline-title" onClick={() => onOpenScene(scene)}>{scene.title || tr("未命名场景", "Untitled scene")}</button>
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
          {!timelineGroups.length && <div className="scene-board-no-chapters"><span>{tr("当前筛选范围内没有章节。", "No chapters match the current filters.")}</span><button type="button" onClick={() => { setVolumeFilter("all"); setStatusFilter("all"); }}>{tr("清除筛选", "Clear filters")}</button></div>}
        </div>
      </div>}
    </section>
  );
}
function SceneCard({
  scene,
  dragging,
  canReorder,
  language,
  onOpen,
  onDraft,
  canDraft,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  scene: SceneRow;
  dragging: boolean;
  canReorder: boolean;
  language: UiLanguage;
  onOpen: () => void;
  onDraft: () => void;
  canDraft: boolean;
  onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
}) {
  const tr = (zh: string, en: string) => language === "en" ? en : zh;
  return (
    <article
      className={`scene-card ${dragging ? "dragging" : ""}`}
      draggable={canReorder}
      onDragStart={(event) => canReorder ? onDragStart(event) : event.preventDefault()}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.stopPropagation(); onDrop(event); }}
      data-fd-id={`scene-card-${scene.id}`}
    >
      <div className="scene-card-top"><span className="scene-drag-grip" aria-hidden="true">⠿</span><span className={`scene-status ${scene.status === "confirmed" ? "confirmed" : ""}`}>{scene.status === "confirmed" ? tr("已确认", "Canon") : tr("待确认", "Draft")}</span><span className="scene-card-sort">↕</span></div>
      <button className="scene-card-title" onClick={onOpen}>{scene.title || tr("未命名场景", "Untitled scene")}</button>
      {scene.plotRole && <p className="scene-card-role">{scene.plotRole}</p>}
      {scene.body && <p className="scene-card-body">{scene.body}</p>}
      {(scene.coolPoint || scene.hook) && <div className="scene-card-payoff">{scene.coolPoint && <span><i>✦</i>{scene.coolPoint}</span>}{scene.hook && <span><i>↗</i>{scene.hook}</span>}</div>}
      {scene.cast && <div className="scene-card-cast">{scene.cast.split(/[,，、;；]+/).filter(Boolean).slice(0, 4).map((person: string) => <span key={person}>{person.trim()}</span>)}</div>}
      {scene.when && <small className="scene-card-when">{scene.when}</small>}
      <button className="scene-card-draft" type="button" disabled={!canDraft} title={!canDraft ? tr("请先把场景分配到章节", "Assign this scene to a chapter first") : tr("把细纲带入 AI 面板，检查后再发送", "Bring this outline to AI; review before sending")} onClick={(event) => { event.stopPropagation(); onDraft(); }}>{tr("✦ 用 AI 起草", "✦ Draft with AI")}</button>
    </article>
  );
}
