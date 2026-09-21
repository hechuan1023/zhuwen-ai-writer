/**
 * 发布目录清理预览（默认不删除）。
 * 用法: node scripts/preview-release-cleanup.mjs [--archive]
 * --archive: 将确认可归档的变体目录移动到 release-archive/（同盘，不释放空间）
 *
 * 安全边界：
 * - 所有路径经过 realpath 解析，不用字符串前缀判断越界；
 * - 符号链接/目录联接一律跳过；
 * - package.json（scripts/build）引用到的目录不视为废弃；
 * - 目标冲突、文件占用、权限错误计入「失败/跳过」，绝不部分删除。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 白名单：确认可再生/废弃的变体（用途仍需运行时校验） */
const CANDIDATES = [
  { rel: "release-build", reason: "历史打包变体" },
  { rel: "release-new", reason: "历史打包变体" },
  { rel: "release-portable", reason: "历史便携版变体" },
];

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function sizeOf(dir) {
  let total = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const e of entries) walk(path.join(p, e));
    } else total += st.size;
  };
  walk(dir);
  return total;
}

/** package.json（scripts/build/dependencies 路径）是否引用了该目录名 */
function referencedByPackageJson(root, dirName) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return false;
  }
  const hay = JSON.stringify({
    scripts: pkg.scripts || {},
    build: pkg.build || {},
    main: pkg.main || "",
  });
  return hay.includes(dirName);
}

/**
 * 只做检查与规划（不移动任何文件）。dryRun=false 时执行同盘归档，
 * 但本函数的调用方（CLI 预览模式）默认不归档。
 */
export function planCleanup(rootInput, opts = {}) {
  const root = fs.realpathSync(path.resolve(rootInput));
  const archiveRoot = path.join(root, "release-archive");
  const entries = [];
  const counts = { candidate: 0, skipped: 0, failed: 0 };
  let totalMB = 0;

  // 归档根目录不能位于任何候选目录内部，也不能是候选自身的符号链接
  if (fs.existsSync(archiveRoot)) {
    const arReal = fs.realpathSync(archiveRoot);
    if (!isInside(root, arReal)) {
      entries.push({
        rel: "release-archive",
        reason: "归档目标",
        status: "failed",
        detail: `归档目录解析后越界: ${arReal}`,
      });
      counts.failed++;
      return { root, archiveRoot, entries, counts, totalMB };
    }
  }

  for (const c of CANDIDATES) {
    const abs = path.join(root, c.rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      entries.push({ rel: c.rel, reason: c.reason, status: "skipped", detail: "不存在" });
      counts.skipped++;
      continue;
    }
    if (st.isSymbolicLink()) {
      entries.push({
        rel: c.rel,
        reason: c.reason,
        status: "skipped",
        detail: "符号链接/目录联接，拒绝处理",
      });
      counts.skipped++;
      continue;
    }
    if (!st.isDirectory()) {
      entries.push({ rel: c.rel, reason: c.reason, status: "skipped", detail: "不是目录" });
      counts.skipped++;
      continue;
    }
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      entries.push({ rel: c.rel, reason: c.reason, status: "skipped", detail: "无法解析真实路径" });
      counts.skipped++;
      continue;
    }
    if (!isInside(root, real)) {
      entries.push({
        rel: c.rel,
        reason: c.reason,
        status: "skipped",
        detail: `真实路径越界: ${real}`,
      });
      counts.skipped++;
      continue;
    }
    if (referencedByPackageJson(root, c.rel)) {
      entries.push({
        rel: c.rel,
        reason: c.reason,
        status: "skipped",
        detail: "package.json 仍引用该目录，不视为废弃",
      });
      counts.skipped++;
      continue;
    }
    const mb = sizeOf(abs) / 1024 / 1024;
    if (!opts.archive) {
      entries.push({ rel: c.rel, reason: c.reason, status: "candidate", sizeMB: mb });
      counts.candidate++;
      totalMB += mb;
      continue;
    }
    // 归档执行：目标冲突 / 占用 / 权限错误都必须安全停止该条目
    try {
      fs.mkdirSync(archiveRoot, { recursive: true });
      const dest = path.join(archiveRoot, c.rel);
      if (fs.existsSync(dest)) {
        entries.push({
          rel: c.rel,
          reason: c.reason,
          status: "skipped",
          detail: `归档目标已存在: ${dest}`,
        });
        counts.skipped++;
        continue;
      }
      fs.renameSync(abs, dest);
      entries.push({
        rel: c.rel,
        reason: c.reason,
        status: "candidate",
        sizeMB: mb,
        detail: `已归档到 ${dest}`,
      });
      counts.candidate++;
      totalMB += mb;
    } catch (e) {
      entries.push({
        rel: c.rel,
        reason: c.reason,
        status: "failed",
        detail: `归档失败（文件占用或权限）：${e && e.message ? e.message : e}`,
      });
      counts.failed++;
    }
  }
  return { root, archiveRoot, entries, counts, totalMB };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const doArchive = process.argv.includes("--archive");
  const plan = planCleanup(root, { archive: doArchive });
  console.log("=== 发布目录清理预览（默认不删除）===");
  console.log("根目录:", plan.root);
  for (const e of plan.entries) {
    const size = e.sizeMB != null ? ` ${e.sizeMB.toFixed(1)} MB` : "";
    const detail = e.detail ? ` — ${e.detail}` : ` — ${e.reason}`;
    console.log(`[${e.status.toUpperCase()}] ${e.rel}${size}${detail}`);
  }
  console.log(
    `\n候选 ${plan.counts.candidate} · 跳过 ${plan.counts.skipped} · 失败 ${plan.counts.failed} · 可归档容量约 ${plan.totalMB.toFixed(1)} MB`,
  );
  if (!doArchive)
    console.log(
      "（预览模式。加 --archive 执行同盘归档：同盘移动不会释放磁盘空间，仅整理目录）",
    );
  else console.log("归档完成。release/ 中当前稳定安装包未改动。");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main();
