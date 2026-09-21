import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DraftStorage,
  draftKey,
  parseDraftStore,
  parseDraftStoreOrThrow,
  pruneDrafts,
} from "../electron/draft-storage";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zhuwen-draft-"));
  dirs.push(d);
  return d;
}
function record(text: string, contexts: any[] = [], i = 0) {
  return {
    novelId: "n1",
    convId: `c${i}`,
    text,
    contexts,
    version: 1,
    updatedAt: new Date(Date.now() + i).toISOString(),
  };
}
function storeWith(n: number, withText = true) {
  const drafts: any = {};
  for (let i = 0; i < n; i++) {
    drafts[draftKey("n1", `c${i}`)] = withText
      ? record(`草稿内容-${i}`, [], i)
      : record("", [{ kind: "chapter", content: "附件内容", label: "章节" }], i);
  }
  return { format: "zhuwen-ai-drafts" as const, version: 1 as const, drafts };
}

describe("pruneDrafts：数量阈值绝不删除非空草稿", () => {
  it("81 条非空草稿全部保留", () => {
    const drafts = storeWith(81).drafts as any;
    const out = pruneDrafts(drafts);
    expect(Object.keys(out).length).toBe(81);
  });

  it("100 条非空草稿保存并重载后全部保留", async () => {
    const dir = tmp();
    const s = new DraftStorage(dir);
    await s.saveAsync(storeWith(100));
    const loaded = new DraftStorage(dir).load();
    expect(Object.keys(loaded.store.drafts).length).toBe(100);
  });

  it("只有附件没有文字的草稿同样保留", () => {
    const drafts = storeWith(90, false).drafts as any;
    const out = pruneDrafts(drafts);
    expect(Object.keys(out).length).toBe(90);
  });

  it("空草稿按定义清理；混合场景只动空草稿", () => {
    const drafts: any = {
      empty: { ...record("   "), convId: "e" },
      empty2: { ...record("", []), convId: "e2" },
      keep: record("有内容", [], 1),
      keepByAttachment: record("", [{ kind: "selection", content: "x" }], 2),
    };
    const out = pruneDrafts(drafts);
    expect(out.empty).toBeUndefined();
    expect(out.empty2).toBeUndefined();
    expect(out.keep).toBeTruthy();
    expect(out.keepByAttachment).toBeTruthy();
  });

  it("墓碑记录在 prune 中始终保留", () => {
    const store = {
      ...storeWith(2),
      tombstones: { "n1::gone": 5 },
    };
    const payload = JSON.parse(
      // simulate serialize→prune path used by saveAsync
      JSON.stringify({
        format: "zhuwen-ai-drafts",
        version: 1,
        drafts: pruneDrafts(store.drafts),
        tombstones: store.tombstones,
      }),
    );
    expect(payload.tombstones["n1::gone"]).toBe(5);
  });
});

