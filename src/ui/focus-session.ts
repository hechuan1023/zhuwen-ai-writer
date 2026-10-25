export type FocusSessionMode = "time" | "words" | "combined";

export type FocusSession = {
  version: 1;
  novelId: string;
  novelTitle?: string;
  mode: FocusSessionMode;
  targetMinutes: number;
  targetWords: number;
  startWords: number;
  elapsedMs: number;
  startedAt: number | null;
  createdAt: number;
};

export type FocusSessionRecord = {
  id: string;
  novelId: string;
  novelTitle: string;
  mode: FocusSessionMode;
  targetMinutes: number;
  targetWords: number;
  elapsedMs: number;
  wordsWritten: number;
  outcome: "completed" | "ended";
  createdAt: number;
  completedAt: number;
};

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, Math.floor(number)))
    : fallback;
};

export function normalizeFocusSession(value: unknown): FocusSession | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<FocusSession>;
  if (!["time", "words", "combined"].includes(String(candidate.mode))) return null;
  if (typeof candidate.novelId !== "string" || !candidate.novelId) return null;
  const startedAt = candidate.startedAt == null ? null : Number(candidate.startedAt);
  if (startedAt !== null && (!Number.isFinite(startedAt) || startedAt < 0)) return null;
  return {
    version: 1,
    novelId: candidate.novelId.slice(0, 128),
    novelTitle: typeof candidate.novelTitle === "string" ? candidate.novelTitle.slice(0, 300) : "",
    mode: candidate.mode as FocusSessionMode,
    targetMinutes: clampInt(candidate.targetMinutes, 1, 240, 25),
    targetWords: clampInt(candidate.targetWords, 1, 100000, 500),
    startWords: clampInt(candidate.startWords, 0, 1000000000, 0),
    elapsedMs: clampInt(candidate.elapsedMs, 0, 86400000, 0),
    startedAt,
    createdAt: clampInt(candidate.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
  };
}

export function normalizeFocusSessionHistory(value: unknown): FocusSessionRecord[] {
  if (!Array.isArray(value)) return [];
  const rows: FocusSessionRecord[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Partial<FocusSessionRecord>;
    const id = typeof row.id === "string" ? row.id.slice(0, 200) : "";
    if (!id || seen.has(id) || typeof row.novelId !== "string" || !row.novelId || !["time", "words", "combined"].includes(String(row.mode)) || !["completed", "ended"].includes(String(row.outcome))) continue;
    const createdAt = clampInt(row.createdAt, 0, Number.MAX_SAFE_INTEGER, 0);
    const completedAt = clampInt(row.completedAt, createdAt, Number.MAX_SAFE_INTEGER, createdAt);
    rows.push({
      id,
      novelId: row.novelId.slice(0, 128),
      novelTitle: typeof row.novelTitle === "string" ? row.novelTitle.slice(0, 300) : "",
      mode: row.mode as FocusSessionMode,
      targetMinutes: clampInt(row.targetMinutes, 1, 240, 25),
      targetWords: clampInt(row.targetWords, 1, 100000, 500),
      elapsedMs: clampInt(row.elapsedMs, 0, 86400000, 0),
      wordsWritten: clampInt(row.wordsWritten, 0, 1000000000, 0),
      outcome: row.outcome as FocusSessionRecord["outcome"],
      createdAt,
      completedAt,
    });
    seen.add(id);
  }
  return rows.sort((a, b) => b.completedAt - a.completedAt).slice(0, 100);
}

export function focusElapsedMs(session: FocusSession, now = Date.now()) {
  return session.elapsedMs + (session.startedAt == null ? 0 : Math.max(0, now - session.startedAt));
}

export function focusWordsWritten(session: FocusSession, currentWords: number) {
  return Math.max(0, Math.floor(currentWords) - session.startWords);
}

export function focusSessionProgress(
  session: FocusSession,
  currentWords: number,
  now = Date.now(),
) {
  const timeProgress = Math.min(1, focusElapsedMs(session, now) / (session.targetMinutes * 60_000));
  const wordsProgress = Math.min(1, focusWordsWritten(session, currentWords) / session.targetWords);
  if (session.mode === "time") return timeProgress;
  if (session.mode === "words") return wordsProgress;
  return (timeProgress + wordsProgress) / 2;
}

export function isFocusSessionComplete(session: FocusSession, currentWords: number, now = Date.now()) {
  const timeDone = focusElapsedMs(session, now) >= session.targetMinutes * 60_000;
  const wordsDone = focusWordsWritten(session, currentWords) >= session.targetWords;
  if (session.mode === "time") return timeDone;
  if (session.mode === "words") return wordsDone;
  return timeDone && wordsDone;
}
