/**
 * 有效写作计时。
 * - 两次人工编辑间隔 ≤ GAP_MS 才累计该间隔
 * - 首次活动不虚增；单调时钟测间隔
 * - 跨午夜：按墙上时钟午夜边界拆分间隔到两个日期桶；逻辑会话 ID 不变
 * - 系统时钟异常跳变时保守丢弃可疑间隔
 */

export const FOCUS_GAP_MS = 60_000;
const COMMIT_EVERY_MS = 15_000;
/** 墙钟与单调时钟偏差超过该比例视为时钟跳变 */
const CLOCK_SKEW_RATIO = 2.5;

export type FocusSessionRow = {
  id: string;
  novelId: string;
  chapterId: string | null;
  date: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  committedMs: number;
  logicalId: string;
};

type DayBucket = {
  rowId: string;
  date: string;
  durationMs: number;
  committedMs: number;
  lastCommitMono: number;
};

type LiveSession = {
  logicalId: string;
  novelId: string;
  chapterId: string | null;
  startedAt: string;
  lastMono: number;
  lastWall: number;
  date: string;
  buckets: DayBucket[];
};

export type FocusClock = {
  mono: () => number;
  wall: () => number;
  localDate: (ms?: number) => string;
  nowIso: () => string;
};

export function defaultFocusClock(): FocusClock {
  return {
    mono: () => performance.now(),
    wall: () => Date.now(),
    localDate: (ms?: number) => {
      const d = new Date(ms ?? Date.now());
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    },
    nowIso: () => new Date().toISOString(),
  };
}

function nextMidnight(wallMs: number) {
  const d = new Date(wallMs);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export class FocusTracker {
  private live: LiveSession | null = null;
  constructor(
    private deps: {
      newId: () => string;
      insert: (row: FocusSessionRow) => void;
      update: (id: string, committedMs: number, endedAt: string | null) => void;
      clock?: FocusClock;
    },
  ) {}

  private clock() {
    return this.deps.clock || defaultFocusClock();
  }

  ping(novelId: string, chapterId: string | null) {
    if (!novelId) return;
    const c = this.clock();
    const t = c.mono();
    const wall = c.wall();
    const today = c.localDate(wall);
    if (this.live) {
      const sameWork =
        this.live.novelId === novelId &&
        (this.live.chapterId === chapterId || this.live.chapterId === null);
      const monoGap = t - this.live.lastMono;
      const wallGap = wall - this.live.lastWall;
      // 时钟跳变：丢弃可疑间隔并结束会话
      if (
        monoGap < 0 ||
        wallGap < 0 ||
        monoGap > CLOCK_SKEW_RATIO * Math.max(wallGap, 1) ||
        wallGap > CLOCK_SKEW_RATIO * Math.max(monoGap, 1)
      ) {
        this.end();
        this.begin(novelId, chapterId, today);
        return;
      }
      if (sameWork && monoGap <= FOCUS_GAP_MS) {
        if (this.live.date !== today) {
          // 跨午夜：按墙钟把 gap 拆到两天
          const midnight = nextMidnight(this.live.lastWall);
          const beforeMid = Math.max(0, Math.min(wallGap, midnight - this.live.lastWall));
          const afterMid = Math.max(0, wallGap - beforeMid);
          if (beforeMid > 0) this.addDuration(beforeMid, t);
          this.startBucket(today, t);
          if (afterMid > 0) this.addDuration(afterMid, t);
        } else {
          this.addDuration(wallGap, t);
        }
        this.live.lastMono = t;
        this.live.lastWall = wall;
        this.live.chapterId = chapterId || this.live.chapterId;
        return;
      }
      this.end();
    }
    this.begin(novelId, chapterId, today);
  }

  private addDuration(ms: number, t: number) {
    if (!this.live || ms <= 0) return;
    const bucket = this.live.buckets[this.live.buckets.length - 1];
    if (!bucket) return;
    bucket.durationMs += ms;
    if (t - bucket.lastCommitMono >= COMMIT_EVERY_MS) {
      bucket.committedMs = bucket.durationMs;
      bucket.lastCommitMono = t;
      this.deps.update(bucket.rowId, bucket.committedMs, null);
    }
  }

  private startBucket(date: string, t: number) {
    if (!this.live) return;
    const rowId = this.deps.newId();
    this.live.date = date;
    this.live.buckets.push({
      rowId,
      date,
      durationMs: 0,
      committedMs: 0,
      lastCommitMono: t,
    });
    this.deps.insert({
      id: rowId,
      novelId: this.live.novelId,
      chapterId: this.live.chapterId,
      date,
      startedAt: this.clock().nowIso(),
      endedAt: null,
      durationMs: 0,
      committedMs: 0,
      logicalId: this.live.logicalId,
    });
  }

  private begin(novelId: string, chapterId: string | null, date: string) {
    const c = this.clock();
    const t = c.mono();
    const wall = c.wall();
    const logicalId = this.deps.newId();
    const rowId = this.deps.newId();
    this.live = {
      logicalId,
      novelId,
      chapterId,
      startedAt: c.nowIso(),
      lastMono: t,
      lastWall: wall,
      date,
      buckets: [
        {
          rowId,
          date,
          durationMs: 0,
          committedMs: 0,
          lastCommitMono: t,
        },
      ],
    };
    this.deps.insert({
      id: rowId,
      novelId,
      chapterId,
      date,
      startedAt: c.nowIso(),
      endedAt: null,
      durationMs: 0,
      committedMs: 0,
      logicalId,
    });
  }

  end() {
    if (!this.live) return;
    const s = this.live;
    this.live = null;
    const endedAt = this.clock().nowIso();
    for (const b of s.buckets) {
      this.deps.update(b.rowId, b.durationMs, endedAt);
    }
  }

  get current() {
    if (!this.live) return null;
    const total = this.live.buckets.reduce((n, b) => n + b.durationMs, 0);
    return {
      logicalId: this.live.logicalId,
      novelId: this.live.novelId,
      chapterId: this.live.chapterId,
      durationMs: total,
      date: this.live.date,
    };
  }
}
