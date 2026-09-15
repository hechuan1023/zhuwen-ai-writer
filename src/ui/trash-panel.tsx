import { useEffect, useState } from "react";
import { api, time, Empty, PromptDialog, AnyRow, UiLanguage } from "./shared";
import { isPurgeConfirmed, purgeConfirmWord } from "./trash-confirm";

export function TrashPanel({
  novel,
  reload,
  notify,
  language = "zh-CN",
}: {
  novel: AnyRow;
  reload: () => void;
  notify: (s: string) => void;
  language?: UiLanguage;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [data, setData] = useState<any>({
    chapters: [],
    volumes: [],
    library: [],
  });
  // 永久删除的强确认词；见 trash-confirm.ts，须与服务端校验一致
  const purgeWord = purgeConfirmWord(language);
  const [purgeTarget, setPurgeTarget] = useState<AnyRow | null>(null);
  const load = () =>
    api("trash:list", novel.id).then((r) => r.ok && setData(r.data));
  useEffect(() => {
    load();
  }, [novel.id]);
  const rows = [
    ...data.volumes.map((x: any) => ({ ...x, kind: "volume", type: tr("卷", "Volume") })),
    ...data.chapters.map((x: any) => ({ ...x, kind: "chapter", type: tr("章节", "Chapter") })),
    ...data.library.map((x: any) => ({ ...x, kind: "library", type: tr("资料", "Story-bible item") })),
  ];
  return (
    <>
      <div className="panel-head">
        <strong>{tr("回收站", "Trash")}</strong>
      </div>
      <div className="trash-list">
        {rows.map((x) => (
          <div key={x.id}>
            <span>
              <b>{x.title}</b>
              <small>
                {x.type} · {time(x.deleted_at, language)}
              </small>
            </span>
            <button
              onClick={async () => {
                const r = await api("trash:restore", { kind: x.kind, id: x.id });
                if (r.ok) {
                  load();
                  reload();
                  notify(tr("已恢复", "Restored"));
                } else notify(r.error || tr("恢复失败", "Restore failed"));
              }}
            >
              {tr("恢复", "Restore")}
            </button>
            <button
              className="danger-text"
              onClick={() => setPurgeTarget(x)}
            >
              {tr("永久删除", "Delete permanently")}
            </button>
          </div>
        ))}
        {!rows.length && (
          <Empty title={tr("回收站为空", "Trash is empty")} text={tr("删除的章节和资料会暂存在这里。", "Deleted chapters and story-bible items will appear here temporarily.")} />
        )}
      </div>
      {purgeTarget && (
        <PromptDialog
          title={tr("永久删除", "Delete permanently")}
          label={tr(
            `永久删除「${purgeTarget.title}」无法恢复。请输入「${purgeWord}」确认`,
            `Permanently deleting “${purgeTarget.title}” cannot be undone. Type ${purgeWord} to confirm.`,
          )}
          confirmLabel={tr("永久删除", "Delete permanently")}
          cancelLabel={tr("取消", "Cancel")}
          danger
          validate={(v) => isPurgeConfirmed(v, language)}
          validateHint={tr(
            `请输入「${purgeWord}」后才能继续`,
            `Type ${purgeWord} to continue`,
          )}
          onCancel={() => setPurgeTarget(null)}
          onConfirm={async () => {
            const target = purgeTarget;
            setPurgeTarget(null);
            const r = await api("trash:purge", {
              kind: target.kind,
              id: target.id,
              confirm: purgeWord,
            });
            if (r.ok) load();
            else notify(r.error || tr("永久删除失败", "Permanent deletion failed"));
          }}
        />
      )}
    </>
  );
}
