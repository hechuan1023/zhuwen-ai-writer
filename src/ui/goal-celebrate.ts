/** 今日目标庆祝：按「统计范围 + 本地日期 + 目标」持久化，跨组件/重启不重复 */

export function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 范围：全部作品或具体 novelId（不能只用页面名） */
export function goalScopeKey(novelId: string | null | undefined) {
  return novelId ? `novel:${novelId}` : "all";
}

export function celebrateKey(
  scope: string,
  date: string,
  goal: number,
) {
  return `${scope}|${date}|${goal}`;
}

const STORAGE_KEY = "zhuwen.goal.celebrate.v1";
const MAX_ENTRIES = 40;

type CelebrateMap = Record<string, string>; // key -> ISO date saved

/** localStorage 不可用时（如 Node 测试）的进程内回退 */
let memoryFallback: CelebrateMap | null = null;

function readMap(): CelebrateMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return memoryFallback || {};
  }
}

function writeMap(map: CelebrateMap) {
  try {
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => String(map[a]).localeCompare(String(map[b])));
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    memoryFallback = { ...map };
  }
}

/** 是否已庆祝过；不修改存储 */
export function hasCelebrated(scope: string, date: string, goal: number) {
  const key = celebrateKey(scope, date, goal);
  return Boolean(readMap()[key]);
}

/** 标记已庆祝 */
export function markCelebrated(scope: string, date: string, goal: number) {
  const map = readMap();
  map[celebrateKey(scope, date, goal)] = new Date().toISOString();
  writeMap(map);
}

export type GoalCelebrateDecision = {
  celebrate: boolean;
  reason:
    | "no-goal"
    | "below"
    | "lowered-into-goal"
    | "already-celebrated"
    | "already-this-session"
    | "crossed"
    | "initial-load";
};

/**
 * 是否应庆祝。
 * prevToday 为 null 表示「首次加载」——已达标不庆祝。
 * 降低目标导致被动达标不庆祝。
 */
export function shouldCelebrateGoal(args: {
  today: number;
  prevToday: number | null;
  goal: number;
  prevGoal: number | null;
  scope: string;
  date: string;
}): GoalCelebrateDecision {
  const { today, prevToday, goal, prevGoal, scope, date } = args;
  if (!goal || goal <= 0)
    return { celebrate: false, reason: "no-goal" };
  if (today < goal) return { celebrate: false, reason: "below" };
  if (prevToday === null)
    return { celebrate: false, reason: "initial-load" };
  // 降低目标后被动达标
  if (prevGoal != null && goal < prevGoal && prevToday < prevGoal && today >= goal)
    return { celebrate: false, reason: "lowered-into-goal" };
  if (prevToday >= goal)
    return { celebrate: false, reason: "already-this-session" };
  if (hasCelebrated(scope, date, goal))
    return { celebrate: false, reason: "already-celebrated" };
  return { celebrate: true, reason: "crossed" };
}
