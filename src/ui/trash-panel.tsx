import { useEffect, useState } from "react";
import { api, time, Empty, AnyRow, UiLanguage } from "./shared";

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
              onClick={async () => {
                if (
                  prompt(tr("永久删除无法恢复。请输入“永久删除”确认", "Permanent deletion cannot be undone. Type DELETE to confirm.")) ===
                  (language === "en" ? "DELETE" : "永久删除")
                ) {
                  const r = await api("trash:purge", {
                    kind: x.kind,
                    id: x.id,
                    confirm: language === "en" ? "DELETE" : "永久删除",
                  });
                  if (r.ok) load();
                  else notify(r.error || tr("永久删除失败", "Permanent deletion failed"));
                }
              }}
            >
              {tr("永久删除", "Delete permanently")}
            </button>
          </div>
        ))}
        {!rows.length && (
          <Empty title={tr("回收站为空", "Trash is empty")} text={tr("删除的章节和资料会暂存在这里。", "Deleted chapters and story-bible items will appear here temporarily.")} />
        )}
      </div>
    </>
  );
}
