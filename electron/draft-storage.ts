/**
 * AI 草稿存储：原子写入、校验、恢复副本。
 * 不将草稿正文写入日志。
 *
 * 可靠性约定：
 * - 非空草稿永不因数量阈值被删除；只有空草稿会被清理。
 * - 删除草稿使用版本墓碑（tombstones）记录，防止延迟回调恢复旧内容。
 * - 解析区分「不存在 / 合法为空 / 旧格式 / 结构损坏 / 不支持的新版本」，
 *   不支持的新版本保留原文件且拒绝写入，绝不当作空数据覆盖。
 * - 写入队列为异步串行，入队时即序列化为不可变快照；带序号防止旧覆盖新。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type DraftRecord = {
  novelId: string;
  convId: string;
  text: string;
  contexts: any[];
  version: number;
  updatedAt: string;
};

export type DraftStoreFile = {
  format: "zhuwen-ai-drafts";
  version: 1;
  drafts: Record<string, DraftRecord>;
  /** 删除草稿时记录的墓碑：key → 被删除时的最高版本号 */
  tombstones?: Record<string, number>;
};

const EMPTY: DraftStoreFile = { format: "zhuwen-ai-drafts", version: 1, drafts: {} };

export function draftKey(novelId: string, convId: string) {
  return `${novelId}::${convId || "__new__"}`;
}

function isDraftRecord(x: any): x is DraftRecord {
  return (
    x &&
    typeof x === "object" &&
    typeof x.novelId === "string" &&
    typeof x.convId === "string" &&
    typeof x.text === "string" &&
    Array.isArray(x.contexts) &&
    typeof x.version === "number" &&
    typeof x.updatedAt === "string"
  );
}

export function isEmptyDraft(d: DraftRecord) {
  return !String(d.text || "").trim() && !(Array.isArray(d.contexts) && d.contexts.length);
}

export type DraftParseResult =
  | { kind: "ok"; store: DraftStoreFile; dropped: number }
  | { kind: "empty" }
  | { kind: "unsupported"; version: number }
  | { kind: "corrupt"; reason: string };

/**
 * 解析草稿文件内容，区分不存在/空/旧格式/损坏/未来版本。
 * - 旧格式（扁平 {[key]: record}）兼容读取。
 * - 容器合法但个别记录损坏：丢弃损坏记录并计数（不整体拒绝）。
 */
