import { useEffect, useState } from "react";
import { api, time, AnyRow, UiLanguage } from "./shared";
import { Select } from "./select";

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
  const [imported, setImported] = useState<any>(null),
    [importBusy, setImportBusy] = useState(false),
    [operationBusy, setOperationBusy] = useState(""),
    [importProgress, setImportProgress] = useState({ read: 0, total: 0 }),
    [backups, setBackups] = useState<AnyRow[]>([]),
    [bookChapters, setBookChapters] = useState<AnyRow[]>([]),
    [exportScope, setExportScope] = useState<"all" | "volume" | "chapter">(
      "all",
    ),
    [autoCfg, setAutoCfg] = useState<any>({
      enabled: false,
      directory: "",
      intervalMinutes: 30,
      keep: 10,
    }),
    [autoLast, setAutoLast] = useState<any>(null);
  useEffect(() => {
    api("novels:open", novel.id).then(
      (r) => r.ok && setBookChapters(r.data.chapters),
    );
  }, [novel.id]);
  const volumeChapterIds = chapter?.volume_id
    ? bookChapters
        .filter((c) => c.volume_id === chapter.volume_id)
        .map((c) => c.id)
    : [];
  const load = () =>
    api("backup:list", novel.id).then((r) => r.ok && setBackups(r.data));
  useEffect(() => {
    load();
  }, [novel.id]);
  useEffect(() => {
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
  async function saveAuto(next: any) {
    const previous = autoCfg;
    setAutoCfg(next);
    const r = await api("preferences:set", { key: "autoBackup", value: next });
    if (!r.ok) {
      setAutoCfg(previous);
      notify(r.error || tr("自动备份设置保存失败", "Could not save automatic backup settings"));
    }
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
    setOperationBusy("export");
    const r = await api("export:novel", {
      novelId: novel.id,
      title: novel.title,
      format,
      includeTitle: true,
      includeAuthor: true,
      includeVolume: true,
      includeChapter: true,
      encoding: "utf8",
      chapterIds,
    });
    setOperationBusy("");
    if (r.ok && r.data) notify(tr(`已导出到 ${r.data.file}`, `Exported to ${r.data.file}`));
    else if (!r.ok) notify(r.error || tr("导出失败", "Export failed"));
  }
  return (
    <div className="io">
      <section>
        <h3>{tr("稿件导出", "Manuscript export")}</h3>
        <p className="hint">
          {tr("按卷和章节顺序导出正文，不包含 AI 对话和创作资料。", "Exports manuscript text in volume and chapter order, without AI conversations or story-bible items.")}
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
        <div className="row">
          <button disabled={Boolean(operationBusy)} onClick={() => exp("txt")}>{tr("导出 TXT", "Export TXT")}</button>
          <button disabled={Boolean(operationBusy)} onClick={() => exp("md")}>{tr("导出 Markdown", "Export Markdown")}</button>
          <button disabled={Boolean(operationBusy)} onClick={() => exp("docx")}>
            {operationBusy === "export" ? tr("正在导出…", "Exporting…") : tr("导出 DOCX", "Export DOCX")}
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
              onClick={async () => {
                const title = prompt(
                  tr("导入后的作品名称", "Name for imported novel"),
                  imported.path
                    .split(/[\\/]/)
                    .pop()
                    .replace(/\.[^.]+$/, ""),
                );
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
            >
              {tr("确认导入为新作品", "Import as new novel")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
