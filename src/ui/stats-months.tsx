import { useState } from "react";
import { recentWritingMonths } from "./stats-chart-model";
import { fmt, UiLanguage } from "./shared";

export function StatsMonths({ totals, language, loading, error }: {
  totals: Map<string, number>; language: UiLanguage; loading: boolean; error: string;
}) {
  const [selected, setSelected] = useState("");
  const en = language === "en";
  const months = recentWritingMonths(new Date(), totals);
  const detail = months.flatMap((month) => month.days).find((day) => day.date === selected && !day.future);
  const describe = (date: string, total: number) => `${date} · ${en ? "Net words" : "净增字数"} ${total > 0 ? "+" : ""}${fmt(total)}`;
  return <section className="stats-months-section">
    <div className="home-section-title"><h3>{en ? "Writing calendar" : "写作日历"}</h3><span>{en ? "Last month + this month · green: net gain, red: net deletion" : "上个月＋本月 · 绿色净增，红色净删除"}</span></div>
    {error ? <p role="alert">{error}</p> : loading ? <p role="status">{en ? "Loading calendar…" : "正在加载日历…"}</p> : <>
      <div className="stats-months">
        {months.map((month) => <section className="stats-month" key={month.key}>
          <header><h4>{month.first.toLocaleDateString(en ? "en-US" : "zh-CN", { year: "numeric", month: "long" })}</h4><span>{en ? "Net" : "净增"} <b>{month.total > 0 ? "+" : ""}{fmt(month.total)}</b> {en ? "words" : "字"}</span></header>
          <div className="stats-calendar stats-calendar-month">
            {(en ? ["M", "T", "W", "T", "F", "S", "S"] : ["一", "二", "三", "四", "五", "六", "日"]).map((day, i) => <span className="dow" key={i}>{day}</span>)}
            {Array.from({ length: month.pad }, (_, i) => <span className="calendar-pad" key={`pad-${i}`} aria-hidden="true" />)}
            {month.days.map((day) => <button type="button" key={day.date} disabled={day.future}
              className={`day ${day.total > 0 ? "has" : day.total < 0 ? "negative" : ""} ${day.today ? "today" : ""} ${selected === day.date ? "selected" : ""}`}
              title={describe(day.date, day.total)} aria-label={describe(day.date, day.total)} aria-current={day.today ? "date" : undefined}
              aria-pressed={selected === day.date} onClick={() => setSelected(day.date)} onFocus={() => setSelected(day.date)}>
              <span>{day.day}</span>{day.total !== 0 && <small>{day.total > 0 ? "+" : ""}{new Intl.NumberFormat(en ? "en-US" : "zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(day.total)}</small>}
            </button>)}
          </div>
        </section>)}
      </div>
      <p className="stats-calendar-detail" role="status">{detail ? describe(detail.date, detail.total) : en ? "Select a day for its exact net word count. Zero values are hidden in cells." : "点击日期查看完整净增字数；无变化的日期不重复显示 0。"}</p>
    </>}
  </section>;
}
