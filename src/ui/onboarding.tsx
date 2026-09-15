import { useState } from "react";
import { Modal, UiLanguage } from "./shared";

export function Onboarding({
  language,
  close,
  onPickTheme,
}: {
  language: UiLanguage;
  close: () => void;
  onPickTheme: (t: "warm" | "light" | "dark") => void;
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [theme, setTheme] = useState<"warm" | "light" | "dark">("warm");
  return (
    <Modal title={tr("欢迎使用铸文", "Welcome to Zhuwen")} close={close}>
      <div className="onboard-card">
        <h2>{tr("安静写作，安心保存", "Quiet writing, safe manuscripts")}</h2>
        <p className="hint">
          {tr(
            "作品保存在本机。只有你主动发送时，所选内容才会发到你配置的 AI 服务。",
            "Your work stays on this computer. Only content you explicitly attach is sent to your AI provider.",
          )}
        </p>
        <div className="onboard-steps">
          <div className="onboard-step">
            <b>1</b>
            <p>
              <strong>{tr("创建小说 → 分卷写章", "Create a novel and chapters")}</strong>
              {tr("正文自动保存；关闭前会检查未保存内容。", "Manuscript autosaves; close is guarded when unsaved.")}
            </p>
          </div>
          <div className="onboard-step">
            <b>2</b>
            <p>
              <strong>{tr("设置每日目标", "Set a daily goal")}</strong>
              {tr("状态栏显示今日净增与进度；统计中心可看趋势与日历。", "Track daily net growth; open statistics for trends and calendar.")}
            </p>
          </div>
          <div className="onboard-step">
            <b>3</b>
            <p>
              <strong>{tr("接入 AI（可选）", "Connect AI (optional)")}</strong>
              {tr("设置 → AI API 连接；引用内容需你手动添加后才发送。", "Settings → AI API. References are never auto-sent.")}
            </p>
          </div>
        </div>
        <div>
          <p className="hint" style={{ marginBottom: 8 }}>
            {tr("选择主题（可随时更改）", "Pick a theme (change anytime)")}
          </p>
          <div className="row">
            {(
              [
                ["warm", tr("暖纸", "Warm")],
                ["light", tr("雾白", "Mist")],
                ["dark", tr("墨夜", "Ink")],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={theme === key ? "primary" : ""}
                onClick={() => {
                  setTheme(key);
                  onPickTheme(key);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="row end">
          <button className="primary" onClick={close}>
            {tr("开始写作", "Start writing")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
