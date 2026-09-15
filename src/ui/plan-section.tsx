import { UiLanguage } from "./shared";

/** 版本说明：仅描述当前本地完整能力，不承诺未上线权益，不模拟支付。 */
export function PlanSection({ language }: { language: UiLanguage }) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  return (
    <section data-fd-id="plan-section">
      <h3>{tr("版本说明", "Editions")}</h3>
      <p className="hint">
        {tr(
          "当前构建为本地完整版：写作、历史、备份、统计与自备 AI API 均可离线使用（AI 请求除外）。不需要账号。",
          "This build is the local full edition: writing, history, backup, statistics, and your own AI API work without an account (AI calls need network).",
        )}
      </p>
      <div className="plan-grid" style={{ marginTop: 12 }}>
        <div className="plan-card featured">
          <h4>{tr("本地完整版", "Local full")}</h4>
          <div className="price">
            {tr("当前可用", "Available now")} <small>{tr("本机", "this device")}</small>
          </div>
          <ul>
            <li>{tr("小说 / 卷章 / 资料库", "Novels, volumes, story bible")}</li>
            <li>{tr("历史版本与备份", "History & backup")}</li>
            <li>{tr("自备 AI API", "Bring your own AI API")}</li>
            <li>{tr("写作统计与每日目标", "Stats & daily goal")}</li>
          </ul>
        </div>
      </div>
      <p className="plan-note" style={{ marginTop: 14 }}>
        {tr(
          "未接入支付、登录或云同步。后续商业授权规则需单独确定后再实现；在此之前不以任何方式限制读取、备份与导出。",
          "No payment, login, or cloud sync is built in. Future licensing rules will be decided separately; until then, read, backup, and export are not restricted.",
        )}
      </p>
    </section>
  );
}
