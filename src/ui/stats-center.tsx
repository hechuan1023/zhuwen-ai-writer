import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, Empty, AnyRow, UiLanguage, formatFocusDuration } from "./shared";
import { StatsPayload } from "./prefs";
import { Select } from "./select";
import { StatsMonths } from "./stats-months";
import { StatsTrend } from "./stats-trend";
import { StatsDuration } from "./stats-duration";

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(base: Date, n: number) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function startOfWeek(d: Date) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const x = new Date(d);
  x.setDate(x.getDate() + diff);
  x.setHours(12, 0, 0, 0);
  return x;
}

export function WritingStatsCenter({
  novelId,
  language = "zh-CN",
  dailyGoal,
  onDailyGoal,
  novels,
}: {
  novelId?: string | null;
  language?: UiLanguage;
  dailyGoal?: number;
  onDailyGoal?: (n: number) => void | Promise<void>;
  novels?: AnyRow[];
}) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [days, setDays] = useState(30);
  const [trend, setTrend] = useState<StatsPayload | null>(null);
  const [range, setRange] = useState<StatsPayload | null>(null);
  const [filter, setFilter] = useState<string>(novelId || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const filterInited = useRef(false);
  const overviewSeq = useRef(0);
  const trendSeq = useRef(0);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [overview, setOverview] = useState<any>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [metric, setMetric] = useState<"net" | "focus">("net");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayRows, setDayRows] = useState<any[]>([]);
  const dayDetail = useMemo(() => {
    if (!selectedDay || !overview?.cells) return null;
    return overview.cells.find((c: any) => c.date === selectedDay) || null;
  }, [selectedDay, overview]);
  useEffect(() => {
    if (!selectedDay) {
      setDayRows([]);
      return;
    }
    let live = true;
    api("writing:dayDetail", { date: selectedDay, novelId: filter || null }).then(
      (r) => {
        if (!live) return;
        if (r.ok) setDayRows(r.data?.rows || []);
        else setDayRows([]);
      },
    );
    return () => {
      live = false;
    };
  }, [selectedDay, filter]);
  const scopeLabel = filter
    ? novels?.find((n) => n.id === filter)?.title || tr("当前作品", "This novel")
    : tr("全部作品", "All novels");

  useEffect(() => {
    const seq = ++overviewSeq.current;
    let live = true;
    setOverviewLoading(true);
    setOverviewError("");
    // 切换范围时不继续展示旧数据冒充新范围
    setOverview(null);
    api("writing:overview", { novelId: filter || null, year }).then((r) => {
      if (!live || seq !== overviewSeq.current) return;
      setOverviewLoading(false);
      if (!r.ok) {
        setOverviewError(r.error || tr("概览加载失败", "Overview failed"));
        return;
      }
      setOverview(r.data);
    });
    return () => {
      live = false;
    };
  }, [filter, year, language]);

  // 仅从 novelId 初始化一次；用户选“全部作品”后不得被强制切回
  useEffect(() => {
    if (filterInited.current) return;
    filterInited.current = true;
    if (novelId) setFilter(novelId);
  }, [novelId]);

  // 范围变化时清理选中日期，避免残留旧范围
  useEffect(() => {
    setSelectedDay(null);
  }, [filter, year]);

  useEffect(() => {
    const seq = ++trendSeq.current;
    let live = true;
    setLoading(true);
    setError("");
    setTrend(null);
    setRange(null);
    Promise.all([
      api<StatsPayload>("writing:stats", { novelId: filter || null, days }),
      api<StatsPayload>("writing:stats", { novelId: filter || null, days: 120 }),
    ])
      .then(([t, r]) => {
        if (!live || seq !== trendSeq.current) return;
        setLoading(false);
        if (!t.ok || !r.ok) {
          setError(
            t.error ||
              r.error ||
              (language === "en"
                ? "Could not load statistics"
                : "统计加载失败"),
          );
          return;
        }
        setTrend(t.data);
        setRange(r.data);
      })
      .catch((e) => {
        if (!live || seq !== trendSeq.current) return;
        setLoading(false);
        setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [filter, days, language]);

  const trendRows = trend?.rows || [];
  const rangeMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of range?.rows || []) m.set(row.date, Number(row.total) || 0);
    return m;
  }, [range]);

  const kpis = useMemo(() => {
    const today = localDateKey();
    const now = new Date();
    const weekStart = startOfWeek(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const sumFrom = (from: Date) => {
      let s = 0;
      for (const [d, v] of rangeMap) {
        const t = new Date(d + "T12:00:00");
        if (t >= from && d <= today) s += v;
      }
      return s;
    };
    // 连续记录：总净增 ≠ 0 记为活跃日；净增 0 的修改日无法从 writing_activity 识别（仅有非零 delta 会写入）
    let streak = 0;
    let cursor = new Date(now);
    const todayVal = rangeMap.get(today) || 0;
    if (todayVal === 0) cursor = addDays(cursor, -1);
    for (let i = 0; i < 400; i++) {
      const key = localDateKey(cursor);
      if ((rangeMap.get(key) || 0) !== 0) {
        streak++;
        cursor = addDays(cursor, -1);
      } else break;
    }
    let active = 0;
    for (const v of rangeMap.values()) if (v !== 0) active++;
    return {
      today: todayVal,
      week: sumFrom(weekStart),
      month: sumFrom(monthStart),
      active,
      streak,
    };
  }, [rangeMap]);

  const rangeLabel =
    days === 7 ? tr("近 7 个日历日", "7 calendar days") : days === 90 ? tr("近 90 个日历日", "90 calendar days") : tr("近 30 个日历日", "30 calendar days");

  async function saveGoal(n: number) {
    const value = Math.floor(n);
    if (!Number.isFinite(value) || value < 0) return;
    // 由父组件唯一负责持久化，避免父子重复写入
    await onDailyGoal?.(value);
  }

  return (
    <div className="stats-center" data-fd-id="stats-center">
      <p className="hint" style={{ margin: 0 }}>
        {tr("统计范围", "Scope")}: <b>{scopeLabel}</b>
        {" · "}
        {tr("周起始：周一 · 按本地日历日", "Week starts Monday · local calendar days")}
      </p>
      {error && (
        <div className="backup-banner err" role="alert">
          <span>!</span>
          <span>{error}</span>
        </div>
      )}
      {overviewError && (
        <div className="backup-banner err" role="alert">
          <span>!</span>
          <span>{overviewError}</span>
        </div>
      )}
      {overviewLoading && !overview && (
        <p className="hint">{tr("正在载入概览…", "Loading overview…")}</p>
      )}
      {!overview && !overviewLoading && !overviewError && (
        <p className="hint">{tr("概览尚未加载", "Overview not loaded")}</p>
      )}
      {novels && novels.length > 0 && (
        <label className="row" style={{ gap: 8 }}>
          <span className="hint">{tr("作品", "Novel")}</span>
          <Select
            language={language}
            value={filter}
            aria-label={tr("作品范围", "Novel scope")}
            searchable={novels.length > 8}
            onValueChange={setFilter}
            options={[
              { value: "", label: tr("全部作品", "All novels") },
              ...novels.map((n) => ({
                value: n.id as string,
                label: n.title as string,
              })),
            ]}
          />
        </label>
      )}

      <div className="stats-kpis" data-fd-id="stats-overview-kpis">
        <div className="stats-kpi">
          <div className="label">{tr("当前稿件字数", "Current manuscript")}</div>
          <div className="value tabular">
            {overview ? fmt(overview.wordCount) : overviewLoading ? "…" : "—"}
            <small>{tr("字", "w")}</small>
          </div>
        </div>
        <div className="stats-kpi">
          <div className="label">{tr("累计净增", "Lifetime net")}</div>
          <div className="value tabular">
            {overview ? fmt(overview.totalNet) : overviewLoading ? "…" : "—"}
            <small>{tr("字", "w")}</small>
          </div>
        </div>
        <div className="stats-kpi">
          <div className="label">{tr("单日最高净增", "Best day")}</div>
          <div className="value tabular">
            {overview ? fmt(overview.maxDayNet) : overviewLoading ? "…" : "—"}
            <small>{tr("字", "w")}</small>
          </div>
        </div>
        <div className="stats-kpi">
          <div className="label">{tr("有效写作时长", "Focus time")}</div>
          <div className="value tabular">
            {overview
              ? <StatsDuration ms={overview.totalFocusMs || 0} language={language} />
              : overviewLoading
                ? "…"
                : "—"}
          </div>
        </div>
        <div className="stats-kpi">
          <div className="label">{tr("最长单次有效写作", "Longest session")}</div>
          <div className="value tabular">
            {overview
              ? <StatsDuration ms={overview.maxSessionMs || 0} language={language} />
              : overviewLoading
                ? "…"
                : "—"}
          </div>
        </div>
        <div className="stats-kpi">
          <div className="label">{tr("连续有效写作", "Focus streak")}</div>
          <div className="value tabular">
            {overview ? fmt(overview.currentStreak) : overviewLoading ? "…" : "—"}
            <small>
              {overview
                ? tr(`天 · 最长 ${overview.longestStreak || 0}`, `d · max ${overview.longestStreak || 0}`)
                : tr("天", "d")}
            </small>
          </div>
        </div>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {overview?.timerAvailable
          ? tr(
              "时长自本版本计时启用后累计：连续人工编辑且间隔 ≤60 秒才计入；失焦/锁屏不计。净增≠总输入量。",
              "Focus time counts only consecutive manual edits with gaps ≤60s; blur/lock excluded. Net ≠ total input.",
            )
          : tr(
              "尚无计时记录（旧数据无时长）。净增来自既有创作记录，不含导入。",
              "No focus timer records yet (legacy data has no duration). Net growth is from existing activity only.",
            )}
      </p>

      <div>
        <div className="home-section-title">
          <h3>
            {tr("年度活动图", "Yearly activity")} · {year}
          </h3>
          <div className="stats-range">
            <button
              type="button"
              onClick={() => setMetric(metric === "net" ? "focus" : "net")}
            >
              {metric === "net"
                ? tr("显示：净增字数", "Showing: net words")
                : tr("显示：有效时长", "Showing: focus time")}
            </button>
            <button
              type="button"
              onClick={() => setYear((y) => Math.max(2020, y - 1))}
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => setYear((y) => Math.min(new Date().getFullYear(), y + 1))}
            >
              →
            </button>
          </div>
        </div>
        <div className="year-grid-wrap" data-fd-id="year-grid">
          {(() => {
            const cells = overview?.cells || [];
            if (!cells.length)
              return (
                <p className="hint">{tr("该年份暂无数据", "No data for this year")}</p>
              );
            // 年初星期占位（周一为第 0 行）
            const first = new Date(cells[0].date + "T12:00:00");
            const pad = (first.getDay() + 6) % 7;
            const netMax = Math.max(1, ...cells.map((x: any) => Math.max(0, x.net)));
            const focusMax = Math.max(1, ...cells.map((x: any) => x.focusMs || 0));
            const list: any[] = [
              ...Array.from({ length: pad }, (_, i) => ({ pad: true, key: `pad-${i}` })),
              ...cells,
            ];
            return (
              <>
                <div className="year-months" aria-hidden="true">
                  {cells.filter((c: any) => c.date.endsWith("-01")).map((c: any) => {
                    const index = cells.findIndex((cell: any) => cell.date === c.date);
                    const month = Number(c.date.slice(5, 7));
                    return <span key={c.date} style={{ gridColumn: Math.floor((index + pad) / 7) + 1 }}>
                      {language === "en" ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1] : `${month}月`}
                    </span>;
                  })}
                </div>
                <div className="year-grid" role="grid" aria-label={tr("年度活动方格图", "Yearly activity grid")}>
                  {list.map((c: any, idx: number) => {
                    if (c.pad)
                      return <span key={c.key} className="year-cell future" aria-hidden="true" />;
                    const v = metric === "net" ? c.net : c.focusMs;
                    const max = metric === "net" ? netMax : focusMax;
                    let level = 0;
                    if (metric === "net" && v < 0) level = -1;
                    else if (v > 0) level = Math.min(4, Math.ceil((v / max) * 4));
                    const future = c.date > localDateKey();
                    const focused = selectedDay === c.date;
                    const cls = [
                      "year-cell",
                      level < 0 ? "neg" : `l${level}`,
                      future ? "future" : "",
                      focused ? "selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const aria = `${c.date}, ${tr("净增", "Net")} ${fmt(c.net)}, ${tr("有效写作", "Focus")} ${formatFocusDuration(c.focusMs || 0, language)}${c.hasTimer ? "" : `, ${tr("未记录时长", "no timer")}`}`;
                    return (
                      <button
                        key={c.date}
                        ref={(el) => {
                          if (focused && el) el.focus();
                        }}
                        type="button"
                        role="gridcell"
                        className={cls}
                        aria-label={aria}
                        tabIndex={focused || (!selectedDay && idx === pad) ? 0 : -1}
                        title={aria}
                        onClick={() => setSelectedDay(c.date)}
                        onKeyDown={(e) => {
                          const dataIdx = cells.findIndex((x: any) => x.date === c.date);
                          let next = dataIdx;
                          if (e.key === "ArrowRight") next = dataIdx + 7;
                          else if (e.key === "ArrowLeft") next = dataIdx - 7;
                          else if (e.key === "ArrowDown") next = dataIdx + 1;
                          else if (e.key === "ArrowUp") next = dataIdx - 1;
                          else if (e.key === "Home") next = 0;
                          else if (e.key === "End") next = cells.length - 1;
                          else return;
                          e.preventDefault();
                          const target = cells[Math.max(0, Math.min(cells.length - 1, next))];
                          if (target) {
                            setSelectedDay(target.date);
                            requestAnimationFrame(() => {
                              const btn = document.querySelector<HTMLElement>(
                                `[data-fd-id="year-grid"] button[aria-label^="${target.date}"]`,
                              );
                              btn?.scrollIntoView({ block: "nearest", inline: "nearest" });
                              btn?.focus();
                            });
                          }
                        }}
                      />
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>
        <p className="hint">
          {tr(
            "图例：颜色越深表示数值越高；红色为净删除；浅灰为未来或无数据。点击或方向键查看某天。",
            "Legend: darker = higher; red = net deletion; pale = future/empty. Click or use arrows.",
          )}
        </p>
        {selectedDay && dayDetail && (
          <div className="stats-kpi" data-fd-id="stats-day-detail">
            <div className="label">
              {tr("选中日期", "Selected")} {selectedDay}
            </div>
            <div className="value tabular">
              {fmt(dayDetail.net)} <small>{tr("字净增", "net w")}</small>
              {" · "}
              {formatFocusDuration(dayDetail.focusMs || 0, language)}
              {!dayDetail.hasTimer ? tr("（该日无计时）", " (no timer)") : ""}
            </div>
            {dayRows.length > 0 && (
              <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 12, color: "var(--muted)" }}>
                {dayRows.map((r: any) => (
                  <li key={`${r.novelId}|${r.chapterId || ""}`}>
                    {r.novelTitle}
                    {r.title ? ` / ${r.title}` : ""}
                    {r.chapterId && !r.exists
                      ? `（${tr("章节已删除", "chapter deleted")}）`
                      : ""}
                    {" · "}
                    {fmt(r.net)} {tr("字", "w")} ·{" "}
                    {formatFocusDuration(r.focusMs || 0, language)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="stats-kpis">
        <div className="stats-kpi">
          <div className="label">{tr("今日净增", "Today")}</div>
          <div className="value tabular">
            {fmt(kpis.today)}
            <small>{tr("字", "w")}</small>
          </div>
        </div>
        <div className="stats-kpi">
          <div className="label">{tr("本周（周一至今）", "This week (Mon–today)")}</div>
          <div className="value tabular">
            {fmt(kpis.week)}
            <small>{tr("字", "w")}</small>
          </div>
        </div>
        <div className="stats-kpi">
          <div className="label">{tr("本月", "This month")}</div>
          <div className="value tabular">
            {fmt(kpis.month)}
            <small>{tr("字", "w")}</small>
          </div>
        </div>
        <div className="stats-kpi">
          <div className="label">{tr("有净变化天数", "Net-change days")}</div>
          <div className="value tabular">
            {fmt(kpis.active)}
            <small>{tr("天（范围内）", "in range")}</small>
          </div>
        </div>
        <div className="stats-kpi">
          <div className="label">{tr("连续净变化", "Streak")}</div>
          <div className="value tabular">
            {fmt(kpis.streak)}
            <small>{tr("天", "days")}</small>
          </div>
        </div>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {tr(
          "口径：统计「净增字数」而非总输入量；删除会扣减；导入不计入。净增为 0 的修改日无法从现有记录识别，因此不计入天数。历史不足时按实际天数显示。",
          "Scope: net word growth (not total input); deletions subtract; imports excluded. Zero-net edit days cannot be detected from current records and are not counted.",
        )}
      </p>

      {onDailyGoal && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="hint">
            {tr("每日目标（全局，对全部作品）", "Daily goal (global, all novels)")}
          </span>
          <input
            type="number"
            min={0}
            max={1000000}
            step={100}
            value={dailyGoal ?? 0}
            onChange={(e) => saveGoal(Number(e.target.value) || 0)}
            style={{ width: 120 }}
          />
        </div>
      )}

      <div>
        <div className="home-section-title stats-trend-heading">
          <div>
            <h3>{tr("写作趋势", "Writing trend")}</h3>
            <p className="stats-trend-subtitle">{rangeLabel}{trend ? ` · ${trend.start} — ${trend.end}` : ""}</p>
          </div>
          <div className="stats-range stats-trend-range" role="group" aria-label={tr("趋势时间范围", "Trend period")}>
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                className={days === d ? "active" : ""}
                aria-pressed={days === d}
                onClick={() => setDays(d)}
              >
                {tr(`近${d}天`, `${d} days`)}
              </button>
            ))}
          </div>
        </div>
        {loading && !trendRows.length ? (
          <Empty title={tr("正在载入…", "Loading…")} text="" />
        ) : trendRows.length ? (
          <StatsTrend rows={trendRows} language={language} />
        ) : (
          <Empty
            title={tr("暂无写作记录", "No writing activity")}
            text={tr("开始写作后，这里会显示每日净增字数。", "Daily net growth will appear here.")}
          />
        )}
      </div>

      <StatsMonths totals={rangeMap} language={language} loading={loading || !range} error={error} key={filter} />
    </div>
  );
}
