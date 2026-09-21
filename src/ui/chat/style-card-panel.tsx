import { useState } from "react";
import { AnyRow, Modal, ConfirmDialog, api } from "../shared";
import { ChatMenu, type MenuItem } from "./menu";
import { IconChevronDown, IconCopy, IconSparkle } from "./icons";

export type StyleCard = AnyRow & { tasks: string[]; version: number };

function styleLabel(card: StyleCard, language: string) {
  if (language !== "en" || !card.builtin) return { name: card.name, description: card.description };
  const labels: Record<string, [string, string]> = {
    "style-natural-narrative": ["Natural narrative", "A general-purpose style centered on what characters are doing."],
    "style-growth-progression": ["Growth progression", "For training, resources, and clear short-term goals."],
    "style-close-survival": ["Close survival", "For travel, danger, investigation, and constrained combat."],
    "style-human-ensemble": ["Lived-in ensemble", "For towns, factions, friends, and intersecting relationships."],
  };
  const [name, description] = labels[card.id] || [card.name, card.description];
  return { name, description };
}
function taskLabel(task: string, language: string) {
  const map: Record<string, [string, string]> = { continue: ["续写", "Continuation"], polish: ["润色", "Polish"], naturalize: ["自然化润色", "Naturalize"], outline: ["构思", "Outline"], chat: ["对话", "Chat"], check: ["检查", "Check"] };
  return map[task]?.[language === "en" ? 1 : 0] || task;
}