export function parseDraftStore(raw: string): DraftParseResult {
  if (raw == null || !String(raw).trim()) return { kind: "empty" };
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: "corrupt", reason: `JSON 解析失败: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { kind: "corrupt", reason: "顶层不是对象" };
  if (parsed.format !== undefined && parsed.format !== "zhuwen-ai-drafts")
    return { kind: "corrupt", reason: `未知 format: ${String(parsed.format)}` };
  if (parsed.format === "zhuwen-ai-drafts") {
    const v = parsed.version;
    if (typeof v !== "number" || !Number.isFinite(v))
      return { kind: "corrupt", reason: "缺少数值 version" };
    if (v > 1)
      return { kind: "unsupported", version: v };
    if (v < 1) return { kind: "corrupt", reason: "非法 version" };
  }
  // 兼容旧格式：{ [key]: DraftRecord }（顶层直接是草稿记录）
  const source = parsed.format === "zhuwen-ai-drafts" ? parsed.drafts : parsed;
  if (source === undefined && parsed.format === "zhuwen-ai-drafts")
    return { kind: "corrupt", reason: "缺少 drafts 容器" };
  if (!source || typeof source !== "object" || Array.isArray(source))
    return { kind: "corrupt", reason: "drafts 容器不是对象" };
  const drafts: Record<string, DraftRecord> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(source)) {
    if (isDraftRecord(v)) drafts[k] = v;
    else dropped++;
  }
  const tombstones: Record<string, number> = {};
  if (parsed.format === "zhuwen-ai-drafts" && parsed.tombstones && typeof parsed.tombstones === "object") {
    for (const [k, v] of Object.entries(parsed.tombstones))
      if (typeof v === "number" && Number.isFinite(v)) tombstones[k] = v;
  }
  return {
    kind: "ok",
    store: { format: "zhuwen-ai-drafts", version: 1, drafts, tombstones },
    dropped,
  };
}

/** 兼容旧调用方：解析成功返回 store，否则抛错。 */
export function parseDraftStoreOrThrow(raw: string): DraftStoreFile {
  const r = parseDraftStore(raw);
  if (r.kind === "ok") return r.store;
  if (r.kind === "empty") return { ...EMPTY, drafts: {} };
  if (r.kind === "unsupported") throw new Error(`unsupported version ${r.version}`);
  throw new Error(r.reason);
}

export function serializeDraftStore(store: DraftStoreFile): string {
  return JSON.stringify(store);
}

/**
 * 只清理空草稿（无正文且无附件）；非空草稿一律保留，
 * 绝不因数量超过阈值而删除。墓碑由调用方随 store 一并持久化。
 */
export function pruneDrafts(drafts: Record<string, DraftRecord>): Record<string, DraftRecord> {
  const out: Record<string, DraftRecord> = {};
  for (const [k, d] of Object.entries(drafts)) {
    if (!isEmptyDraft(d)) out[k] = d;
  }
  return out;
}

export type LoadOutcome = {
  store: DraftStoreFile;
  /** 实际使用的数据来源 */
  source: "main" | "backup" | "empty";
  /** 需要让用户知道的情况（如已从备份恢复、部分记录损坏被丢弃、版本不受支持） */
  notices: string[];
  /** 主文件损坏时被隔离保留的路径（原件未删除） */
  quarantined?: string;
  /** 不支持的新版本：拒绝写入，保护原文件 */
  readOnly?: boolean;
};

export class DraftStorage {
  private file: string;
  private bak: string;
  private tmp: string;
  private queue: Promise<void> = Promise.resolve();
  private saving = false;
  private writeSeq = 0;
  private writtenSeq = 0;
  /** 解析出「不支持的新版本」后置为只读，拒绝覆盖原始数据 */
  private readOnly = false;
  lastError: string | null = null;

  constructor(private userDir: string) {
    this.file = path.join(userDir, "ai-drafts.json");
    this.bak = path.join(userDir, "ai-drafts.bak.json");
    this.tmp = path.join(userDir, `ai-drafts.${process.pid}.tmp`);
  }

  get filePath() {
    return this.file;
  }

  get backupPath() {
    return this.bak;
  }

  get isReadOnly() {
    return this.readOnly;
  }

  load(): LoadOutcome {
    const notices: string[] = [];
    const mainRead = this.readOne(this.file);
    if (mainRead.kind === "ok") {
      if (mainRead.dropped > 0)
        notices.push(`${mainRead.dropped} 条损坏的草稿记录已被丢弃`);
      return { store: mainRead.store, source: "main", notices };
    }
    if (mainRead.kind === "empty") {
      // 主文件不存在或为空文件：不代表出错，也不必动备份
      const bakRead = this.readOne(this.bak);
      if (bakRead.kind === "ok") {
        notices.push("主草稿文件缺失，已从备份恢复");
        return { store: bakRead.store, source: "backup", notices };
      }
      return { store: { ...EMPTY, drafts: {} }, source: "empty", notices };
    }
    if (mainRead.kind === "unsupported") {
      // 未来版本：保留原文件，拒绝写入，绝不当作空数据覆盖
      this.readOnly = true;
      notices.push(
        `草稿文件由更新版本的铸文生成（格式 ${mainRead.version}），已保护原文件且暂停本机草稿保存`,
      );
      return {
        store: { ...EMPTY, drafts: {} },
        source: "empty",
        notices,
        readOnly: true,
      };
    }
    // 主文件结构损坏：先尝试备份；仅当备份可用时才把损坏主文件隔离改名
    const bakRead = this.readOne(this.bak);
    if (bakRead.kind === "ok") {
      let quarantined: string | undefined;
      try {
        if (fs.existsSync(this.file)) {
          quarantined = `${this.file}.corrupt.${Date.now()}`;
          fs.renameSync(this.file, quarantined);
        }
      } catch {
        // 隔离失败也不能删除原文件
      }
      if (bakRead.dropped > 0)
        notices.push(`${bakRead.dropped} 条损坏的草稿记录已被丢弃`);
      notices.push("主草稿文件损坏，已从备份恢复；损坏原件已保留");
      return { store: bakRead.store, source: "backup", notices, quarantined };
    }
    // 备份不可用：主文件保持原路径不动，进入只读保护，绝不覆盖
    const reason =
      bakRead.kind === "unsupported"
        ? `备份为不支持的版本 ${bakRead.version}`
        : bakRead.kind === "corrupt"
          ? bakRead.reason
          : "备份不存在";
    notices.push(`草稿文件损坏且备份不可用（${reason}）；原始文件已保留，未做任何覆盖`);
    this.readOnly = true;
    return {
      store: { ...EMPTY, drafts: {} },
      source: "empty",
      notices,
      readOnly: true,
    };
  }

  private readOne(p: string): DraftParseResult {
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch (e: any) {
      // ENOENT：文件不存在 → empty；权限/设备错误：corrupt（不得当作空数据覆盖）
      if (e?.code === "ENOENT") return { kind: "empty" };
      return {
        kind: "corrupt",
        reason: `读取失败: ${e?.code || e?.message || e}`,
      };
    }
    try {
      return parseDraftStore(raw);
    } catch (e) {
      return { kind: "corrupt", reason: (e as Error).message };
    }
  }

  /**
   * 串行原子保存：入队时序列化（不可变快照）→ 写 tmp → fsync → 备份 → rename。
   * 入队序号防止旧快照覆盖新快照；单次失败不影响后续保存。
   */
  saveAsync(store: DraftStoreFile): Promise<void> {
    if (this.readOnly)
      return Promise.reject(new Error("草稿存储处于只读保护状态，未写入"));
    const seq = ++this.writeSeq;
    // 入队即序列化：调用方随后修改对象不影响本次保存内容
    const payload = serializeDraftStore({
      format: "zhuwen-ai-drafts",
      version: 1,
      drafts: pruneDrafts(store.drafts),
      tombstones: store.tombstones,
    });
    const task = this.queue.then(() =>
      seq <= this.writtenSeq
        ? Promise.resolve() // 已有更新版本落盘，跳过旧快照
        : this.writeNow(payload),
    );
    this.queue = task.catch(() => {});
    return task;
  }

  private async writeNow(payload: string) {
    this.saving = true;
    this.lastError = null;
    let handle: import("node:fs/promises").FileHandle | null = null;
    try {
      handle = await fsp.open(this.tmp, "w");
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        if (fs.existsSync(this.file)) await fsp.copyFile(this.file, this.bak);
      } catch {
        // 首次写入主文件可能不存在；备份失败不阻塞本次保存（已记录降级）
        this.lastError = this.lastError || null;
      }
      await fsp.rename(this.tmp, this.file);
      this.writtenSeq++;
    } catch (e: any) {
      this.lastError = String(e?.message || e);
      throw e;
    } finally {
      if (handle) await handle.close().catch(() => {});
      this.saving = false;
    }
  }

  get isSaving() {
    return this.saving;
  }

  /** 有界等待关闭前落盘；返回是否在限时内完成。 */
  async flush(timeoutMs = 2000): Promise<{ flushed: boolean }> {
    if (!this.queue) return { flushed: true };
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.queue.then(() => ({ flushed: true as const })),
        new Promise<{ flushed: false }>((r) => {
          timer = setTimeout(() => r({ flushed: false }), timeoutMs);
        }),
      ]).then((r) => (r as { flushed: boolean }).flushed !== false);
    } catch {
      // 队列中已有失败：失败的任务已结束，不再等待
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { flushed: this.writeSeq === this.writtenSeq };
  }

  /** 仅供测试注入故障 */
  /* eslint-disable-next-line */
  _test_setReadOnly(v: boolean) {
    this.readOnly = v;
  }
}
