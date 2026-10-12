import { useEffect, useRef, useState } from "react";
import { fmt, UiLanguage } from "./shared";
import {
  goalScopeKey,
  goalScopeLabel,
  localDateKey,
  markCelebrated,
  shouldCelebrateGoal,
} from "./goal-celebrate";
import { prefersReducedMotion } from "./motion";

export type GoalMeterProps = {
  today: number;
  dailyGoal: number;
  language?: UiLanguage;
  onOpenStats?: () => void;
  compact?: boolean;
  /** 统计范围：全部作品或 novelId；勿只用页面名 */
  scope?: string | null;
};

export function DailyGoalMeter({
  today,
  dailyGoal,
  language = "zh-CN",
  onOpenStats,
  compact,
  scope = null,
}: GoalMeterProps) {
  const tr = (zh: string, en: string) => (language === "en" ? en : zh);
  const [display, setDisplay] = useState(() => Math.round(today));
  const displayRef = useRef(Math.round(today));
  const rafRef = useRef(0);
  const prevTodayRef = useRef<number | null>(null);
  const prevGoalRef = useRef<number | null>(null);
  const [flash, setFlash] = useState(false);
  const dateKey = localDateKey();
  const scopeKey = goalScopeKey(scope);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    const target = Math.round(today);
    if (prefersReducedMotion() || Math.abs(displayRef.current - target) < 1) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    const start = displayRef.current;
    const delta = target - start;
    const t0 = performance.now();
    const duration = 280;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(start + delta * eased);
      displayRef.current = value;
      setDisplay(value);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else {
        displayRef.current = target;
        setDisplay(target);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [today]);

  useEffect(() => {
    const decision = shouldCelebrateGoal({
      today,
      prevToday: prevTodayRef.current,
      goal: dailyGoal,
      prevGoal: prevGoalRef.current,
      scope: scopeKey,
      date: dateKey,
    });
    prevTodayRef.current = today;
    prevGoalRef.current = dailyGoal;
    if (!decision.celebrate) return;
    markCelebrated(scopeKey, dateKey, dailyGoal);
    if (prefersReducedMotion()) return;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 800);
    return () => window.clearTimeout(timer);
  }, [today, dailyGoal, dateKey, scopeKey]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const hasGoal = dailyGoal > 0;
  const ratio = hasGoal ? Math.max(0, Math.min(1, today / dailyGoal)) : 0;
  const percent = Math.round(ratio * 100);
  const remaining = Math.max(0, dailyGoal - today);
  const done = hasGoal && today >= dailyGoal;
  const negative = today < 0;
  // 统计范围必须可见：首页与工作台分别统计全部作品与单本作品，
  // 若界面不标注，同一个「今日」会看起来互相矛盾。
  const resolvedScopeLabel = goalScopeLabel(scope, language);

  return (
    <button
      type="button"
      className={`goal-meter tabular ${done ? "is-done" : ""} ${flash ? "goal-meter__pulse" : ""}`}
      data-fd-id="daily-goal-meter"
      data-scope={scopeKey}
      title={`${resolvedScopeLabel} · ${
        hasGoal
          ? done
            ? tr("今日目标已达成", "Daily goal reached")
            : tr(`还差 ${fmt(remaining)} 字`, `${fmt(remaining)} words to go`)
          : tr("点击设置每日目标", "Click to set a daily goal")
      }`}
      onClick={onOpenStats}
    >
      {!compact && (
        <span className="goal-meter__track" aria-hidden="true">
          <i
            className={`goal-meter__fill ${done ? "is-done" : ""}`}
            style={{ ["--progress" as string]: `${ratio * 100}%` }}
          />
        </span>
      )}
      <span className="goal-meter__label">
        <span className="goal-meter__scope">{resolvedScopeLabel}</span>
        <span className="goal-meter__sep" aria-hidden="true">
          ·
        </span>
        {hasGoal ? (
          <>
            {tr("今日", "Today")} <strong>{fmt(display)}</strong>
            {" / "}
            <strong>{fmt(dailyGoal)}</strong> {tr("字", "w")}
            {" · "}
            <strong>{percent}%</strong>
            {done
              ? ` · ${tr("已达标", "Done")}`
              : negative
                ? ""
                : ` · ${tr("还差", "left")} ${fmt(remaining)}`}
          </>
        ) : (
          <>
            {tr("今日", "Today")} <strong>{fmt(display)}</strong>{" "}
            {tr("字", "w")}
            {" · "}
            <span style={{ color: "var(--accent)" }}>
              {tr("设置目标", "Set goal")}
            </span>
          </>
        )}
      </span>
    </button>
  );
}
