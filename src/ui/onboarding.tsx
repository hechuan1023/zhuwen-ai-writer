import { useRef, useState } from "react";
import { Modal, UiLanguage } from "./shared";

export function Onboarding({
  language,
  close,
  onPickTheme,
  initialTheme = "warm",
}: {
  language: UiLanguage;
  close: () => void;
  onPickTheme: (t: "warm" | "light" | "dark") => Promise<boolean> | void;
  initialTheme?: "warm" | "light" | "dark";
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [theme, setTheme] = useState<"warm" | "light" | "dark">(initialTheme);
  const pickSeq = useRef(0);
  return (
    <Modal title={tr("欢迎使用铸文", "Welcome to Zhuwen")} close={close}>
      <div className="onboard-card">
        <h2>{tr("安静写作，安心保存", "Quiet writing, safe manuscripts")}</h2>
        <p className="hint">
          {tr(
            "作品保存在本机。发送 AI 请求时，消息和你添加的引用会发送到铸文 AI 服务；不会自动上传整本作品。",
            "Your work stays on this computer. When you send an AI request, your message and added references go to Zhuwen AI; the whole novel is never uploaded automatically.",
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
              <strong>{tr("启用铸文 AI（可选）", "Enable Zhuwen AI (optional)")}</strong>
              {tr("设置 → AI 模型，输入管理员发放的激活令牌。引用内容只会随你发送的请求提交。", "Settings → AI models, then enter an activation token from your administrator. References are sent only with a request you submit.")}
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
                  const seq = ++pickSeq.current;
                  const previous = theme;
                  setTheme(key);
                  void Promise.resolve(onPickTheme(key)).then((saved) => {
                    if (saved === false && pickSeq.current === seq) setTheme(previous);
                  });
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
