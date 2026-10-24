import { useEffect, useMemo, useState } from "react";
import { api, parseJson, UiLanguage } from "./shared";
import { Select } from "./select";

type SceneRow = Record<string, any>;

export function ScenePlanner({
  scenes,
  chapters,
  volumes,
  currentChapter,
  language,
  onClose,
  onOpenScene,
  onCreateScene,
  onOpenChapter,
  onMoveScene,
  canReorder,
}: {
  scenes: SceneRow[];
  chapters: SceneRow[];
  volumes: SceneRow[];
  currentChapter: SceneRow | null;
  language: UiLanguage;
  onClose: () => void;
  onOpenScene: (scene: SceneRow) => void;
  onCreateScene: (chapter?: SceneRow) => void;
  onOpenChapter: (chapter: SceneRow) => void;
  onMoveScene: (sceneId: string, chapterId: string | null, beforeId?: string) => void;
  canReorder: boolean;
}) {
  const tr = (zh: string, en: string) => language === "en" ? en : zh;
  const [volumeFilter, setVolumeFilter] = useState(currentChapter?.volume_id || "all");
  const [draggingId, setDraggingId] = useState("");
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
    volumeFilter === "all" ? true : volumeFilter === "unvolumed" ? !chapter.volume_id : chapter.volume_id === volumeFilter,
  );
  const knownChapterIds = new Set(chapters.map((chapter) => chapter.id));
  const unassigned = orderedScenes.filter((scene) => !scene.chapter_id || !knownChapterIds.has(scene.chapter_id));
  const assignedCount = orderedScenes.length - unassigned.length;
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
          <button className="primary" onClick={() => onCreateScene()}>{tr("＋ 新建场景", "+ New scene")}</button>
          <button className="scene-planner-close" onClick={onClose}>{tr("返回资料库", "Back to story bible")}</button>
        </div>
      </header>

      <div className="scene-planner-summary" aria-live="polite">
        <span><b>{orderedScenes.length}</b> {tr("个场景", "scenes")}</span>
        <span><b>{assignedCount}</b> {tr("已关联章节", "assigned")}</span>
        <span><b>{unassigned.length}</b> {tr("待安排", "unassigned")}</span>
        <small>{canReorder ? tr("拖动卡片可调整章节与顺序 · 点击标题编辑细纲", "Drag to reorder or change chapter · Click a title to edit") : tr("搜索结果仅供查看；清空搜索后可调整完整场景顺序。", "Filtered results are view-only; clear search to reorder all scenes.")}</small>
      </div>

      <div className="scene-board-scroll" data-fd-id="scene-board-columns">
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
              {unassigned.map((scene) => <SceneCard key={scene.id} scene={dataFor(scene)} dragging={draggingId === scene.id} canReorder={canReorder} language={language} onOpen={() => onOpenScene(scene)} onDragStart={(event) => { setDraggingId(scene.id); event.dataTransfer.setData("text/plain", scene.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDraggingId("")} onDrop={(event) => dropOn(event, null, scene.id)} />)}
              {!unassigned.length && <div className="scene-lane-empty">{tr("把未安排的场景拖到这里", "Drop unassigned scenes here")}</div>}
            </div>
            <button className="scene-lane-add" onClick={() => onCreateScene()}>{tr("＋ 添加场景", "+ Add scene")}</button>
          </section>

          {visibleChapters.map((chapter, index) => {
            const laneScenes = orderedScenes.filter((scene) => scene.chapter_id === chapter.id);
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
                <div className="scene-lane-cards">
                  {laneScenes.map((scene) => <SceneCard key={scene.id} scene={dataFor(scene)} dragging={draggingId === scene.id} canReorder={canReorder} language={language} onOpen={() => onOpenScene(scene)} onDragStart={(event) => { setDraggingId(scene.id); event.dataTransfer.setData("text/plain", scene.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDraggingId("")} onDrop={(event) => dropOn(event, chapter.id, scene.id)} />)}
                  {!laneScenes.length && <div className="scene-lane-empty">{tr("拖入一个场景，开始拆解本章推进", "Drop a scene here to plan this chapter")}</div>}
                </div>
                <button className="scene-lane-add" onClick={() => onCreateScene(chapter)}>{tr("＋ 添加到本章", "+ Add to chapter")}</button>
              </section>
            );
          })}
          {!visibleChapters.length && <div className="scene-board-no-chapters">{tr("这个范围里还没有章节。先在章节列表中创建章节，再回来安排场景。", "No chapters in this volume yet. Create chapters first, then plan scenes here.")}</div>}
          <button className="scene-lane-new-chapter" onClick={() => onCreateScene()}>{tr("＋ 新场景", "+ New scene")}</button>
        </div>
      </div>
    </section>
  );
function SceneCard({
  scene,
  dragging,
  canReorder,
  language,
  onOpen,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  scene: SceneRow;
  dragging: boolean;
  canReorder: boolean;
  language: UiLanguage;
  onOpen: () => void;
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
    </article>
  );
}
