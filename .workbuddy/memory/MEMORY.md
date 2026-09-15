# 铸文项目长期约定

项目：`E:\AI-Project\write-tool` — 本地优先的小说写作桌面应用「铸文」（Electron + React + TS + Vite + TipTap + node:sqlite）。
**已纳入 git**（2026-09-15 建立，分支 `main`）。此前是无版本控制状态，历史提交中最早的那个是重建的基线。

## git 使用约定

- `v0.4.7` 标签 = **优化前的基线快照**（由手工备份重建），不是原始构建提交。`git diff v0.4.7 HEAD` 查看 0.4.7 之后的全部改动。
- 仓库**统一 LF**。`.gitattributes` 用 `* text=auto eol=lf` 覆盖 Git for Windows 默认的系统级 `core.autocrlf=true`；已实测克隆不产生 CRLF。**改 `.gitattributes` 前先想清楚**，破坏它会引发全文件级伪 diff。
- `.gitignore` 排除：`node_modules/`、`dist/`、`dist-electron/`、`release*/`（约 3.4 GB）、`artifacts/`、`.frontend-design/`、`.backup/`、`*.tsbuildinfo`、`secrets.json`。
- 安装包二进制**不入库**，版本 / 大小 / SHA-256 记在 `README.md`。
- 提交信息用 `feat:` / `fix:` / `chore:` / `refactor:` / `style:` / `docs:` 开头，正文说明改了什么、为什么、如何验证。
- 尚未配置远端。推送属外部操作，未经用户明确同意不要执行。
- 手工备份仍在 `E:\AI-Project\write-tool-backup\20260915-1420-pre-optimize`（693 KB），保留作双保险。

## 硬性约定

1. **新增 IPC 必须同步登记白名单**。`electron/preload.ts` 的 `allowedChannels` 是硬编码 Set，未登记的通道会被 `zhuwen.invoke` 直接 reject，前端表现为静默失败。
2. **偏好写入一律走 merge**。前端用 `src/ui/prefs.ts` 的 `patchAppearance` / `patchWriting`（内部 `merge: true`）。主进程若整项替换会清空字体、背景、语言等未提交字段。
3. **API Key 不得入库**。`api_connections` 表结构禁止出现 key/secret 列；密钥走独立 secret 文件。`electron/smoke.ts` 有防回归断言。
4. **章节保存用乐观锁**（`revision` 比对），过期修订必须拒绝，不得改成无条件覆盖。
5. **正文格式以 ProseMirror JSON 为准**，`plain_text` 与 `word_count` 是派生字段。
6. **不接触用户真实稿件做测试**，一律使用隔离临时数据目录（`mkdtempSync`）。
7. **不加遥测、CDN、在线字体、远程素材依赖**。应用是离线优先产品。

## 验证习惯

- 交付前跑：`npm run build`（双 tsconfig 类型检查）→ `npm run test:unit`（vitest）→ `npm test`（DB 冒烟）→ 界面冒烟。
- **界面冒烟在本机自动化环境必须绕开两个坑**，否则会误判成代码回归：
  1. 运行环境注入了 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 退化成纯 Node，报
     `TypeError: Cannot read properties of undefined (reading 'setPath')`。
     必须先 `env -u ELECTRON_RUN_AS_NODE`。
  2. 无 GPU 时需 `--disable-gpu --no-sandbox --disable-gpu-compositing`，
     否则报 `GPU process isn't usable. Goodbye.`。
  完整命令：`env -u ELECTRON_RUN_AS_NODE ZHUWEN_UI_SMOKE=1 ./node_modules/electron/dist/electron.exe . --disable-gpu --no-sandbox --disable-gpu-compositing`
  （`npm run test:ui` 不含这两个开关，直接调用会失败。）
- macOS 构建与钥匙串**必须真机验证**，Windows 通过不代表 macOS 通过。
- 打包后要报告文件名、大小、SHA-256、测试日期，并区分「打包应用启动验证」与「安装器安装/升级验证」。

## 参考

- 分阶段任务书：`OPTIMIZATION-HANDOFF.md`（四阶段 + 商业化规划）
- 视觉参考：`C:\Users\hechuan\Desktop\text-gpt\index.html`
- 版本与测试数记录在 `README.md`，需与实际一致。
