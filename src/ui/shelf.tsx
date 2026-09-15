import { useEffect, useState } from "react";
import { api, time, Empty, Modal, PromptDialog, AnyRow, UiLanguage } from "./shared";
import { isPurgeConfirmed, purgeConfirmWord } from "./trash-confirm";

export function CreateNovel({
  close,
  notify,
  onCreated,
  language,
}: {
  close: () => void;
  notify: (s: string) => void;
  onCreated: (id: string) => void;
  language: UiLanguage;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [form, setForm] = useState({
    title: "",
    author: "",
    genre: "",
    synopsis: "",
  });
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (!form.title.trim()) return notify(tr("请输入小说名称", "Enter a novel title"));
    setSubmitting(true);
    const r = await api("novels:create", form);
    setSubmitting(false);
    if (r.ok) onCreated(r.data.id);
    else notify(r.error || tr("创建小说失败，请重试", "Could not create the novel. Please try again."));
  }
  return (
    <Modal title={tr("创建小说", "Create novel")} close={close}>
      <div className="create-novel-form settings">
        <p className="hint">{tr("作品默认保存在本机，创建后可随时补充封面和设定。", "Your novel is stored locally. You can add a cover and details later.")}</p>
        <label>
          {tr("小说名称", "Novel title")}
          <input
            autoFocus
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
            }}
            placeholder={tr("例如：雾港来信", "For example: Letters from Mist Harbor")}
          />
        </label>
        <div className="grid2">
          <label>
            {tr("作者", "Author")}
            <input
              value={form.author}
              onChange={(e) => setForm({ ...form, author: e.target.value })}
              placeholder={tr("可留空", "Optional")}
            />
          </label>
          <label>
            {tr("题材", "Genre")}
            <input
              value={form.genre}
              onChange={(e) => setForm({ ...form, genre: e.target.value })}
              placeholder={tr("例如：悬疑、科幻", "For example: mystery, science fiction")}
            />
          </label>
        </div>
        <label>
          {tr("一句话简介", "One-line synopsis")}
          <textarea
            value={form.synopsis}
            onChange={(e) => setForm({ ...form, synopsis: e.target.value })}
            placeholder={tr("可稍后填写", "You can add this later")}
          />
        </label>
        <div className="row end">
          <button onClick={close}>{tr("取消", "Cancel")}</button>
          <button className="primary" disabled={submitting} onClick={submit}>
            {submitting ? tr("正在创建…", "Creating…") : tr("创建并开始写作", "Create and start writing")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function NovelTrash({
  close,
  notify,
  reload,
  language,
}: {
  close: () => void;
  notify: (s: string) => void;
  reload: () => void;
  language: UiLanguage;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [rows, setRows] = useState<AnyRow[]>([]);
  // 永久删除的强确认词；见 trash-confirm.ts，须与服务端校验一致
  const purgeWord = purgeConfirmWord(language);
  const [purgeTarget, setPurgeTarget] = useState<AnyRow | null>(null);
  const load = () =>
    api("novels:trashList").then((r) => r.ok && setRows(r.data));
  useEffect(() => {
    load();
  }, []);
  return (
    <Modal title={tr("小说回收站", "Novel Trash")} close={close}>
      <div className="trash-list">
        {rows.map((n) => (
          <div key={n.id}>
            <span>
              <b>{n.title}</b>
              <small>
                {n.author || tr("未署名", "Unnamed")} · {tr("删除于", "Deleted")} {time(n.deleted_at, language)}
              </small>
            </span>
            <button
              onClick={async () => {
                const r = await api("novels:restore", n.id);
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
              onClick={() => setPurgeTarget(n)}
            >
              {tr("永久删除", "Delete permanently")}
            </button>
          </div>
        ))}
        {!rows.length && (
          <Empty title={tr("回收站为空", "Trash is empty")} text={tr("删除的小说会暂存在这里。", "Deleted novels will appear here temporarily.")} />
        )}
      </div>
      {purgeTarget && (
        <PromptDialog
          title={tr("永久删除小说", "Delete novel permanently")}
          label={tr(
            `永久删除《${purgeTarget.title}》及其全部章节、资料和会话，无法恢复。请输入「${purgeWord}」确认`,
            `Permanently delete “${purgeTarget.title}” and all chapters, references, and conversations? This cannot be undone. Type ${purgeWord} to confirm.`,
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
              kind: "novel",
              id: target.id,
              confirm: purgeWord,
            });
            if (r.ok) load();
            else notify(r.error || tr("永久删除失败", "Permanent deletion failed"));
          }}
        />
      )}
    </Modal>
  );
}
