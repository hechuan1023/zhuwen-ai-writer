import { FocusSession, FocusSessionMode, focusElapsedMs, focusSessionProgress, focusWordsWritten } from "./focus-session";
import { fmt, Modal, UiLanguage } from "./shared";
import { useEffect, useState } from "react";

const formatClock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export function FocusSessionDialog({
  language,
  session,
  currentNovelId,
  currentWords,
  now,
  onClose,
  onStart,
  onPause,
  onResume,
  onFinish,
}: {
  language: UiLanguage;
  session: FocusSession | null;
  currentNovelId: string;
  currentWords: number;
  now: number;
  onClose: () => void;
  onStart: (mode: FocusSessionMode, targetMinutes: number, targetWords: number) => void;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
}) {
  const tr = (zh: string, en: string) => language === "en" ? en : zh;
  const [mode, setMode] = useState<FocusSessionMode>("combined");
  const [minutes, setMinutes] = useState(25);
  const [words, setWords] = useState(500);
  const activeForAnotherNovel = Boolean(session && session.novelId !== currentNovelId);
  const elapsed = session ? focusElapsedMs(session, now) : 0;
  const timeLeft = session ? Math.max(0, session.targetMinutes * 60_000 - elapsed) : 0;
  const written = session ? focusWordsWritten(session, session.novelId === currentNovelId ? currentWords : session.startWords) : 0;
  const progress = session ? focusSessionProgress(session, session.novelId === currentNovelId ? currentWords : session.startWords, now) : 0;
  const isRunning = Boolean(session?.startedAt);
  const title = tr("专注会话", "Focus session");

  useEffect(() => {
    if (session) {
      setMode(session.mode);
      setMinutes(session.targetMinutes);
      setWords(session.targetWords);
    }
  }, [session?.createdAt]);

  return (
    <Modal title={title} close={onClose}>
      {session ? (
        <section className="focus-session-live" data-fd-id="focus-session-live">
          <div className="focus-session-overview">
            <div className="focus-session-ring" style={{ ["--session-progress" as string]: `${progress * 100}%` }} aria-label={`${Math.round(progress * 100)}%`}>
              <div>
                <strong>{session.mode === "words" ? `${Math.min(session.targetWords, written)}` : formatClock(timeLeft)}</strong>
                <small>{session.mode === "words" ? tr("已写", "written") : tr("剩余", "left")}</small>
              </div>
            </div>
            <div className="focus-session-summary">
              <span className={`focus-session-state ${isRunning ? "running" : "paused"}`}>
                <i aria-hidden="true" />{isRunning ? tr("正在专注", "In focus") : tr("已暂停", "Paused")}
              </span>
              <h3>{session.mode === "time" ? tr(`${session.targetMinutes} 分钟专注`, `${session.targetMinutes}-minute focus`) : session.mode === "words" ? tr(`${fmt(session.targetWords)} 字目标`, `${fmt(session.targetWords)}-word goal`) : tr("时间 + 字数目标", "Time + word goal")}</h3>
              <p>{tr(`已专注 ${formatClock(elapsed)}${session.mode !== "time" ? ` · 本次新增 ${fmt(written)} / ${fmt(session.targetWords)} 字` : ""}`, `${formatClock(elapsed)} focused${session.mode !== "time" ? ` · ${fmt(written)} / ${fmt(session.targetWords)} words added` : ""}`)}</p>
              {activeForAnotherNovel && <small className="hint">{tr("本会话绑定在另一部作品，字数进度暂不变化；计时仍会继续。", "This session belongs to another novel. Its word progress is paused; time continues.")}</small>}
            </div>
          </div>
          {session.mode === "combined" && (
            <div className="focus-session-goals">
              <div><span>{tr("时间", "Time")}</span><b>{formatClock(Math.min(elapsed, session.targetMinutes * 60_000))} / {session.targetMinutes}:00</b><i><em style={{ width: `${Math.min(1, elapsed / (session.targetMinutes * 60_000)) * 100}%` }} /></i></div>
              <div><span>{tr("字数", "Words")}</span><b>{fmt(Math.min(written, session.targetWords))} / {fmt(session.targetWords)}</b><i><em style={{ width: `${Math.min(1, written / session.targetWords) * 100}%` }} /></i></div>
            </div>
          )}
          <p className="focus-session-note">{tr("专注模式不会锁住软件或阻止退出；你可以随时暂停、结束或关闭此窗口。", "Focus mode never locks the app or prevents leaving. Pause, finish, or close this dialog at any time.")}</p>
          <div className="row end focus-session-actions">
            {isRunning ? <button type="button" onClick={onPause}>{tr("暂停", "Pause")}</button> : <button type="button" className="primary" onClick={onResume}>{tr("继续专注", "Resume")}</button>}
            <button type="button" className="danger-text" onClick={onFinish}>{tr("结束会话", "End session")}</button>
          </div>
        </section>
      ) : (
        <section className="focus-session-setup" data-fd-id="focus-session-setup">
          <p className="hint">{tr("给这一轮写作设一个轻量目标。会话只记录时间与新增字数，不会限制你切换章节或离开软件。", "Set a lightweight goal for this writing session. It tracks time and added words without restricting navigation or leaving the app.")}</p>
          <div className="focus-session-mode" role="group" aria-label={tr("专注目标类型", "Focus goal type")}>
            {(["time", "words", "combined"] as FocusSessionMode[]).map((value) => <button type="button" key={value} className={mode === value ? "active" : ""} aria-pressed={mode === value} onClick={() => setMode(value)}>{value === "time" ? tr("时间", "Time") : value === "words" ? tr("字数", "Words") : tr("混合", "Combined")}</button>)}
          </div>
          {(mode === "time" || mode === "combined") && <fieldset className="focus-session-field"><legend>{tr("专注时长", "Focus duration")}</legend><div className="focus-session-presets">{[15, 25, 45, 60].map((value) => <button type="button" key={value} className={minutes === value ? "active" : ""} onClick={() => setMinutes(value)}>{value} {tr("分钟", "min")}</button>)}</div></fieldset>}
          {(mode === "words" || mode === "combined") && <label className="focus-session-field">{tr("新增字数目标", "Words to add")}<div className="focus-session-word-input"><input type="number" min={1} max={100000} step={100} value={words} onChange={(event) => setWords(Math.min(100000, Math.max(1, Number(event.target.value) || 1)))} /><span>{tr("字", "words")}</span></div></label>}
          <button type="button" className="primary focus-session-start" onClick={() => onStart(mode, minutes, words)}>{tr("开始专注", "Start focus")}</button>
        </section>
      )}
    </Modal>
  );
}
