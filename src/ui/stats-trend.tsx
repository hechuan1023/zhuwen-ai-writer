import { useEffect, useRef, useState } from "react";
import { trendTickIndexes, trendScale } from "./stats-chart-model";
import { fmt, UiLanguage } from "./shared";

export function StatsTrend({ rows, language }: {
  rows: { date: string; total: number }[];
  language: UiLanguage;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const scale = trendScale(rows.map((row) => row.total));
  const active = rows.find((row) => row.date === selected);
  const en = language === "en";
  const describe = (row: typeof rows[number]) => `${row.date} · ${en ? "Net words" : "净增字数"} ${row.total > 0 ? "+" : ""}${fmt(row.total)}`;
  return (
    <div className="stats-trend" ref={container}>
      {scale.empty ? <div className="stats-trend-empty" role="status">{en ? "No net word changes in this period" : "这段时间暂无字数变化"}<small>{en ? "Changes will appear here when you write or revise." : "写作或删改产生净字数变化后，这里会显示趋势。"}</small></div> : <>
      <div className="stats-trend-plot" role="group" aria-label={en ? "Daily net words; negative values below zero" : "每日净增字数，负值显示在零线下方"}>
        {scale.ticks.map((value, index) => <span key={index} className={`stats-trend-guide ${value === 0 ? "zero" : ""}`} style={{ top: `${8 + index * 42}%` }} aria-hidden="true"><em>{value > 0 ? "+" : ""}{Number.isInteger(value) ? fmt(value) : value.toFixed(1)}</em></span>)}
        {rows.map((row, index) => (
          <button
            type="button"
            key={row.date}
            className={`stats-trend-bar${selected === row.date ? " selected" : ""}`}
            title={describe(row)}
            aria-label={describe(row)}
            aria-pressed={selected === row.date}
            tabIndex={active ? (selected === row.date ? 0 : -1) : (index === rows.length - 1 ? 0 : -1)}
            onFocus={() => setSelected(row.date)}
            onMouseEnter={() => setSelected(row.date)}
            onClick={() => setSelected(row.date)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next++;
              else if (event.key === "ArrowLeft") next--;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = rows.length - 1;
              else return;
              event.preventDefault();
              const buttons = container.current?.querySelectorAll<HTMLButtonElement>(".stats-trend-bar");
              buttons?.[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
            }}
          >
            {row.total !== 0 && <i className={row.total < 0 ? "negative" : "positive"} style={{ height: `${Math.max(0.8, Math.abs(row.total) / scale.limit * scale.span)}%`, top: row.total < 0 ? `${scale.zero}%` : "auto", bottom: row.total > 0 ? `${100 - scale.zero}%` : "auto" }} />}
          </button>
        ))}
      </div>
      <div className="stats-trend-axis" aria-hidden="true">
        {trendTickIndexes(rows.length, Math.max(0, width - 54)).map((index, tick, ticks) => (
          <span key={rows[index].date} style={{
            left: `${(index + 0.5) / rows.length * 100}%`,
            transform: tick === 0 ? "none" : tick === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
          }}>{rows[index].date.slice(5).replace("-", "/")}</span>
        ))}
      </div>
      </>}
      {!scale.empty && <p className="stats-trend-detail" aria-live="polite">
        {active ? describe(active) : en ? "Hover, click, or use arrow keys to inspect a day" : "悬停、点击或使用方向键查看每日数据"}
        <span>{en ? "Below zero = net deletion" : "零线下方为净删除"}</span>
      </p>}
    </div>
  );
}
