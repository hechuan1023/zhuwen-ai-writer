import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planCleanup } from "../scripts/preview-release-cleanup.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zhuwen-clean-"));
  dirs.push(d);
  return d;
}
function writePkg(root: string, scripts: Record<string, string> = {}) {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0", scripts }),
    "utf8",
  );
}

describe("planCleanup：路径安全与计数", () => {
  it("白名单目录存在且未被引用 → candidate；预览模式不移动文件", () => {
    const root = tmp();
    writePkg(root);
    fs.mkdirSync(path.join(root, "release-build"));
    fs.writeFileSync(path.join(root, "release-build", "x.txt"), "hi", "utf8");
    const plan = planCleanup(root);
    expect(plan.counts.candidate).toBe(1);
    expect(plan.entries[0].status).toBe("candidate");
    expect(fs.existsSync(path.join(root, "release-build"))).toBe(true);
    expect(fs.existsSync(path.join(root, "release-archive"))).toBe(false);
  });

  it("package.json 引用的目录不视为废弃", () => {
    const root = tmp();
    writePkg(root, { pack: "electron-builder --dir -c.directories.output=release-build" });
    fs.mkdirSync(path.join(root, "release-build"));
    const plan = planCleanup(root);
    expect(plan.entries[0].status).toBe("skipped");
    expect(plan.entries[0].detail).toContain("package.json");
  });

  it("目录联接（junction）一律跳过，绝不跟随移动", () => {
    const root = tmp();
    writePkg(root);
    const outside = tmp();
    fs.mkdirSync(path.join(root, "release-new"));
    fs.writeFileSync(path.join(outside, "keep.txt"), " Outside", "utf8");
    fs.symlinkSync(outside, path.join(root, "release-portable"), "junction");
    const plan = planCleanup(root);
    const entry = plan.entries.find((e: any) => e.rel === "release-portable");
    expect(entry.status).toBe("skipped");
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
  });

  it("白名单目录不存在 → skipped", () => {
    const root = tmp();
    writePkg(root);
    const plan = planCleanup(root);
    expect(plan.counts.skipped).toBe(plan.entries.length);
    expect(plan.counts.candidate).toBe(0);
  });

  it("归档模式：移动到 release-archive；目标冲突时跳过且不破坏", () => {
    const root = tmp();
    writePkg(root);
    fs.mkdirSync(path.join(root, "release-new"));
    fs.writeFileSync(path.join(root, "release-new", "a.txt"), "A", "utf8");
    const plan1 = planCleanup(root, { archive: true });
    expect(plan1.counts.candidate).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(root, "release-archive", "release-new", "a.txt"))).toBe(true);
    // 再来一次：归档目标已存在 → skipped，原目录保持
    fs.mkdirSync(path.join(root, "release-new"));
    const plan2 = planCleanup(root, { archive: true });
    const e2: any = plan2.entries.find((e: any) => e.rel === "release-new");
    expect(e2.status).toBe("skipped");
  });

  it("候选目录里是普通文件（非目录）→ skipped", () => {
    const root = tmp();
    writePkg(root);
    fs.writeFileSync(path.join(root, "release-new"), "not a dir", "utf8");
    const plan = planCleanup(root);
    const e: any = plan.entries.find((x: any) => x.rel === "release-new");
    expect(e.status).toBe("skipped");
  });
});
