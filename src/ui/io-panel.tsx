import { Fragment, useEffect, useRef, useState } from "react";
import { api, time, PromptDialog, Modal, AnyRow, UiLanguage } from "./shared";
import { Select } from "./select";

type EpubCustomLayout = {
  lineHeight: number;
  marginPercent: number;
  paragraphGapEm: number;
  indentEm: number;
};

const DEFAULT_EPUB_CUSTOM_LAYOUT: EpubCustomLayout = {
  lineHeight: 1.8,
  marginPercent: 5,
  paragraphGapEm: 0.65,
  indentEm: 2,
};

function normalizeEpubCustomLayout(value: any): EpubCustomLayout {
  const bounded = (input: unknown, fallback: number, min: number, max: number) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  return {
    lineHeight: bounded(value?.lineHeight, 1.8, 1.4, 2.4),
    marginPercent: bounded(value?.marginPercent, 5, 3, 12),
    paragraphGapEm: bounded(value?.paragraphGapEm, 0.65, 0, 1.5),
    indentEm: bounded(value?.indentEm, 2, 0, 3),
  };
}

function renderPreviewInline(node: any, key: string): any {
  if (!node || typeof node !== "object") return null;
  if (node.type === "text") {
    let content: any = node.text || "";
    for (const mark of node.marks || []) {
      const Tag = mark.type === "bold" ? "strong" : mark.type === "italic" ? "em" : mark.type === "strike" ? "s" : mark.type === "code" ? "code" : null;
      if (Tag) content = <Tag key={`${key}-${mark.type}`}>{content}</Tag>;
    }
    return <Fragment key={key}>{content}</Fragment>;
  }
  if (node.type === "image") {
    const src = String(node.attrs?.src || "");
    if (!/^data:image\/(?:png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src) || src.length > 4 * 1024 * 1024) return null;
    return <img key={key} src={src} alt={String(node.attrs?.alt || "")} />;
  }
  if (node.type === "hardBreak") return <br key={key} />;
  return Array.isArray(node.content)
    ? node.content.map((child: any, index: number) => renderPreviewInline(child, `${key}-${index}`))
    : null;
}

function renderPreviewBlocks(chapter: AnyRow, layout: EpubCustomLayout, fallback: string) {
  const styles = {
    marginBottom: `${layout.paragraphGapEm}em`,
    textIndent: `${layout.indentEm}em`,
  };
  try {
    const doc = JSON.parse(String(chapter.content_json || ""));
    if (doc?.type === "doc" && Array.isArray(doc.content))
      return doc.content.slice(0, 36).map((node: any, index: number) => {
        const content = renderPreviewInline(node, `epub-preview-${index}`);
        if (!content) return null;
        if (node.type === "image") return <figure key={`epub-preview-block-${index}`} className="epub-preview-figure">{content}</figure>;
        return <p key={`epub-preview-block-${index}`} style={styles}>{content}</p>;
      }).filter(Boolean);
  } catch {}
  return fallback.split(/\r\n?|\n/).map((line) => line.trim()).filter(Boolean).slice(0, 36).map((line, index) => (
    <p key={`epub-preview-text-${index}`} style={styles}>{line}</p>
  ));
}

function hasMorePreviewBlocks(chapter: AnyRow): boolean {
  try {
    const doc = JSON.parse(String(chapter.content_json || ""));
    if (doc?.type === "doc" && Array.isArray(doc.content)) return doc.content.length > 36;
  } catch {}
  return String(chapter.plain_text || "").split(/\r\n?|\n/).filter((line) => line.trim()).length > 36;
}

