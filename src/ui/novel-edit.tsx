import { useState } from "react";
import { api, Modal, AnyRow, UiLanguage } from "./shared";

export function NovelEdit({
  novel,
  close,
  notify,
  onSaved,
  language = "zh-CN",
}: {
  novel: AnyRow;
  close: () => void;
  notify: (s: string) => void;
  onSaved: () => void;
  language?: UiLanguage;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [form, setForm] = useState({
    title: novel.title || "",
    author: novel.author || "",
    genre: novel.genre || "",
    synopsis: novel.synopsis || "",
    cover_path: novel.cover_path || "",
  });
  async function save() {
    if (!form.title.trim()) return notify(tr("书名不能为空", "Title is required"));
    const r = await api("novels:update", { id: novel.id, ...form });
    if (r.ok) {
      notify(tr("已保存作品信息", "Novel information saved"));
      onSaved();
      close();
    } else notify(r.error || tr("保存失败", "Save failed"));
  }
  return (
    <Modal title={tr("作品信息", "Novel information")} close={close}>
      <div className="settings">
        <div className="cover-edit">
          {form.cover_path ? (
            <img src={form.cover_path} alt={tr("封面预览", "Cover preview")} />
          ) : (
            <div className="cover-placeholder">{tr("无封面", "No cover")}</div>
          )}
          <div className="cover-actions">
            <button
              onClick={async () => {
                const r = await api<any>("novels:chooseCover");
                if (r.ok && r.data)
                  setForm({ ...form, cover_path: r.data.dataUrl });
                else if (!r.ok) notify(r.error || tr("选择封面失败", "Could not choose cover"));
              }}
            >
              {tr("选择封面", "Choose cover")}
            </button>
            {form.cover_path && (
              <button
                className="danger-text"
                onClick={() => setForm({ ...form, cover_path: "" })}
              >
                {tr("移除封面", "Remove cover")}
              </button>
            )}
            <small className="hint">{tr("支持 PNG/JPG 等，3MB 以内", "PNG/JPG and similar formats, up to 3 MB")}</small>
          </div>
        </div>
        <label>
          {tr("书名", "Title")}
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </label>
        <label>
          {tr("作者", "Author")}
          <input
            value={form.author}
            onChange={(e) => setForm({ ...form, author: e.target.value })}
          />
        </label>
        <label>
          {tr("题材", "Genre")}
          <input
            value={form.genre}
            onChange={(e) => setForm({ ...form, genre: e.target.value })}
          />
        </label>
        <label>
          {tr("简介", "Synopsis")}
          <textarea
            value={form.synopsis}
            onChange={(e) => setForm({ ...form, synopsis: e.target.value })}
          />
        </label>
        <div className="row end">
          <button onClick={close}>{tr("取消", "Cancel")}</button>
          <button className="primary" onClick={save}>
            {tr("保存", "Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
