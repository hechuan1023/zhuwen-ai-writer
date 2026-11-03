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
    narrative_pov: novel.narrative_pov || "",
    narrative_tense: novel.narrative_tense || "",
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
        <section className="novel-narrative-profile">
          <div>
            <b>{tr("AI 叙述偏好", "AI narrative preferences")}</b>
            <p className="hint">{tr("作为本作品的默认写法进入每次 AI 请求；留空表示不额外限制。场景和本轮指令可以覆盖默认值。", "These defaults are included in each AI request for this novel. Leave blank for no extra constraint; scene context and the current request can override them.")}</p>
          </div>
          <label>
            {tr("叙述视角", "Narrative point of view")}
            <input
              maxLength={160}
              value={form.narrative_pov}
              onChange={(e) => setForm({ ...form, narrative_pov: e.target.value })}
              placeholder={tr("例如：第三人称限知，主要跟随主角", "e.g. Close third person, mainly following the protagonist")}
            />
          </label>
          <label>
            {tr("叙述时态 / 时间语气", "Narrative tense / temporal voice")}
            <input
              maxLength={160}
              value={form.narrative_tense}
              onChange={(e) => setForm({ ...form, narrative_tense: e.target.value })}
              placeholder={tr("例如：以事件发生时的现场感为主，回忆段落明确切换", "e.g. Favor immediacy; mark shifts into retrospective passages")}
            />
          </label>
        </section>
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
