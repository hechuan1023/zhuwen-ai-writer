# 铸文

本地优先小说写作桌面应用。Electron + React + TipTap + SQLite。

- 源码版本：**0.4.8**（工作区已全部提交；现有 0.4.8 安装包为更早构建，**不含**后续清理改动）
- 最新安装包：`release/Zhuwen-Setup-0.4.8.exe`（历史构建，**未包含**本轮改动）
- 历史交接文档见 `docs/`（`docs/OPTIMIZATION-HANDOFF.md` 已归档，请以本文与源码为准）

## 开发

```bash
npm install
npm run dev
npm run build && npm run test:unit && npm run test && npm run test:ui
```

## 0.4.8 稳定性修复

| 项 | 状态 |
|---|---|
| 非空草稿不因数量淘汰 | 已实现（100 条边界测试） |
| 草稿原子写 / 备份 / 只读保护 | 已实现 |
| 主+备份均损坏时保留原路径 | 已修复（原先会改名隔离） |
| 权限读取错误不当作空数据 | 已修复 |
| 预设 envEffective 只依赖 preview 导致过期 | 已修复 |
| 预设布局字段往返 | 已修复（validate 保留 left/rightWidth） |
| 预设预览操作栏 + 标签 | 已补充 |
| onApply 类型契约 | 已修复 |
| 清理脚本 .mjs 混入 TS 导致语法错误 | 已修复 |

## 0.4.8 收尾清理（本轮）

| 项 | 结果 |
|---|---|
| 设定库删除入口 | **新增**：`library:trash` 已接线，条目软删除进回收站，可在回收站恢复或永久删除 |
| AI 连接删除 | **未接线**：商用版仅有一个被锁定的服务器连接，`connections:delete` 设计上不可达，已作为死通道移除 |
| 孤儿 IPC 通道 | **清理**：85 → 81；注册数与白名单仍严格一致，无未登记、无未使用通道 |
| 死 CSS | **清理**：21 个类 / 53 个规则块（`align-start` / `align-end` 为动态拼接，经核查保留） |
| 一次性遗留代码 | `saveSecret` / `deleteSecret` 保留 —— 属密钥文件生命周期的一部分，商用版未走写入路径；确认不再需要可另行删除 |
| 数据库迁移文档 | **修正**：README 由「版本 9」更正为版本 10 |
| 交接文档 | **整理**：`OPTIMIZATION-HANDOFF.md`、`CHAT-PANEL-HANDOFF.md` 归入 `docs/` |

## 发布产物清理

`release/` 只保留最近两个安装包与构建元数据，其余历史产物已删除，合计回收约 3.8 GB。

| 已删除 | 约 |
|---|---|
| `release/Zhuwen-Setup-0.1.0 ~ 0.4.6`（12 个 exe + 11 个 blockmap） | 1.2 GB |
| `release/win-unpacked`、`release/win-unpacked.tmp` | 356 MB |
| `anzhuangbao/zhuwen` | 356 MB |
| `release-archive/`（`release-build` / `release-new` / `release-portable`） | 1.6 GB |

安装包二进制未入 git，删除后不可恢复（`git diff v0.4.7 HEAD` 只覆盖源码）。

| 保留 | 说明 |
|---|---|
| `release/Zhuwen-Setup-0.4.7.exe`、`Zhuwen-Setup-0.4.8.exe`（含 blockmap） | 现役安装包 |
| `release/builder-debug.yml` | 构建元数据 |

**遗留**：9 个 `resources/*.asar`（合计 94.4 MB）无法删除 —— 运行中的宿主进程持有其文件句柄，
原生 `rename` 返回 `WinError 32（另一个程序正在使用此文件）`。关闭 WorkBuddy 或重启系统后即可清空。
目录结构已收至最小（仅剩 `resources/` 一层）。

## 测试（本次执行）

| 命令 | 结果 |
|---|---|
| build | 通过 |
| test:unit | **131/131** |
| test | SMOKE_OK（含新增 `library_trash`） |
| test:ui | UI_SMOKE_OK（28 项，含新增 `library_trash`） |

数据库迁移当前为**版本 10**（v9 为 `ai_messages` 增加 `task_kind`；v10 增加 `selection_from` / `selection_to`，用于记录采纳来源选区）。本轮风格卡缺口修复：自然化任务规则独立注入；三张附加风格卡实际包含完整自然叙事基础规则；自然化回复采用前强制差异比较；自定义卡可编辑；内置卡按版本升级且不覆盖自定义副本；消息保存任务类型与风格快照。