export function IoPanel({
  novel,
  chapter,
  onImported,
  notify,
  language = "zh-CN",
}: {
  novel: AnyRow;
  chapter?: AnyRow | null;
  onImported: () => void;
  notify: (s: string) => void;
  language?: UiLanguage;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const epubPreviewReaderRef = useRef<HTMLDivElement>(null);
  const [imported, setImported] = useState<any>(null),
    [importBusy, setImportBusy] = useState(false),
    [operationBusy, setOperationBusy] = useState(""),
    [importProgress, setImportProgress] = useState({ read: 0, total: 0 }),
    [backups, setBackups] = useState<AnyRow[]>([]),
    [bookChapters, setBookChapters] = useState<AnyRow[]>([]),
    [bookVolumes, setBookVolumes] = useState<AnyRow[]>([]),
    [epubPreviewOpen, setEpubPreviewOpen] = useState(false),
    [epubPreviewPage, setEpubPreviewPage] = useState<"cover" | "toc" | "chapter">("cover"),
    [epubTocPage, setEpubTocPage] = useState(0),
    [epubPreviewChapterId, setEpubPreviewChapterId] = useState(""),
    [epubPreviewChapter, setEpubPreviewChapter] = useState<AnyRow | null>(null),
    [epubPreviewBusy, setEpubPreviewBusy] = useState(false),
    [exportScope, setExportScope] = useState<"all" | "volume" | "chapter">(
      "all",
    ),
    [epubLayout, setEpubLayout] = useState<"standard" | "compact" | "no-indent" | "custom">("standard"),
    [epubCustomLayout, setEpubCustomLayout] = useState<EpubCustomLayout>(DEFAULT_EPUB_CUSTOM_LAYOUT),
    [autoCfg, setAutoCfg] = useState<any>({
      enabled: false,
      directory: "",
      intervalMinutes: 30,
      keep: 10,
    }),
    [autoLast, setAutoLast] = useState<any>(null),
    // 导入作品命名弹窗的初值；null 表示未打开
    [importTitleEdit, setImportTitleEdit] = useState<string | null>(null);
  useEffect(() => {
    api("novels:open", novel.id).then(
      (r) => {
        if (!r.ok) return;
        setBookChapters(r.data.chapters || []);
        setBookVolumes(r.data.volumes || []);
      },
    );
  }, [novel.id]);
  const orderedChapters = bookChapters.slice().sort((a, b) => {
    const volumeOrder = new Map(bookVolumes.map((volume, index) => [volume.id, Number(volume.sort_order ?? index)]));
    const aVolumeOrder = a.volume_id ? volumeOrder.get(a.volume_id) ?? 0 : -1;
    const bVolumeOrder = b.volume_id ? volumeOrder.get(b.volume_id) ?? 0 : -1;
    return aVolumeOrder - bVolumeOrder || Number(a.sort_order || 0) - Number(b.sort_order || 0);
  });
  const volumeChapterIds = chapter?.volume_id
    ? orderedChapters.filter((c) => c.volume_id === chapter.volume_id).map((c) => c.id)
    : [];
  const scopedChapters = exportScope === "chapter"
    ? orderedChapters.filter((item) => item.id === chapter?.id)
    : exportScope === "volume"
      ? orderedChapters.filter((item) => item.volume_id === chapter?.volume_id)
      : orderedChapters;
  const epubPreviewChapterIndex = scopedChapters.findIndex((item) => item.id === epubPreviewChapterId);
  const epubTocPageSize = 100;
  const epubTocPageCount = Math.max(1, Math.ceil(scopedChapters.length / epubTocPageSize));
  const epubTocStart = epubTocPage * epubTocPageSize;
  const epubTocChapters = scopedChapters.slice(epubTocStart, epubTocStart + epubTocPageSize);
  const load = () =>
    api("backup:list", novel.id).then((r) => r.ok && setBackups(r.data));
  useEffect(() => {
    load();
  }, [novel.id]);
  useEffect(() => {
    api<any>("preferences:get", "epubLayout").then((r) => {
      if (r.ok && ["standard", "compact", "no-indent", "custom"].includes(r.data))
        setEpubLayout(r.data);
    });
    api<any>("preferences:get", "epubCustomLayout").then((r) => {
      if (r.ok && r.data) setEpubCustomLayout(normalizeEpubCustomLayout(r.data));
    });
    api<any>("preferences:get", "autoBackup").then((r) => {
      if (r.ok && r.data) setAutoCfg((c: any) => ({ ...c, ...r.data }));
    });
    api<any>("preferences:get", "autoBackupLast").then(
      (r) => r.ok && setAutoLast(r.data),
    );
  }, []);
  useEffect(
    () => window.zhuwen.onImportProgress((progress) => setImportProgress(progress)),
    [],
  );
  useEffect(() => {
    if (!epubPreviewOpen || !epubPreviewChapterId) return;
    let active = true;
    setEpubPreviewBusy(true);
    setEpubPreviewChapter(null);
    api<any>("chapters:get", epubPreviewChapterId).then((result) => {
      if (!active) return;
      setEpubPreviewBusy(false);
      if (result.ok) setEpubPreviewChapter(result.data);
      else notify(result.error || tr("读取章节预览失败", "Could not load chapter preview"));
    });
    return () => { active = false; };
  }, [epubPreviewOpen, epubPreviewChapterId, notify, language]);
  useEffect(() => {
    epubPreviewReaderRef.current?.scrollTo({ top: 0 });
  }, [epubPreviewOpen, epubPreviewPage, epubPreviewChapterId]);
  async function saveAuto(next: any) {
    const previous = autoCfg;
    setAutoCfg(next);
    const r = await api("preferences:set", { key: "autoBackup", value: next });
    if (!r.ok) {
      setAutoCfg(previous);
      notify(r.error || tr("自动备份设置保存失败", "Could not save automatic backup settings"));
    }
  }
  async function changeEpubLayout(next: "standard" | "compact" | "no-indent" | "custom") {
    const previous = epubLayout;
    setEpubLayout(next);
    const r = await api("preferences:set", { key: "epubLayout", value: next });
    if (!r.ok) {
      setEpubLayout(previous);
      notify(r.error || tr("EPUB 排版偏好保存失败", "Could not save EPUB layout preference"));
    }
  }
  async function saveEpubCustomLayout(next: EpubCustomLayout) {
    const result = await api("preferences:set", { key: "epubCustomLayout", value: next });
    if (!result.ok)
      notify(result.error || tr("自定义 EPUB 排版保存失败", "Could not save custom EPUB layout"));
  }
  async function exp(format: string) {
    if (operationBusy) return;
    let chapterIds: string[] | undefined;
    if (exportScope === "chapter") {
      if (!chapter) return notify(tr("当前没有选中章节", "No chapter is selected"));
      chapterIds = [chapter.id];
    } else if (exportScope === "volume") {
      if (!volumeChapterIds.length) return notify(tr("当前章节不在任何卷中", "The current chapter is not in a volume"));
      chapterIds = volumeChapterIds;
    }
    setOperationBusy(`export:${format}`);
    const r = await api("export:novel", {
      novelId: novel.id,
      title: novel.title,
      format,
      includeTitle: true,
      includeAuthor: true,
      includeVolume: true,
      includeChapter: true,
      encoding: "utf8",
      epubLayout,
      epubCustomLayout,
      chapterIds,
    });
    setOperationBusy("");
    if (r.ok && r.data) {
      notify(tr(`已导出到 ${r.data.file}`, `Exported to ${r.data.file}`));
      if (format === "epub") setEpubPreviewOpen(false);
    }
    else if (!r.ok) notify(r.error || tr("导出失败", "Export failed"));
  }
  const previewPreset = {
    standard: { lineHeight: 1.8, marginPercent: 5, paragraphGapEm: 0.65, indentEm: 2 },
    compact: { lineHeight: 1.65, marginPercent: 4, paragraphGapEm: 0.3, indentEm: 2 },
    "no-indent": { lineHeight: 2, marginPercent: 6, paragraphGapEm: 0.9, indentEm: 0 },
  } as const;
  const previewLayout = epubLayout === "custom" ? epubCustomLayout : previewPreset[epubLayout];
  const previewBlocks = epubPreviewChapter
    ? renderPreviewBlocks(epubPreviewChapter, previewLayout, String(epubPreviewChapter.plain_text || ""))
    : [];
  return (
    <div className="io">
      <section>
        <h3>{tr("稿件导出", "Manuscript export")}</h3>
        <p className="hint">
          {tr("按卷和章节顺序导出正文，不包含 AI 对话和创作资料。", "Exports manuscript text in volume and chapter order, without AI conversations or story-bible items.")}
        </p>
        <p className="hint">
          {tr("EPUB 包含目录与章节导航；有作品封面时会嵌入封面页。正文插图暂不导出。", "EPUB includes a table of contents and chapter navigation. The novel cover is embedded when available; inline illustrations are not exported yet.")}
        </p>
        <label>
          {tr("导出范围", "Export scope")}
          <Select
            value={exportScope}
            aria-label={tr("导出范围", "Export scope")}
            onValueChange={(v) => setExportScope(v as any)}
            options={[
              { value: "all", label: tr("整本小说", "Entire novel") },
              {
                value: "volume",
                label: tr("当前卷", "Current volume"),
                hint: chapter?.volume_id
                  ? undefined
                  : tr("当前章节未分卷", "Chapter has no volume"),
                disabled: !volumeChapterIds.length,
              },
              {
                value: "chapter",
                label: tr("当前章节", "Current chapter"),
                disabled: !chapter,
              },
            ]}
          />
        </label>
        <label>
          {tr("EPUB 排版（仅影响 EPUB）", "EPUB layout (EPUB only)")}
          <Select
            value={epubLayout}
            aria-label={tr("EPUB 排版", "EPUB layout")}
            onValueChange={(value) => void changeEpubLayout(value as typeof epubLayout)}
            options={[
              { value: "standard", label: tr("标准阅读", "Standard reading"), hint: tr("舒适行距与首行缩进", "Balanced spacing with first-line indents") },
              { value: "compact", label: tr("网文连载", "Web serial"), hint: tr("更紧凑的段落间距", "Tighter paragraph spacing") },
              { value: "no-indent", label: tr("舒展无缩进", "Open, no indent"), hint: tr("较宽行距与段间距", "More line and paragraph spacing") },
              { value: "custom", label: tr("自定义版式", "Custom layout"), hint: tr("调整行距、页边距和段落格式", "Tune line spacing, margins, and paragraphs") },
            ]}
          />
        </label>
        {epubLayout === "custom" && (
          <div className="epub-custom-layout" data-fd-id="epub-custom-layout">
            {([
              ["lineHeight", tr("行距", "Line spacing"), 1.4, 2.4, 0.1, `${epubCustomLayout.lineHeight.toFixed(1)}×`],
              ["marginPercent", tr("页边距", "Page margin"), 3, 12, 1, `${epubCustomLayout.marginPercent}%`],
              ["paragraphGapEm", tr("段落间距", "Paragraph spacing"), 0, 1.5, 0.1, `${epubCustomLayout.paragraphGapEm.toFixed(1)}em`],
              ["indentEm", tr("首行缩进", "First-line indent"), 0, 3, 0.5, `${epubCustomLayout.indentEm.toFixed(1)}em`],
            ] as const).map(([key, label, min, max, step, value]) => (
              <label className="epub-layout-control" key={key}>
                <span>{label}<output>{value}</output></span>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={epubCustomLayout[key]}
                  aria-label={label}
                  onChange={(event) => {
                    const next = normalizeEpubCustomLayout({ ...epubCustomLayout, [key]: Number(event.target.value) });
                    setEpubCustomLayout(next);
                  }}
                  onPointerUp={() => void saveEpubCustomLayout(epubCustomLayout)}
                  onKeyUp={() => void saveEpubCustomLayout(epubCustomLayout)}
                />
              </label>
            ))}
            <div
              className="epub-layout-preview"
              style={{
                lineHeight: epubCustomLayout.lineHeight,
                paddingInline: `${epubCustomLayout.marginPercent}%`,
              }}
            >
              <strong>{tr("排版预览", "Layout preview")}</strong>
              <p style={{ marginBottom: `${epubCustomLayout.paragraphGapEm}em`, textIndent: `${epubCustomLayout.indentEm}em` }}>
                {tr("夜雨落在旧城的瓦檐上。她把信折好，收进袖中，决定天亮前离开。", "Rain tapped the old rooftops. She folded the letter, slipped it into her sleeve, and decided to leave before dawn.")}
              </p>
              <p style={{ marginBottom: 0, textIndent: `${epubCustomLayout.indentEm}em` }}>
                {tr("这段示例会随上方参数变化，实际导出采用相同设置。", "This sample follows the settings above; the EPUB export uses the same values.")}
              </p>
            </div>
          </div>
        )}
        <div className="row io-export-actions" data-fd-id="manuscript-export-formats">
          <button disabled={Boolean(operationBusy)} onClick={() => exp("txt")}>
            {operationBusy === "export:txt" ? tr("正在导出…", "Exporting…") : tr("导出 TXT", "Export TXT")}
          </button>
          <button disabled={Boolean(operationBusy)} onClick={() => exp("md")}>
            {operationBusy === "export:md" ? tr("正在导出…", "Exporting…") : tr("导出 Markdown", "Export Markdown")}
          </button>
          <button disabled={Boolean(operationBusy)} onClick={() => exp("docx")}>
            {operationBusy === "export:docx" ? tr("正在导出…", "Exporting…") : tr("导出 DOCX", "Export DOCX")}
          </button>
          <button
            disabled={Boolean(operationBusy) || !scopedChapters.length}
            onClick={() => {
              if (!scopedChapters.length) return notify(tr("当前范围没有可预览的章节", "No chapters are available in this export scope"));
              setEpubPreviewChapterId(scopedChapters[0].id);
              setEpubPreviewPage("cover");
              setEpubTocPage(0);
              setEpubPreviewOpen(true);
            }}
          >
            {tr("预览并导出 EPUB", "Preview & export EPUB")}
          </button>
        </div>
      </section>
      <section>
        <h3>{tr("完整项目备份", "Full project backup")}</h3>
        <p className="hint">
          {tr("包含小说、章节、资料和 AI 会话；不包含 API Key。恢复时创建独立副本，不覆盖当前作品。", "Includes the novel, chapters, story bible, and AI conversations, but not API keys. Restoring creates a separate copy.")}
        </p>
        <div
          className={`backup-banner ${
            backups.length
              ? "ok"
              : autoCfg?.enabled
                ? "warn"
                : ""
          }`}
          style={{ marginBottom: 12 }}
        >
          {backups.length ? (
            <>
              <span>✓</span>
              <span>
                {tr("最近备份", "Last backup")}: {time(backups[0].created_at, language)}
                {backups[0].size
                  ? ` · ${(backups[0].size / 1024 / 1024).toFixed(2)} MB`
                  : ""}
              </span>
            </>
          ) : autoCfg?.enabled ? (
            <>
              <span>◌</span>
              <span>
                {tr(
                  `自动备份已启用（每 ${autoCfg.intervalMinutes} 分钟），尚无本作品备份记录`,
                  `Auto backup every ${autoCfg.intervalMinutes} min — no backup for this novel yet`,
                )}
              </span>
            </>
          ) : (
            <>
              <span>!</span>
              <span>
                {tr(
                  "尚未创建备份。建议立即创建一份，并开启自动备份。",
                  "No backup yet. Create one now and consider enabling auto backup.",
                )}
              </span>
            </>
          )}
        </div>
        <div className="row">
          <button
            disabled={Boolean(operationBusy)}
            onClick={async () => {
              setOperationBusy("backup");
              const r = await api("backup:create", { novelId: novel.id });
              setOperationBusy("");
              if (r.ok && r.data) {
                notify(tr(`备份完成：${r.data.file}`, `Backup complete: ${r.data.file}`));
                load();
              } else if (!r.ok) notify(r.error || tr("备份失败", "Backup failed"));
            }}
          >
            {operationBusy === "backup" ? tr("正在备份…", "Backing up…") : tr("创建备份", "Create backup")}
          </button>
          <button
            disabled={Boolean(operationBusy)}
            onClick={async () => {
              setOperationBusy("restore");
              const r = await api("backup:restore");
              setOperationBusy("");
              if (r.ok && r.data) {
                notify(tr("备份已恢复为新作品", "Backup restored as a new novel"));
                onImported();
              } else if (!r.ok) notify(r.error || tr("恢复失败", "Restore failed"));
            }}
          >
            {operationBusy === "restore" ? tr("正在恢复…", "Restoring…") : tr("从备份恢复", "Restore backup")}
          </button>
        </div>
        {backups.slice(0, 5).map((b) => (
          <small className="backup-row" key={b.id}>
            {b.status === "auto" ? tr("自动 ", "Automatic ") : ""}
            {time(b.created_at, language)}　{b.file_path}
          </small>
        ))}
      </section>
      <section>
        <h3>{tr("自动备份", "Automatic backup")}</h3>
        <p className="hint">
          {tr("开启后按周期把全部未删除作品备份到所选目录，仅保留每部作品最近的若干份；文件名带时间，不会覆盖旧备份，也不包含 API Key。", "Periodically backs up every active novel to the selected directory and keeps the latest copies. Timestamped files do not overwrite older backups and never include API keys.")}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={autoCfg.enabled}
            onChange={(e) =>
              saveAuto({ ...autoCfg, enabled: e.target.checked })
            }
          />
          {tr("启用自动备份", "Enable automatic backup")}
        </label>
        <label>
          {tr("备份目录", "Backup directory")}
          <div className="row">
            <input
              value={autoCfg.directory}
              readOnly
              placeholder={tr("尚未选择备份目录", "No backup directory selected")}
            />
            <button
              onClick={async () => {
                const r = await api<any>("backup:chooseDir");
                if (r.ok && r.data)
                  saveAuto({ ...autoCfg, directory: r.data.directory });
                else if (!r.ok) notify(r.error || tr("选择目录失败", "Could not choose directory"));
              }}
            >
              {tr("选择目录", "Choose directory")}
            </button>
          </div>
        </label>
        <div className="grid2">
          <label>
            {tr("周期（分钟）", "Interval (minutes)")}
            <input
              type="number"
              min="1"
              max="10080"
              value={autoCfg.intervalMinutes}
              onChange={(e) =>
                saveAuto({
                  ...autoCfg,
                  intervalMinutes: Math.min(10080, Math.max(1, +e.target.value || 1)),
                })
              }
            />
          </label>
          <label>
            {tr("每部保留份数", "Copies per novel")}
            <input
              type="number"
              min="1"
              max="100"
              value={autoCfg.keep}
              onChange={(e) =>
                saveAuto({ ...autoCfg, keep: Math.min(100, Math.max(1, +e.target.value || 1)) })
              }
            />
          </label>
        </div>
        <div className="row end">
          <button
            disabled={Boolean(operationBusy)}
            onClick={async () => {
              setOperationBusy("auto");
              const r = await api<any>("backup:runAutoNow");
              setOperationBusy("");
              if (r.ok) {
                notify(tr(`已备份 ${r.data.count} 部作品`, `Backed up ${r.data.count} novels`));
                load();
                api<any>("preferences:get", "autoBackupLast").then(
                  (x) => x.ok && setAutoLast(x.data),
                );
              } else notify(r.error || tr("自动备份失败", "Automatic backup failed"));
            }}
          >
            {operationBusy === "auto" ? tr("正在备份…", "Backing up…") : tr("立即备份一次", "Back up now")}
          </button>
        </div>
        <p className="hint">
          {autoLast
            ? `${autoLast.ok ? tr("上次成功", "Last succeeded") : tr("上次失败", "Last failed")}：${time(autoLast.at, language)}${
                autoLast.ok
                  ? tr(`，共 ${autoLast.count} 部`, `, ${autoLast.count} novels`)
                  : `，${autoLast.error}`
              }`
            : tr("尚无自动备份记录。", "No automatic backup has run yet.")}
        </p>
      </section>
      <section>
        <h3>{tr("导入文本", "Import manuscript")}</h3>
        <p className="hint">
          {tr("支持 UTF-8/常见中文编码的 TXT、Markdown，以及 DOCX，自动识别“第…章/卷”等标题；导入会创建新作品，不覆盖当前稿件。", "Supports TXT and Markdown in UTF-8 or common Chinese encodings, plus DOCX. Chapter headings are detected automatically and importing creates a new novel.")}
        </p>
        <p className="hint">
          {tr("DOCX 仅提取正文段落文字：忽略字体样式、图片、表格、批注、页眉页脚和分页，复杂版式可能不被保留。", "DOCX imports paragraph text only. Fonts, images, tables, comments, headers, footers, and pagination are not preserved.")}
        </p>
        <div className="row">
          <button
            disabled={importBusy}
            onClick={async () => {
              setImportBusy(true);
              setImportProgress({ read: 0, total: 0 });
              const r = await api("import:text");
              setImportBusy(false);
              if (r.ok) setImported(r.data);
              else if (r.error !== "IMPORT_CANCELLED")
                notify(r.error || tr("读取失败", "Could not read file"));
            }}
          >
            {importBusy ? tr("正在读取并分章…", "Reading and splitting chapters…") : tr("选择文件并预览", "Choose file and preview")}
          </button>
          {importBusy && (
            <button
              onClick={async () => {
                await api("import:cancel");
                setImportBusy(false);
                setImportProgress({ read: 0, total: 0 });
              }}
            >
              {tr("停止读取", "Cancel")}
            </button>
          )}
        </div>
        {importBusy && importProgress.total > 0 && (
          <div className="import-progress" aria-live="polite">
            <div><i style={{ width: `${Math.min(100, (importProgress.read / importProgress.total) * 100)}%` }} /></div>
            <small>{Math.round((importProgress.read / importProgress.total) * 100)}% · {(importProgress.read / 1024 / 1024).toFixed(1)} / {(importProgress.total / 1024 / 1024).toFixed(1)} MB</small>
          </div>
        )}
        {imported && (
          <div className="import-preview">
            <b>{tr(`识别到 ${imported.parts.length} 个章节`, `${imported.parts.length} chapters detected`)}</b>
            {imported.encoding === "docx" ? (
              <small>{tr("文档类型：DOCX", "Document type: DOCX")}</small>
            ) : (
              <label>
                {tr("文本编码", "Text encoding")}
                <Select
                  value={imported.encoding}
                  aria-label={tr("文本编码", "Text encoding")}
                  onValueChange={async (encoding) => {
                    setImportBusy(true);
                    setImportProgress({ read: 0, total: 0 });
                    const result = await api<any>("import:decode", {
                      token: imported.token,
                      encoding,
                    });
                    setImportBusy(false);
                    if (result.ok) setImported({ ...imported, ...result.data });
                    else if (result.error !== "IMPORT_CANCELLED")
                      notify(result.error || tr("切换编码失败", "Could not change encoding"));
                  }}
                  options={[
                    { value: "utf-8", label: "UTF-8" },
                    { value: "gb18030", label: "GB18030 / GBK" },
                    { value: "utf-16le", label: "UTF-16LE" },
                  ]}
                />
              </label>
            )}
            <div>
              {imported.parts.slice(0, 20).map((x: any, i: number) => (
                <input
                  key={i}
                  value={x.title}
                  onChange={(e) => {
                    const parts = [...imported.parts];
                    parts[i] = { ...parts[i], title: e.target.value };
                    setImported({ ...imported, parts });
                  }}
                />
              ))}
            </div>
            <button
              className="primary"
              onClick={() =>
                setImportTitleEdit(
                  imported.path
                    .split(/[\\/]/)
                    .pop()
                    .replace(/\.[^.]+$/, ""),
                )
              }
            >
              {tr("确认导入为新作品", "Import as new novel")}
            </button>
          </div>
        )}
      </section>
      {importTitleEdit !== null && (
        <PromptDialog
          title={tr("导入后的作品名称", "Name for imported novel")}
          label={tr("作品名称", "Novel title")}
          initial={importTitleEdit}
          confirmLabel={tr("导入", "Import")}
          cancelLabel={tr("取消", "Cancel")}
          onCancel={() => setImportTitleEdit(null)}
          onConfirm={async (title) => {
            setImportTitleEdit(null);
            if (!title) return;
            const r = await api("import:commit", {
              title,
              token: imported.token,
              parts: imported.parts,
            });
            if (r.ok) {
              notify(tr("导入完成，已创建新作品", "Import complete; a new novel was created"));
              onImported();
            } else notify(r.error || tr("导入失败", "Import failed"));
          }}
        />
      )}
      {epubPreviewOpen && (
        <Modal
          title={tr("EPUB 成书预览", "EPUB book preview")}
          close={() => setEpubPreviewOpen(false)}
        >
          <div className="epub-preview-dialog">
            <div className="epub-preview-toolbar">
              <div className="epub-preview-tabs" role="group" aria-label={tr("预览页面", "Preview page")}>
                {([
                  ["cover", tr("封面", "Cover")],
                  ["toc", tr("目录", "Contents")],
                  ["chapter", tr("正文", "Chapter")],
                ] as const).map(([page, label]) => (
                  <button
                    type="button"
                    key={page}
                    className={epubPreviewPage === page ? "active" : ""}
                    aria-pressed={epubPreviewPage === page}
                    onClick={() => setEpubPreviewPage(page)}
                  >{label}</button>
                ))}
              </div>
              <label>
                {tr("预览章节", "Preview chapter")}
                <Select
                  value={epubPreviewChapterId}
                  aria-label={tr("选择预览章节", "Choose preview chapter")}
                  onValueChange={(id) => {
                    setEpubPreviewChapterId(id);
                    setEpubPreviewPage("chapter");
                  }}
                  options={scopedChapters.map((item) => ({
                    value: item.id,
                    label: `${bookVolumes.find((volume) => volume.id === item.volume_id)?.title ? `${bookVolumes.find((volume) => volume.id === item.volume_id)?.title} · ` : ""}${item.title}`,
                  }))}
                />
              </label>
              <div className="epub-preview-nav">
                <button
                  type="button"
                  aria-label={tr("上一章", "Previous chapter")}
                  title={tr("上一章", "Previous chapter")}
                  disabled={epubPreviewChapterIndex <= 0}
                  onClick={() => {
                    setEpubPreviewChapterId(scopedChapters[epubPreviewChapterIndex - 1]?.id || "");
                    setEpubPreviewPage("chapter");
                  }}
                >‹</button>
                <span>{epubPreviewChapterIndex >= 0 ? `${epubPreviewChapterIndex + 1} / ` : ""}{scopedChapters.length} {tr("章", "chapters")}</span>
                <button
                  type="button"
                  aria-label={tr("下一章", "Next chapter")}
                  title={tr("下一章", "Next chapter")}
                  disabled={epubPreviewChapterIndex < 0 || epubPreviewChapterIndex >= scopedChapters.length - 1}
                  onClick={() => {
                    setEpubPreviewChapterId(scopedChapters[epubPreviewChapterIndex + 1]?.id || "");
                    setEpubPreviewPage("chapter");
                  }}
                >›</button>
              </div>
            </div>
            <div className="epub-preview-reader" ref={epubPreviewReaderRef}>
              {epubPreviewPage === "cover" && <>
                {novel.cover_path && String(novel.cover_path).startsWith("data:image/") ? (
                  <div className="epub-preview-cover"><img src={novel.cover_path} alt={tr(`${novel.title || "作品"}封面`, `${novel.title || "Novel"} cover`)} /></div>
                ) : (
                  <div className="epub-preview-cover epub-preview-cover-empty">{tr("无封面", "No cover")}</div>
                )}
                <header className="epub-preview-titlepage">
                  <h2>{novel.title || tr("未命名作品", "Untitled novel")}</h2>
                  {novel.author && <p>{novel.author}</p>}
                </header>
              </>}
              {epubPreviewPage === "toc" && (
                <nav className="epub-preview-toc" aria-label={tr("EPUB 目录预览", "EPUB table of contents preview")}>
                  <h2>{tr("目录", "Contents")}</h2>
                  <div className="epub-preview-toc-pages">
                    <button type="button" disabled={epubTocPage <= 0} onClick={() => setEpubTocPage((page) => Math.max(0, page - 1))}>{tr("上一页", "Previous")}</button>
                    <span>{scopedChapters.length ? `${epubTocStart + 1}–${Math.min(epubTocStart + epubTocPageSize, scopedChapters.length)}` : "0"} / {scopedChapters.length} · {epubTocPage + 1}/{epubTocPageCount}</span>
                    <button type="button" disabled={epubTocPage >= epubTocPageCount - 1} onClick={() => setEpubTocPage((page) => Math.min(epubTocPageCount - 1, page + 1))}>{tr("下一页", "Next")}</button>
                  </div>
                  <ol>
                    {epubTocChapters.map((item, pageIndex) => {
                      const index = epubTocStart + pageIndex;
                      return (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={item.id === epubPreviewChapterId ? "active" : ""}
                          aria-current={item.id === epubPreviewChapterId ? "location" : undefined}
                          onClick={() => {
                            setEpubPreviewChapterId(item.id);
                            setEpubPreviewPage("chapter");
                          }}
                        >
                          <span className="epub-preview-toc-number">{String(index + 1).padStart(2, "0")}</span>
                          <span>{item.title || tr(`第 ${index + 1} 章`, `Chapter ${index + 1}`)}</span>
                          {item.volume_id && bookVolumes.find((volume) => volume.id === item.volume_id)?.title && (
                            <small>{bookVolumes.find((volume) => volume.id === item.volume_id)?.title}</small>
                          )}
                        </button>
                      </li>
                      );
                    })}
                  </ol>
                </nav>
              )}
              {epubPreviewPage === "chapter" && <>
              {epubPreviewBusy ? (
                <p className="hint" role="status">{tr("正在读取章节…", "Loading chapter…")}</p>
              ) : epubPreviewChapter ? (
                <article
                  className="epub-preview-content"
                  style={{
                    lineHeight: previewLayout.lineHeight,
                    paddingInline: `${previewLayout.marginPercent}%`,
                  }}
                >
                  {epubPreviewChapter.volume_id && bookVolumes.find((volume) => volume.id === epubPreviewChapter.volume_id)?.title && (
                    <p className="epub-preview-volume">{bookVolumes.find((volume) => volume.id === epubPreviewChapter.volume_id)?.title}</p>
                  )}
                  <h3>{epubPreviewChapter.title}</h3>
                  {previewBlocks.length ? previewBlocks : <p className="hint">{tr("本章暂无正文。", "This chapter has no text yet.")}</p>}
                  {hasMorePreviewBlocks(epubPreviewChapter) && (
                    <p className="epub-preview-truncated">{tr("仅显示前 36 段预览；导出会包含本章全文。", "Preview shows the first 36 paragraphs; export includes the full chapter.")}</p>
                  )}
                </article>
              ) : (
                <p className="hint" role="alert">{tr("无法加载预览章节。", "Could not load the preview chapter.")}</p>
              )}
              </>}
            </div>
            <div className="row end epub-preview-actions">
              <button type="button" onClick={() => setEpubPreviewOpen(false)}>{tr("返回修改设置", "Back to settings")}</button>
              <button type="button" className="primary" disabled={Boolean(operationBusy) || epubPreviewBusy} onClick={() => void exp("epub")}>
                {operationBusy === "export:epub" ? tr("正在生成…", "Generating…") : tr("确认导出 EPUB", "Export EPUB")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
