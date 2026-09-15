import { useEffect, useState } from "react";
import { api, time, Modal, AnyRow, UiLanguage } from "./shared";
import { Select } from "./select";

export function SummaryModal({
  chapter,
  close,
  reload,
  notify,
  language = "zh-CN",
}: {
  chapter: AnyRow | null;
  close: () => void;
  reload: () => void;
  notify: (s: string) => void;
  language?: UiLanguage;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [connections, setConnections] = useState<AnyRow[]>([]);
  const [connection, setConnection] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("connections:list").then((r) => {
      if (r.ok) {
        setConnections(r.data);
        setConnection(r.data[0]?.id || "");
      }
    });
  }, []);
  if (!chapter)
    return (
      <Modal title={tr("章节摘要", "Chapter summary")} close={close}>
        <p className="hint">{tr("当前没有章节。", "No chapter is selected.")}</p>
      </Modal>
    );
  const ch = chapter;
  const stale = ch.summary && ch.summary_revision !== ch.revision;
  async function generate() {
    if (!connection) return notify(tr("请先在设置中添加 AI 连接", "Add an AI connection in Settings first"));
    setBusy(true);
    const r = await api<any>("ai:summarize", {
      connectionId: connection,
      chapterId: ch.id,
    });
    setBusy(false);
    if (r.ok) {
      notify(tr("摘要已生成", "Summary generated"));
      reload();
      close();
    } else notify(r.error || tr("生成失败", "Generation failed"));
  }
  return (
    <Modal title={tr("章节摘要", "Chapter summary")} close={close}>
      <div className="summary-modal">
        <p className="hint">
          {tr("摘要在需要时手动生成，不会自动消耗接口用量；原文修改后旧摘要会标记为可能过期。摘要可加入 AI 引用，并记录来源章节与生成时间。", "Summaries are generated only on request and never consume API quota automatically. Changes to the manuscript mark older summaries as potentially stale, and summaries can be added to AI references.")}
        </p>
        <div className="row">
          <Select
            value={connection}
            aria-label={tr("选择连接", "Select connection")}
            placeholder={tr("选择连接", "Select connection")}
            onValueChange={setConnection}
            options={[
              { value: "", label: tr("选择连接", "Select connection") },
              ...connections.map((c) => ({
                value: c.id as string,
                label: `${c.name} · ${c.model}`,
              })),
            ]}
          />
          <button
            className="primary"
            disabled={busy || !connection}
            onClick={generate}
          >
            {busy ? tr("生成中…", "Generating…") : chapter.summary ? tr("重新生成", "Regenerate") : tr("生成摘要", "Generate summary")}
          </button>
        </div>
        {chapter.summary ? (
          <>
            {stale && (
              <p className="warn">{tr("原文已修改，此摘要可能过期，建议重新生成。", "The manuscript has changed; this summary may be stale.")}</p>
            )}
            <div className="summary-text">{chapter.summary}</div>
            <small className="hint">
              {tr("生成于", "Generated")} {time(chapter.summary_updated_at, language)} · {tr("基于修订", "Revision")} {chapter.summary_revision}
            </small>
          </>
        ) : (
          <p className="hint">{tr("尚未生成摘要。", "No summary has been generated.")}</p>
        )}
      </div>
    </Modal>
  );
}