## AI 聊天面板（本轮重构）

- 结构：顶部会话栏（标题 / 新建 / 历史 / 展开 / 更多）+ 消息阅读区 + 统一输入组件；原重复的 conversation-bar 与独立「对话/续写」横栏已移除。
- 输入组件：顶部引用标签（类型图标、单独移除、点击预览、失效提示、超过 4 项折叠）、多行自增高输入、底部「＋ / 任务 / 模型 / 上下文 / 发送」。
- 回复操作：默认只显示「复制 · 采纳▾ · 更多」；采纳展开为插入光标 / 替换选区 / 追加到章末 / 逐句采纳 / 对比修改（按上下文启用并说明原因）。
- 上下文：常驻长说明改为「上下文约 N」入口，弹窗展示引用/历史/输入占用拆分与实际发送内容。
- 滚动：采用 use-stick-to-bottom（MIT，devDependencies），底部自动跟随、上翻暂停、显示回到底部。
- 详细改动、选型依据（为何未采用 assistant-ui）与未验证项见 `docs/CHAT-PANEL-HANDOFF.md`。

## 使用

- **写作环境预设**：设置 → 外观 → 预览 / 应用当前预览 / 取消
- **AI 聊天面板**：对话优先的消息区；模型连接、历史、新建对话和浮窗收纳在顶部工具栏
- **AI 草稿**：输入框下方显示保存中/已保存/失败，侧栏与浮窗共享同一会话
- **AI 引用**：点击引用资料展开选择；默认不发送正文，引用、发送预览和小说工具按需展开
- **AI 写作风格**：AI 面板中的「写作风格」入口可选择四张内置卡、不使用风格卡或复制自定义卡；规则会显示在发送预览中，并随请求保存快照
- **自然化润色**：先在正文选择文字，在 AI 输入区任务菜单选择「自然化润色」，结果必须经过差异预览和人工采纳才会写回正文
- **AI 历史**：AI 面板 → 历史
- **统计**：更多 → 写作统计
## 开发脚本

| 脚本 | 用途 |
|---|---|
| `npm run icons`（`scripts/make-icon.js`） | 由 `build/icon.svg` 渲染出 `build/icon.png` 与 `build/icon.ico` |
| `python scripts/make-installer-art.py` | 生成 NSIS 安装器插图 `build/installer-header.bmp` / `installer-sidebar.bmp`（需本机安装 Pillow） |
| `node scripts/preview-release-cleanup.mjs` | 发布目录清理预览，**默认不删**；`--archive` 把可归档的变体目录移入 `release-archive/`（同盘移动，不释放空间） |

以上脚本的产物均已入库，脚本保留用于重新生成或调整样式，不属于构建链的一环（`npm run build` 不调用它们）。

## 最近 AI 面板重构

右侧 AI 面板已重排为类似现代聊天应用的结构：顶部轻工具栏、以消息为主的阅读区、底部多行输入框。空会话提供讨论剧情、润色选段、检查设定和检查对白等草稿建议，点击建议只填入输入框，不会自动调用 API。

本轮沿用现有 Electron IPC、SQLite 会话/消息/引用快照、草稿保存、流式响应、取消请求、正文差异预览和人工确认机制；未新增聊天服务、登录、遥测或云端存储，也未引入 assistant-ui。由于现有后台已有稳定的本地会话状态和安全请求边界，采用轻量 UI 适配避免维护第二套运行时和消息存储。

## 最近 AI 写作风格接入

新增独立的作品级 AI 风格卡数据，不与外观预设或普通提示词模板混用。内置卡包括「自然叙事」「成长推进」「贴身求生」「群像烟火」；选择会随作品保存，删除正在使用的自定义卡会安全回退到不使用风格卡。普通聊天和逻辑检查不会自动注入正文写作规则，续写、润色和自然化润色才会按任务使用风格偏好。

实现参考了 [assistant-ui 的可组合聊天结构](https://github.com/assistant-ui/assistant-ui) 对工具栏、消息操作、输入区和外部状态适配的组织思路，但未引入其运行时或云端服务；当前实现继续使用铸文已有 IPC、SQLite 和本地会话真相。

## 未验证

- 安装器安装/升级、代码签名、macOS、DPI 矩阵
- 退出保存的完整 Electron 生命周期实测
