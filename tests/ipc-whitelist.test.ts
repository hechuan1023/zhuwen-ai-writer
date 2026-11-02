import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeTokenStatus, normalizeServerToken } from "../electron/ai-token";

/**
 * 项目硬性约定：`electron/main.ts` 注册的每个 IPC 通道都必须出现在
 * `electron/preload.ts` 的 `allowedChannels` 白名单里，反之亦然。
 * 漏登记会让 `zhuwen.invoke` 直接 reject，前端表现为静默失败，
 * 因此这里用源码级校验兜住，避免只靠人工核对。
 */
const root = path.resolve(__dirname, "..");

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function registeredChannels() {
  const src = read("electron/main.ts");
  const out = new Set<string>();
  const re = /ipcMain\.handle\(\s*["'`]([^"'`]+)["'`]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.add(m[1]);
  return out;
}

function whitelistedChannels() {
  const src = read("electron/preload.ts");
  const block = src.slice(src.indexOf("allowedChannels"));
  const out = new Set<string>();
  const re = /^\s*["'`]([a-zA-Z0-9:_-]+)["'`],?\s*$/gm;
  for (let m = re.exec(block); m; m = re.exec(block)) out.add(m[1]);
  return out;
}

describe("IPC 白名单", () => {
  it("注册通道与 preload 白名单完全一致", () => {
    const registered = registeredChannels();
    const allowed = whitelistedChannels();
    expect(registered.size).toBeGreaterThan(50);
    expect([...registered].filter((c) => !allowed.has(c))).toEqual([]);
    expect([...allowed].filter((c) => !registered.has(c))).toEqual([]);
    expect(allowed.size).toBe(registered.size);
  });
});

describe("AI 激活令牌", () => {
  it("校验长度、空白与空值", () => {
    expect(normalizeServerToken("  abcdefgh  ")).toBe("abcdefgh");
    expect(() => normalizeServerToken("")).toThrow();
    expect(() => normalizeServerToken("   ")).toThrow();
    expect(() => normalizeServerToken("short")).toThrow();
    expect(() => normalizeServerToken("abcd efgh")).toThrow();
    expect(() => normalizeServerToken("abc\ndefgh")).toThrow();
    expect(() => normalizeServerToken("a".repeat(513))).toThrow();
  });

  it("环境变量优先于本地存储，本地存储可改写", () => {
    expect(describeTokenStatus("env-token", "local-token")).toEqual({
      configured: true,
      source: "env",
      manageable: false,
    });
    expect(describeTokenStatus("", "local-token")).toEqual({
      configured: true,
      source: "local",
      manageable: true,
    });
    expect(describeTokenStatus("  ", "")).toEqual({
      configured: false,
      source: "none",
      manageable: true,
    });
  });
});
