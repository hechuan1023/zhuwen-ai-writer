import { useEffect, useState } from "react";
import { UiLanguage } from "./shared";
import { ConfirmDialog, PromptDialog } from "./shared";
import {
  WritingEnvironment,
  WritingPreset,
  defaultPreset,
  listPresets,
  sanitizePresetName,
  savePresets,
} from "./presets";

/**
 * 写作环境预设区块。预览/应用/取消由工作区的统一状态入口处理：
 * 本组件只发起请求并如实呈现结果，成功后才更新本地列表。
 */
export function PresetSection({
  language,
  environment,
  previewing,
  previewLabel,
  onPreview,
  onApply,
  onCancelPreview,
  notify,
}: {
  language: UiLanguage;
  /** 当前有效环境（预览中为预览值），由工作区组合 */
  environment: WritingEnvironment;
  previewing: boolean;
  previewLabel?: string | null;
  onPreview: (env: WritingEnvironment, label?: string) => void;
  onApply: (env: WritingEnvironment) => void | Promise<void> | Promise<boolean>;
  onCancelPreview: () => void;
  notify: (s: string) => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [presets, setPresets] = useState<WritingPreset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<WritingPreset | null>(null);
  const [renaming, setRenaming] = useState<WritingPreset | null>(null);

  useEffect(() => {
    let live = true;
    listPresets().then((xs) => {
      if (!live) return;
      setPresets(xs);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const themeLabel = (t: string) =>
    ({ light: tr("清透白", "Light"), warm: tr("暖纸色", "Warm paper"), dark: tr("深夜墨", "Dark ink") } as Record<string, string>)[t] || t;
  const summary = (env: WritingEnvironment) => {
    const bg = env.backgroundName || env.backgroundImage
      ? ` · ${tr("有背景", "bg")}`
      : "";
    return `${themeLabel(env.theme)} · ${env.fontSize}px · ${
      env.backgroundImage ? bg : tr("纯色纸", "plain paper")
    }`;
  };

  async function persist(next: WritingPreset[]): Promise<boolean> {
    const r = await savePresets(next);
    if (!r.ok) {
      notify(r.error || tr("预设保存失败", "Could not save presets"));
      return false;
    }
    setPresets(next); // 仅在持久化成功后提交列表状态
    return true;
  }

  async function createFromCurrent() {
    if (busy) return;
    const n = sanitizePresetName(name) || tr("自定义预设", "Custom preset");
    setBusy(true);
    try {
      const p: WritingPreset = {
        id: crypto.randomUUID(),
        name: n,
        environment,
        includeLayout: environment.leftWidth != null,
      };
      const ok = await persist([...presets.filter((x) => x.id !== p.id), p]);
      if (ok) {
        setName("");
        notify(tr("已保存当前环境为预设", "Saved current environment as preset"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function deletePreset(p: WritingPreset) {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await persist(presets.filter((x) => x.id !== p.id));
      if (ok) notify(tr("预设已删除", "Preset deleted"));
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  }

  async function renamePreset(p: WritingPreset, newName: string) {
    const n = sanitizePresetName(newName);
    if (!n) {
      notify(tr("名称不能为空", "Name cannot be empty"));
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const ok = await persist(
        presets.map((x) => (x.id === p.id ? { ...x, name: n } : x)),
      );
      if (ok) notify(tr("已重命名", "Renamed"));
    } finally {
      setBusy(false);
      setRenaming(null);
    }
  }

  async function duplicatePreset(p: WritingPreset) {
    if (busy) return;
    setBusy(true);
    try {
      const copy: WritingPreset = {
        ...p,
        id: crypto.randomUUID(),
        name: sanitizePresetName(`${p.name} ${tr("副本", "copy")}`),
      };
      const ok = await persist([...presets, copy]);
      if (ok) notify(tr("已创建副本", "Duplicated"));
    } finally {
      setBusy(false);
    }
  }

  const defaults = defaultPreset();
  return (
    <section data-fd-id="preset-section">
      <h3>{tr("写作环境预设", "Writing environment presets")}</h3>
      <p className="hint">
        {tr(
          "组合主题、排版、背景与密度。预览只影响当前显示，不写入设置；点「应用」才会保存，取消立即还原。",
          "Combines theme, typography, background, and density. Preview is display-only; apply to persist, cancel to revert instantly.",
        )}
      </p>
      <div className="preset-list">
        {presets.map((p) => (
          <div
            key={p.id}
            className={`preset-card ${previewing ? "previewing" : ""}`}
            data-fd-id="preset-card"
          >
            <div className="preset-main">
              <b title={p.name}>{p.name}</b>
              <small>{summary(p.environment)}</small>
            </div>
            <div className="preset-actions">
              {previewing ? (
                <>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => onApply(p.environment)}
                  >
                    {tr("应用", "Apply")}
                  </button>
                  <button disabled={busy} onClick={onCancelPreview}>
                    {tr("取消预览", "Cancel")}
                  </button>
                </>
              ) : (
                <button disabled={busy} onClick={() => onPreview(p.environment, p.name)}>
                  {tr("预览", "Preview")}
                </button>
              )}
              <button
                className="icon"
                disabled={busy}
                title={tr("重命名", "Rename")}
                aria-label={tr("重命名预设", "Rename preset")}
                onClick={() => setRenaming(p)}
              >
                ✎
              </button>
              <button
                className="icon"
                disabled={busy}
                title={tr("创建副本", "Duplicate")}
                aria-label={tr("创建预设副本", "Duplicate preset")}
                onClick={() => duplicatePreset(p)}
              >
                ⧉
              </button>
              <button
                className="icon danger-text"
                disabled={busy}
                title={tr("删除", "Delete")}
                aria-label={tr("删除预设", "Delete preset")}
                onClick={() => setConfirmDelete(p)}
              >
                ×
              </button>
            </div>
          </div>
        ))}
        {!presets.length && (
          <small className="hint">
            {loaded
              ? tr(
                  "暂无自定义预设。调好当前环境后，在下方命名保存。",
                  "No custom presets yet. Adjust your environment and save it below.",
                )
              : tr("正在载入预设…", "Loading presets…")}
          </small>
        )}
      </div>
      {previewing && (
        <div className="preset-preview-bar" data-fd-id="preset-preview-bar">
          <span>
            {tr("正在预览", "Previewing")}
            {previewLabel ? `：${previewLabel}` : ""}
          </span>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onApply(environment);
              } finally {
                setBusy(false);
              }
            }}
          >
            {tr("应用当前预览", "Apply preview")}
          </button>
          <button disabled={busy} onClick={onCancelPreview}>
            {tr("取消", "Cancel")}
          </button>
        </div>
      )}
      {previewing && (
        <p className="hint" style={{ color: "var(--warning, #9a753b)" }}>
          {tr(
            "正在预览环境（未保存）。可点「应用」保存，或「取消预览」还原到预览前的状态。",
            "Previewing (not saved). Apply to keep, or cancel to restore the state before preview.",
          )}
        </p>
      )}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <input
          placeholder={tr("预设名称（≤40 字）", "Preset name (≤40 chars)")}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          style={{ maxWidth: 220 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              createFromCurrent();
            }
          }}
        />
        <button className="primary" disabled={busy} onClick={createFromCurrent}>
          {tr("保存当前环境", "Save current")}
        </button>
        <button
          disabled={busy}
          title={tr("先预览默认环境，确认后点「应用」保存", "Preview the default environment first, then Apply to keep")}
          onClick={() => onPreview(defaults.environment, defaults.name)}
        >
          {tr("恢复默认环境", "Reset to default")}
        </button>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={tr("删除预设", "Delete preset")}
          message={tr(
            `将删除预设「${confirmDelete.name}」。此操作只移除预设条目，不影响当前外观设置。`,
            `Delete preset "${confirmDelete.name}"? Current appearance is not affected.`,
          )}
          confirmLabel={tr("删除", "Delete")}
          cancelLabel={tr("取消", "Cancel")}
          danger
          onConfirm={() => deletePreset(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {renaming && (
        <PromptDialog
          title={tr("重命名预设", "Rename preset")}
          label={tr("预设名称", "Preset name")}
          initial={renaming.name}
          confirmLabel={tr("保存", "Save")}
          cancelLabel={tr("取消", "Cancel")}
          validate={(v) => !!sanitizePresetName(v)}
          validateHint={tr("名称不能为空，最长 40 字", "Name is required, max 40 chars")}
          onConfirm={(v) => renamePreset(renaming, v)}
          onCancel={() => setRenaming(null)}
        />
      )}
    </section>
  );
}