export function StyleCardPanel({
  language,
  cards,
  selectedId,
  onSelect,
  onReload,
  compact = false,
}: {
  language: string;
  cards: StyleCard[];
  selectedId: string;
  onSelect: (id: string) => void;
  onReload: () => void;
  compact?: boolean;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const selected = cards.find((x) => x.id === selectedId);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<StyleCard | null>(null);
  const [edit, setEdit] = useState<StyleCard | null>(null);
  const [deleteCard, setDeleteCard] = useState<StyleCard | null>(null);
  const [error, setError] = useState("");
  const items: MenuItem[] = cards.map((card) => ({
    id: `style-${card.id}`,
    label: styleLabel(card, language).name,
    hint: card.builtin ? tr("内置", "Built-in") : tr("自定义", "Custom"),
    icon: <IconSparkle />,
    onSelect: () => {
      onSelect(card.id);
      setOpen(false);
    },
  }));
  return (
    <div className="zchat-style-entry" data-fd-id="ai-style-entry">
      <ChatMenu
        ariaLabel={tr("写作风格", "Writing style")}
        dataFdId="ai-style-menu"
        trigger={<><IconSparkle /><span className="zchat-ellipsis">{selected ? styleLabel(selected, language).name : tr("不使用风格", "No style")}</span><IconChevronDown size={13} /></>}
        triggerClassName="zchat-pill wide"
        items={[
          { id: "style-none", label: tr("不使用风格卡", "No style card"), onSelect: () => { onSelect(""); setOpen(false); } },
          ...items,
          { id: "style-details", label: tr("查看与管理风格卡", "View and manage style cards"), onSelect: () => setOpen(true) },
        ]}
      />
      {open && (
        <Modal title={tr("AI 写作风格", "AI writing styles")} close={() => setOpen(false)}>
          <p className="hint">{tr("帮助保持叙事与人物表达的一致性，减少重复套路。效果会随模型和上下文而变化。", "Helps keep narrative and character expression consistent and reduce repeated patterns. Results vary with the model and context.")}</p>
          <div className="zchat-style-list">
            <button type="button" className={!selectedId ? "active" : ""} onClick={() => { onSelect(""); setOpen(false); }}>
              <b>{tr("不使用风格卡", "No style card")}</b><small>{tr("恢复现有行为，不向普通聊天添加正文规则。", "Keep existing behavior; no writing rules are added to normal chat.")}</small>
            </button>
            {cards.map((card) => (
              <div className={`zchat-style-row ${card.id === selectedId ? "active" : ""}`} key={card.id}>
                <button type="button" onClick={() => { onSelect(card.id); setOpen(false); }}>
                  <b>{styleLabel(card, language).name}</b><small>{styleLabel(card, language).description}</small>
                </button>
                <div className="zchat-style-row-actions">
                  <button type="button" title={tr("查看规则", "View rules")} onClick={() => setDetail(card)}>⌄</button>
                  <button type="button" title={tr("复制为自定义", "Copy as custom")} onClick={() => setEdit({ ...card, id: "", name: `${card.name}（自定义）`, builtin: 0 })}><IconCopy /></button>
                  {!card.builtin && <button type="button" title={tr("编辑", "Edit")} onClick={() => setEdit(card)}>✎</button>}
                  {!card.builtin && <button type="button" className="danger-text" title={tr("删除", "Delete")} onClick={() => setDeleteCard(card)}>×</button>}
                </div>
              </div>
            ))}
          </div>
          {error && <p className="hint error">{error}</p>}
          <div className="row end"><button type="button" onClick={() => setEdit({ id: "", name: "", description: "", rules: "", tasks: ["continue", "polish"], builtin: 0, version: 1 })}>{tr("新建自定义卡", "New custom card")}</button></div>
        </Modal>
      )}
      {detail && <Modal title={styleLabel(detail, language).name} close={() => setDetail(null)}><p className="hint">{styleLabel(detail, language).description}</p><p className="hint">{tr("适用任务：", "Tasks: ")}{detail.tasks.map((x) => taskLabel(x, language)).join(language === "en" ? ", " : "、")}</p><pre className="zchat-style-rules">{detail.rules}</pre></Modal>}
      {edit && <StyleEditor card={edit} language={language} onCancel={() => setEdit(null)} onSaved={() => { setEdit(null); onReload(); }} onError={setError} />}
      {deleteCard && <ConfirmDialog title={tr("删除自定义风格", "Delete custom style")} message={tr(`删除「${deleteCard.name}」？正在使用的作品会自动回到不使用风格卡。`, `Delete “${deleteCard.name}”? Novels using it will fall back to no style card.`)} confirmLabel={tr("删除", "Delete")} cancelLabel={tr("取消", "Cancel")} danger onCancel={() => setDeleteCard(null)} onConfirm={async () => { const r = await api("ai:style:delete", deleteCard.id); setDeleteCard(null); if (!r.ok) setError(r.error || "Delete failed"); else { onReload(); } }} />}
    </div>
  );
}

function StyleEditor({ card, language, onCancel, onSaved, onError }: { card: StyleCard; language: string; onCancel: () => void; onSaved: () => void; onError: (s: string) => void }) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [name, setName] = useState(card.name);
  const [description, setDescription] = useState(card.description || "");
  const [rules, setRules] = useState(card.rules || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return <Modal title={tr("编辑写作风格", "Edit writing style")} close={onCancel}><div className="zchat-style-editor"><label>{tr("名称", "Name")}<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label><label>{tr("说明", "Description")}<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={240} /></label><label>{tr("规则", "Rules")}<textarea value={rules} onChange={(e) => setRules(e.target.value)} maxLength={20000} rows={12} /></label></div>{error && <p className="hint error">{error}</p>}<div className="row end"><button type="button" onClick={onCancel} disabled={saving}>{tr("取消", "Cancel")}</button><button type="button" className="primary" disabled={saving || !name.trim() || !rules.trim()} onClick={async () => { setSaving(true); setError(""); const r = await api("ai:style:save", { id: card.id || undefined, name: name.trim(), description: description.trim(), rules: rules.trim(), tasks: card.tasks }); setSaving(false); if (r.ok) onSaved(); else { const message = r.error || tr("保存失败", "Save failed"); setError(message); onError(message); } }}>{saving ? tr("保存中…", "Saving…") : tr("保存", "Save")}</button></div></Modal>;
}
