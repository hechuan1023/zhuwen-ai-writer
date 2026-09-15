import { useEffect, useState } from "react";
import { api, fmt, time, Empty, DiffModal, ConfirmDialog, AnyRow, UiLanguage } from "./shared";

export function HistoryPanel({
  chapter,
  reload,
  notify,
  language = "zh-CN",
}: {
  chapter: AnyRow | null;
  reload: () => void;
  notify: (s: string) => void;
  language?: UiLanguage;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [rows, setRows] = useState<AnyRow[]>([]),
    [preview, setPreview] = useState<AnyRow | null>(null),
    [diffOpen, setDiffOpen] = useState(false),
    [restoreOpen, setRestoreOpen] = useState(false);
  const load = () =>
    chapter &&
    api("revisions:list", chapter.id).then((r) => r.ok && setRows(r.data));
  useEffect(() => {
    load();
  }, [chapter?.id]);
  return (
    <>
      <div className="panel-head">
        <strong>{tr("整章历史版本", "Chapter history")}</strong>
        <button
          onClick={async () => {
            if (chapter) {
              const r = await api("revisions:create", {
                chapterId: chapter.id,
                source: "manual",
              });
              if (r.ok) {
                notify(tr("历史版本已创建", "History snapshot created"));
                load();
              } else notify(r.error || tr("历史版本创建失败", "Could not create history snapshot"));
            }
          }}
        >
          {tr("创建快照", "Create snapshot")}
        </button>
      </div>
      {preview ? (
        <div className="revision-preview">
          <button
            onClick={() => {
              setPreview(null);
              setDiffOpen(false);
            }}
          >
            ← {tr("返回", "Back")}
          </button>
          <pre>{preview.plain_text}</pre>
          <div className="row">
            <button
              disabled={!chapter}
              onClick={() => setDiffOpen(true)}
            >
              {tr("与当前正文对比", "Compare with current manuscript")}
            </button>
            <button
              className="primary"
              onClick={() => setRestoreOpen(true)}
            >
              {tr("恢复此版本", "Restore this version")}
            </button>
          </div>
          {diffOpen && (
            <DiffModal
              title={tr("历史版本与当前正文对比", "History version vs current manuscript")}
              beforeLabel={tr("历史版本", "History version")}
              afterLabel={tr("当前正文", "Current manuscript")}
              before={preview.plain_text}
              after={chapter?.plain_text || ""}
              close={() => setDiffOpen(false)}
            />
          )}
        </div>
      ) : (
        <div className="history-list">
          {rows.map((x) => (
            <button
              key={x.id}
              onClick={() =>
                api("revisions:preview", x.id).then(
                  (r) => r.ok && setPreview(r.data),
                )
              }
            >
              <b>{sourceName(x.source, language)}</b>
              <span>
                {time(x.created_at, language)} · {fmt(x.word_count)} {tr("字", "words")}
              </span>
            </button>
          ))}
          {!rows.length && (
            <Empty
              title={tr("暂无历史版本", "No history yet")}
              text={tr("定期保存、AI 替换和恢复操作会在这里留下整章快照。", "Periodic saves, AI replacements, and restore operations leave full-chapter snapshots here.")}
            />
          )}
        </div>
      )}
      {restoreOpen && preview && (
        <ConfirmDialog
          title={tr("恢复历史版本", "Restore history version")}
          message={tr(
            "恢复前会先保存当前正文为历史版本。继续？",
            "The current manuscript will be saved as a history snapshot first. Continue?",
          )}
          confirmLabel={tr("恢复此版本", "Restore this version")}
          cancelLabel={tr("取消", "Cancel")}
          onCancel={() => setRestoreOpen(false)}
          onConfirm={async () => {
            const target = preview;
            setRestoreOpen(false);
            if (!target) return;
            const r = await api("revisions:restore", target.id);
            if (r.ok) {
              notify(tr("已恢复历史版本", "History version restored"));
              reload();
            } else
              notify(
                r.error ||
                  tr("历史版本恢复失败", "Could not restore history version"),
              );
          }}
        />
      )}
    </>
  );
}

export const sourceName = (x: string, language: UiLanguage = "zh-CN") =>
  language === "en"
    ? ({ manual: "Manual snapshot", before_ai_apply: "Before AI change", before_restore: "Before restore" } as any)[x] || "Automatic snapshot"
    : ({ manual: "手动快照", before_ai_apply: "AI 修改前", before_restore: "恢复前" } as any)[x] || "自动快照";