describe("DraftStorage：持久化与恢复", () => {
  it("roundtrips drafts atomically and keeps backup", async () => {
    const dir = tmp();
    const s = new DraftStorage(dir);
    const store = {
      format: "zhuwen-ai-drafts" as const,
      version: 1 as const,
      drafts: {
        [draftKey("n1", "A")]: record("草稿A"),
      },
    };
    await s.saveAsync(store);
    store.drafts[draftKey("n1", "A")].text = "草稿A改";
    store.drafts[draftKey("n1", "A")].version = 2;
    await s.saveAsync(store);
    const loaded = new DraftStorage(dir).load();
    expect(loaded.store.drafts[draftKey("n1", "A")].text).toBe("草稿A改");
    expect(fs.existsSync(path.join(dir, "ai-drafts.bak.json"))).toBe(true);
  });

  it("入队即快照：保存调用后修改对象不影响落盘内容", async () => {
    const dir = tmp();
    const s = new DraftStorage(dir);
    const store = {
      format: "zhuwen-ai-drafts" as const,
      version: 1 as const,
      drafts: { k: record("入队内容") },
    };
    const p = s.saveAsync(store);
    store.drafts.k.text = "调用后才改的内容";
    await p;
    const loaded = new DraftStorage(dir).load();
    expect(loaded.store.drafts.k.text).toBe("入队内容");
  });

  it("recovers from bak when main is corrupt; original preserved as .corrupt", async () => {
    const dir = tmp();
    const s = new DraftStorage(dir);
    await s.saveAsync({
      format: "zhuwen-ai-drafts",
      version: 1,
      drafts: { k: record("好草稿") },
    });
    await s.saveAsync({
      format: "zhuwen-ai-drafts",
      version: 1,
      drafts: { k: { ...record("好草稿2"), version: 2 } },
    });
    fs.writeFileSync(path.join(dir, "ai-drafts.json"), "{not json", "utf8");
    const loaded = new DraftStorage(dir).load();
    expect(loaded.source).toBe("backup");
    expect(loaded.store.drafts.k.text).toContain("好草稿");
    expect(loaded.notices.join()).toContain("备份");
    const quarantined = fs
      .readdirSync(dir)
      .find((f) => f.startsWith("ai-drafts.json.corrupt."));
    expect(quarantined).toBeTruthy();
    expect(fs.readFileSync(path.join(dir, quarantined!), "utf8")).toBe("{not json");
  });

  it("不支持的新版本：保留原文件、拒绝写入，不当作空数据覆盖", async () => {
    const dir = tmp();
    const future = JSON.stringify({
      format: "zhuwen-ai-drafts",
      version: 2,
      drafts: { k: record("未来版本数据") },
    });
    fs.writeFileSync(path.join(dir, "ai-drafts.json"), future, "utf8");
    const s = new DraftStorage(dir);
    const loaded = s.load();
    expect(loaded.readOnly).toBe(true);
    expect(loaded.notices.join()).toContain("保护原文件");
    await expect(
      s.saveAsync({ format: "zhuwen-ai-drafts", version: 1, drafts: {} }),
    ).rejects.toThrow(/只读/);
    // 原文件内容原封不动
    expect(fs.readFileSync(path.join(dir, "ai-drafts.json"), "utf8")).toBe(future);
  });

  it("主文件与备份均损坏：原件保留、进入只读、明确报错", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "ai-drafts.json"), "{{{", "utf8");
    fs.writeFileSync(path.join(dir, "ai-drafts.bak.json"), "not-json either", "utf8");
    const s = new DraftStorage(dir);
    const loaded = s.load();
    expect(loaded.source).toBe("empty");
    expect(loaded.readOnly).toBe(true);
    expect(loaded.notices.join()).toContain("备份不可用");
    await expect(
      s.saveAsync({ format: "zhuwen-ai-drafts", version: 1, drafts: {} }),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, "ai-drafts.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "ai-drafts.bak.json"))).toBe(true);
  });

  it("写入失败可感知、saving 复位、tmp 清理、队列继续处理后续保存", async () => {
    const dir = tmp();
    const s = new DraftStorage(dir);
    // 用同名目录占用 tmp 路径，制造写入失败
    fs.mkdirSync(path.join(dir, `ai-drafts.${process.pid}.tmp`));
    await expect(
      s.saveAsync({ format: "zhuwen-ai-drafts", version: 1, drafts: { k: record("会失败") } }),
    ).rejects.toBeTruthy();
    expect(s.isSaving).toBe(false);
    // 解除占用：下一笔保存应当成功（错误后队列仍能继续）
    fs.rmdirSync(path.join(dir, `ai-drafts.${process.pid}.tmp`));
    await s.saveAsync({
      format: "zhuwen-ai-drafts",
      version: 1,
      drafts: { k: record("恢复后成功") },
    });
    const loaded = new DraftStorage(dir).load();
    expect(loaded.store.drafts.k.text).toBe("恢复后成功");
  });

  it("墓碑随 store 持久化并在重载后保留", async () => {
    const dir = tmp();
    const s = new DraftStorage(dir);
    await s.saveAsync({
      format: "zhuwen-ai-drafts",
      version: 1,
      drafts: {},
      tombstones: { "n1::deleted-conv": 7 },
    });
    const loaded = new DraftStorage(dir).load();
    expect(loaded.store.tombstones?.["n1::deleted-conv"]).toBe(7);
  });

  it("flush：队列排空后返回 flushed=true", async () => {
    const dir = tmp();
    const s = new DraftStorage(dir);
    await s.saveAsync(storeWith(3));
    const r = await s.flush(2000);
    expect(r.flushed).toBe(true);
  });
});

describe("parseDraftStore：区分数据状态", () => {
  it("空内容 → empty", () => {
    expect(parseDraftStore("").kind).toBe("empty");
    expect(parseDraftStore("   \n").kind).toBe("empty");
  });
  it("结构损坏 → corrupt 带原因", () => {
    const r = parseDraftStore("{not json");
    expect(r.kind).toBe("corrupt");
    if (r.kind === "corrupt") expect(r.reason).toBeTruthy();
  });
  it("顶层非对象 → corrupt", () => {
    expect(parseDraftStore("[1,2]").kind).toBe("corrupt");
  });
  it("未知 format → corrupt", () => {
    const r = parseDraftStore(JSON.stringify({ format: "other", version: 1, drafts: {} }));
    expect(r.kind).toBe("corrupt");
  });
  it("未来版本 → unsupported 带版本号", () => {
    const r = parseDraftStore(JSON.stringify({ format: "zhuwen-ai-drafts", version: 9, drafts: {} }));
    expect(r.kind).toBe("unsupported");
    if (r.kind === "unsupported") expect(r.version).toBe(9);
  });
  it("合法新格式但缺 drafts 容器 → corrupt", () => {
    expect(parseDraftStore(JSON.stringify({ format: "zhuwen-ai-drafts", version: 1 })).kind).toBe(
      "corrupt",
    );
  });
  it("部分记录损坏：丢弃损坏记录并计数，不整体拒绝", () => {
    const raw = JSON.stringify({
      format: "zhuwen-ai-drafts",
      version: 1,
      drafts: {
        good: record("好草稿"),
        bad: { novelId: "n" },
      },
    });
    const r = parseDraftStore(raw);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.store.drafts.good.text).toBe("好草稿");
      expect(r.dropped).toBe(1);
    }
  });
  it("旧扁平格式兼容读取", () => {
    const raw = JSON.stringify({ "n::A": record("x") });
    const s = parseDraftStoreOrThrow(raw);
    expect(s.drafts["n::A"].text).toBe("x");
  });
});
