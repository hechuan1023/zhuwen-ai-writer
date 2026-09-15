# 铸文 0.4.7

> **注意**：`release/Zhuwen-Setup-0.4.7.exe` 对应下方「安装包」一节，**不包含**「未打包改动」一节的内容。该节改动仅在源码中，尚未递增版本、尚未打包。

## 本版修复

### AI 草稿防串写
- 草稿更新绑定 `novelId + conversationId + draftVersion`
- 延迟任务会话已切换则丢弃；版本回退拒绝
- 草稿持久化到本机 `ai-drafts.json`（不含 API Key）
- 新会话使用 `__new__` 草稿位，不提前建正式会话

### 历史列表
- 请求序号防过期覆盖；分页按 ID 去重
- 搜索/多页浏览时收到实时事件 → 按当前条件刷新，不覆盖成未筛选列表

### 计时
- 跨午夜按墙钟午夜边界精确拆分（如 23:59:50→00:00:10 两天各 10s）
- 时钟跳变保守丢弃
- focusPing 校验主窗口前台与作品/章节归属

### 统计
- 未加载显示「—」/「…」，不显示假零
- 切换范围清空旧概览，避免旧数据冒充新范围

## 未打包改动（源码，未递增版本）

### 每日目标统计范围可见
- 首页统计**全部作品**、工作台统计**当前作品**，两者数值本就不同
- 目标计新增范围标签（`全部作品` / `本书`），并写入 `title` 与 `data-scope`
- 首页今日卡移除重复的「（全部作品）」后缀，范围由目标计统一声明

### 减少动态效果（独立设置）
- 设置 → 外观新增「减少动态效果」开关，与「减少透明效果」**相互独立**
- 系统级 `prefers-reduced-motion` 与应用内设置任一命中即生效（`src/ui/motion.ts`）
- 应用内开关无法被 CSS 单独覆盖，故 JS 驱动的动画（目标数字补间、下拉动画）也读取同一判定
- 已知限制：仅在界面冒烟中验证开关切换与 class 生效，未逐帧验证数字补间停止

### 设计令牌合并
- 废弃旧命名 `--accent2`（24 处引用），统一到 `--accent-2`
- 三个主题均显式定义该令牌；修正此前深色主题取值仅靠 **import 顺序**生效的隐患
- 浅色主题的强调色底由偏绿 `#dfe9e3` 修正为与蓝色主强调色匹配的 `#d7e4ea`
- 深色主题取色维持原有的 `#3c5048`，外观无变化

### 清理
- 移除无引用的死样式：`.theme-swatch` 及 `.s-bg/.s-panel/.s-paper/.s-accent`（曾使用永不定义的 `--sw-*`）
- 移除旧首页残留类：`.shelf-head`、`.shelf-tools`、`.book-info`、`.panel-tabs`、`.status .goal-bar`、`.topbar-sep`、`.project-head`、`.project-mark`、`.zoom-controls`
- 界面冒烟失败文件 `artifacts/ui-smoke-error.txt` 改为开跑前先清理，不再残留陈旧错误

## 测试

- unit **54/54**
- SMOKE_OK
- UI_SMOKE_OK（30 项断言，含 `goal_scope_home`、`goal_scope_workspace`、`reduce_motion_independent`）

## 安装包

- 路径：`E:\AI-Project\write-tool\release\Zhuwen-Setup-0.4.7.exe`
- 大小：约 **96.45 MB**
- SHA-256：`64EE0C405B37E1A98EC4AD0F6414F23B980D41819965641621123CA0682A1E19`
- 已验证：未打包目录启动
- 未验证：安装器安装/升级、签名、macOS、DPI

## 版本管理

仓库建立于 2026-09-15（此前为无版本控制状态，改动只能靠手工备份兜底）。

- 分支：`main`
- **`v0.4.7` 标签指向「优化前基线」**，由手工备份重建，对应已发布安装包的构建源。
  它不是原始构建提交，而是可复现的快照，用途是做改动比对的分界点。
- 查看 0.4.7 之后的所有源码改动：`git diff v0.4.7 HEAD`
- 只看单个文件：`git diff v0.4.7 HEAD -- src/styles.css`
- 回退单个文件到 0.4.7：`git checkout v0.4.7 -- src/styles.css`

### 不入库内容（见 `.gitignore`）

`node_modules/`、`dist/`、`dist-electron/`、`release*/`（安装包合计约 1.9 GB）、
`artifacts/`、`.frontend-design/`、`.backup/`、`*.tsbuildinfo`、`secrets.json`。

安装包的版本 / 大小 / SHA-256 记录在本 README，不随二进制入库。

### 换行符

仓库统一 **LF**。`.gitattributes` 设 `* text=auto eol=lf`，用于覆盖
Git for Windows 的默认 `core.autocrlf=true`——否则克隆后工作区会被整体改写成
CRLF，产生「整个文件都变了」的伪 diff。已实测克隆验证。

### 提交信息约定

`feat:` / `fix:` / `chore:` / `refactor:` / `style:` / `docs:` 开头，
正文用中文说明**改了什么、为什么改、如何验证**；若改动不影响已打包版本需显式注明。
