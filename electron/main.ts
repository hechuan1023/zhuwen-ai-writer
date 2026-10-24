import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { extractDocxTextBuffer } from "./docx";
import { decodeImportBuffer } from "./text-import";
import { writeVerifiedJson } from "./atomic-json";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { buildEpub } from "./epub";
import {
  Db,
  builtinPrompts,
  countText,
  localDate,
  newId,
  openDatabase,
  timestamp,
} from "./database";
import { FocusTracker } from "./focus-tracker";
import { DraftStorage, draftKey, DraftRecord } from "./draft-storage";
import { buildTaskAndStyleInstructions, effectiveStyleRules } from "./ai-style-cards";

let win: BrowserWindow | null = null;
let floatWin: BrowserWindow | null = null;
let db: Db;
let focusTracker: FocusTracker;
let closeReady = false;
let quitting = false;
const requests = new Map<string, AbortController>();
const searchTasks = new Map<string, { cancelled: boolean }>();
const importTasks = new Map<number, AbortController>();
const importFiles = new Map<string, { file: string; createdAt: number }>();
const IMPORT_SESSION_TTL = 30 * 60 * 1000;
// 铸文商用版固定走服务器网关：客户端不保存 LongCat API Key，也不允许切换模型。
// 网关令牌只允许通过运行环境注入，禁止写入源码或安装包。
const ZHUWEN_SERVER_CONNECTION_ID = "zhuwen-server-longcat";
const ZHUWEN_SERVER_BASE_URL = "http://118.31.220.154/zhuwen-api/v1";
const ZHUWEN_SERVER_MODEL = "LongCat-2.0";
const ZHUWEN_SERVER_TOKEN = String(process.env.ZHUWEN_CLIENT_TOKEN || "").trim();
const ZHUWEN_MAX_CONTEXT_CHARS = 300000;
const ZHUWEN_MAX_OUTPUT_TOKENS = 20000;

function serverConnection() {
  const row: any = get(
    "SELECT temperature,max_tokens,timeout_ms,streaming,reasoning_effort,created_at,updated_at FROM api_connections WHERE id=?",
    ZHUWEN_SERVER_CONNECTION_ID,
  );
  return {
    id: ZHUWEN_SERVER_CONNECTION_ID,
    name: "铸文 AI",
    base_url: ZHUWEN_SERVER_BASE_URL,
    model: "铸文默认模型",
    temperature: Number(row?.temperature ?? 0.7),
    max_tokens: Math.min(Number(row?.max_tokens ?? 4096), ZHUWEN_MAX_OUTPUT_TOKENS),
    timeout_ms: Number(row?.timeout_ms ?? 600000),
    streaming: row?.streaming !== 0,
    reasoning_effort: String(row?.reasoning_effort || ""),
    locked: true,
    max_context_chars: ZHUWEN_MAX_CONTEXT_CHARS,
    created_at: row?.created_at || timestamp(),
    updated_at: row?.updated_at || timestamp(),
  };
}

function requireServerToken() {
  if (!ZHUWEN_SERVER_TOKEN)
    throw new Error("铸文 AI 服务未配置运行令牌，请联系管理员完成激活");
  return ZHUWEN_SERVER_TOKEN;
}

function ensureServerConnection() {
  const t = timestamp();
  db.prepare(
    "INSERT OR IGNORE INTO api_connections(id,name,base_url,model,temperature,max_tokens,timeout_ms,streaming,reasoning_effort,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    ZHUWEN_SERVER_CONNECTION_ID,
    "铸文 AI",
    ZHUWEN_SERVER_BASE_URL,
    ZHUWEN_SERVER_MODEL,
    0.7,
    4096,
    600000,
    1,
    "medium",
    t,
    t,
  );
}

function registerImportFile(file: string) {
  const cutoff = Date.now() - IMPORT_SESSION_TTL;
  for (const [token, entry] of importFiles)
    if (entry.createdAt < cutoff) importFiles.delete(token);
  while (importFiles.size >= 20)
    importFiles.delete(importFiles.keys().next().value as string);
  const token = randomUUID();
  importFiles.set(token, { file, createdAt: Date.now() });
  return token;
}
type AiChapter = {
  id: string;
  title: string;
  plain_text: string;
  revision: number;
};
type AiSession = {
  novelId: string | null;
  chapter: AiChapter | null;
  selectionText: string;
  connectionId: string;
  conversationId: string;
  text: string;
  contexts: any[];
  messages: any[];
  generating: boolean;
  requestId: string;
  generatingConversationId?: string;
  /** AI 草稿持久化状态：渲染层据此区分保存中/已保存/失败 */
  draftState?: {
    status: "idle" | "saving" | "saved" | "error";
    error?: string;
    notices?: string[];
    at: string;
  };
};
const aiSession: AiSession = {
  novelId: null,
  chapter: null,
  selectionText: "",
  connectionId: "",
  conversationId: "",
  text: "",
  contexts: [],
  messages: [],
  generating: false,
  requestId: "",
  generatingConversationId: "",
};
function aiSessionSnapshot() {
  return JSON.parse(JSON.stringify(aiSession));
}
/** 会话草稿：按 novelId + convId 隔离 */
const conversationDrafts: Record<string, DraftRecord> = {};
/** 删除草稿的墓碑：key → 删除时的最高版本，防止延迟回调恢复已删除内容 */
const draftTombstones: Record<string, number> = {};
let draftStorage: DraftStorage | null = null;
function setDraftState(
  status: "idle" | "saving" | "saved" | "error",
  error?: string,
  notices?: string[],
) {
  aiSession.draftState = {
    status,
    ...(error ? { error } : {}),
    ...(notices?.length ? { notices } : {}),
    at: new Date().toISOString(),
  };
}
function loadDraftsFromDisk(userDir: string) {
  draftStorage = new DraftStorage(userDir);
  const outcome = draftStorage.load();
  Object.keys(conversationDrafts).forEach((k) => delete conversationDrafts[k]);
  Object.assign(conversationDrafts, outcome.store.drafts);
  Object.keys(draftTombstones).forEach((k) => delete draftTombstones[k]);
  Object.assign(draftTombstones, outcome.store.tombstones || {});
  setDraftState("idle", undefined, outcome.notices);
}
function persistDrafts() {
  if (!draftStorage) return;
  setDraftState("saving");
  draftStorage
    .saveAsync({
      format: "zhuwen-ai-drafts",
      version: 1,
      drafts: { ...conversationDrafts },
      tombstones: { ...draftTombstones },
    })
    .then(() => setDraftState("saved"))
    .catch((e) => {
      // 只记录错误与路径，不记录草稿正文/附件内容
      setDraftState("error", String(e?.message || e));
    });
}
/** 清除草稿并留下墓碑：此后任何 ≤ 该版本的延迟提交都会被拒绝 */
function clearConversationDraft(novelId: string, convId: string) {
  const key = draftKey(novelId, convId);
  const prev = conversationDrafts[key];
  draftTombstones[key] = Math.max(draftTombstones[key] || 0, prev?.version || 0);
  delete conversationDrafts[key];
  persistDrafts();
}
function saveConversationDraft(userDir: string) {
  const novelId = String(aiSession.novelId || "");
  if (!novelId) return;
  const convId = String(aiSession.conversationId || "");
  const key = draftKey(novelId, convId);
  const prev = conversationDrafts[key];
  const next: DraftRecord = {
    novelId,
    convId,
    text: String(aiSession.text || ""),
    contexts: JSON.parse(JSON.stringify(aiSession.contexts || [])),
    version:
      Math.max(prev?.version || 0, draftTombstones[key] || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  conversationDrafts[key] = next;
  persistDrafts();
  return next;
}
function loadConversationDraft(novelId: string, convId: string) {
  const d = conversationDrafts[draftKey(novelId, convId || "")];
  aiSession.text = d?.text || "";
  aiSession.contexts = d?.contexts ? JSON.parse(JSON.stringify(d.contexts)) : [];
  return d?.version || 0;
}
/** 草稿更新：必须带 novelId + convId + version，防串写 */
function applyDraftPatch(userDir: string, p: any) {
  const novelId = String(p?.novelId || aiSession.novelId || "");
  const convId = String(p?.conversationId ?? aiSession.conversationId ?? "");
  const key = draftKey(novelId, convId);
  const currentConv = String(aiSession.conversationId || "");
  const currentNovel = String(aiSession.novelId || "");
  // 目标必须仍是当前会话，否则丢弃过期延迟提交
  if (convId !== currentConv || (novelId && novelId !== currentNovel)) return false;
  const prev = conversationDrafts[key];
  const v = p?.draftVersion != null ? Number(p.draftVersion) : null;
  const stale =
    (v != null && prev?.version != null && v < prev.version) ||
    (v != null && draftTombstones[key] != null && v <= draftTombstones[key]);
  if (stale) return false;
  if (typeof p.text === "string") aiSession.text = p.text;
  if (Array.isArray(p.contexts)) aiSession.contexts = p.contexts;
  saveConversationDraft(userDir);
  broadcastSession();
  return true;
}
function sendSessionSnapshot() {
  const payload = aiSessionSnapshot();
  for (const w of [win, floatWin]) {
    if (w && !w.isDestroyed()) w.webContents.send("ai:session", payload);
  }
}
function broadcastSession() {
  cancelSessionBroadcast();
  sendSessionSnapshot();
}
let sessionBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
function cancelSessionBroadcast() {
  if (sessionBroadcastTimer) {
    clearTimeout(sessionBroadcastTimer);
    sessionBroadcastTimer = null;
  }
}
function scheduleSessionBroadcast() {
  if (sessionBroadcastTimer) return;
  sessionBroadcastTimer = setTimeout(() => {
    sessionBroadcastTimer = null;
    sendSessionSnapshot();
  }, 100);
}
function hardenWindow(target: BrowserWindow) {
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  target.webContents.on("will-navigate", (event, url) => {
    const current = target.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  attachDevShortcuts(target.webContents);
}
function openFloatWindow() {
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.focus();
    return;
  }
  floatWin = new BrowserWindow({
    width: 470,
    height: 780,
    minWidth: 360,
    minHeight: 480,
    title: "铸文 · AI 助手",
    backgroundColor: "#f4f1e9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  floatWin.on("closed", () => {
    floatWin = null;
  });
  hardenWindow(floatWin);
  if (isDev) floatWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}#ai-float`);
  else
    floatWin.loadFile(path.join(__dirname, "../dist/index.html"), {
      hash: "ai-float",
    });
}
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
if (process.env.ZHUWEN_UI_SMOKE)
  app.setPath(
    "userData",
    path.join(process.cwd(), "artifacts", "ui-smoke-profile"),
  );

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function buildMenu() {
  // macOS keeps the system app menu; Windows/Linux hide the English bar.
  // Clipboard/undo still work inside the renderer via Chromium.
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "fileMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
    return;
  }
  Menu.setApplicationMenu(null);
}

function attachDevShortcuts(contents: Electron.WebContents) {
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = input.control || input.meta;
    if (!mod || input.alt) return;
    const key = input.key.toLowerCase();
    if (key === "r" && !input.shift) {
      event.preventDefault();
      contents.reload();
      return;
    }
    if (key === "i" && input.shift) {
      event.preventDefault();
      contents.toggleDevTools();
    }
  });
}

app.whenReady().then(() => {
  const userDir = app.getPath("userData");
  try {
    db = openDatabase(path.join(userDir, "zhuwen.sqlite3"));
    const check: any[] = db.prepare("PRAGMA quick_check").all();
    if (!check.length || check.some((row) => String(row.quick_check) !== "ok"))
      throw new Error("数据库完整性检查未通过");
    ensureServerConnection();
  } catch (error) {
    dialog.showErrorBox(
      "铸文无法安全打开资料库",
      `${error instanceof Error ? error.message : String(error)}\n\n数据文件没有被覆盖。请保留应用数据目录并从备份恢复，或联系技术支持。`,
    );
    app.quit();
    return;
  }
  focusTracker = new FocusTracker({
    newId: () => newId(),
    insert: (row) => {
      db.prepare(
        `INSERT INTO writing_focus_sessions(id,novel_id,chapter_id,date,started_at,ended_at,duration_ms,committed_ms,logical_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.id,
        row.novelId,
        row.chapterId,
        row.date,
        row.startedAt,
        row.endedAt,
        row.durationMs,
        row.committedMs,
        row.logicalId,
        timestamp(),
      );
    },
    update: (id, committedMs, endedAt) => {
      db.prepare(
        `UPDATE writing_focus_sessions SET committed_ms=?, duration_ms=?, ended_at=COALESCE(?, ended_at), data_version=data_version+1 WHERE id=?`,
      ).run(committedMs, committedMs, endedAt, id);
    },
  });
  loadDraftsFromDisk(userDir);
  registerIpc(userDir);
  configureAutoBackup();
  buildMenu();
  createMainWindow();
});

function createMainWindow() {
  closeReady = false;
  quitting = false;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 780,
    minHeight: 560,
    title: "铸文",
    backgroundColor: "#f5f2eb",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("close", (e) => {
    if (!closeReady) {
      e.preventDefault();
      win?.webContents.send("app:before-close");
    }
  });
  win.on("closed", () => {
    if (floatWin && !floatWin.isDestroyed()) floatWin.close();
  });
  win.webContents.on("render-process-gone", async (_event, details) => {
    if (!win || win.isDestroyed() || details.reason === "clean-exit") return;
    // A dead renderer cannot acknowledge the normal save-before-close handshake.
    closeReady = true;
    const result = await dialog.showMessageBox(win, {
      type: "error",
      title: "铸文界面意外停止",
      message: "写作界面意外停止运行。最近一次自动保存的数据仍在本机。",
      detail: `原因：${details.reason}。重新载入可继续使用；尚未来得及自动保存的少量输入可能无法恢复。`,
      buttons: ["重新载入", "退出应用"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (!win || win.isDestroyed()) return;
    if (result.response === 0) {
      closeReady = false;
      win.reload();
    } else {
      win.close();
    }
  });
  hardenWindow(win);
  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else win.loadFile(path.join(__dirname, "../dist/index.html"));
  if (process.env.ZHUWEN_UI_SMOKE)
    win.webContents.once("did-finish-load", async () => {
      const js = (code: string) => win!.webContents.executeJavaScript(code);
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const shotsFailed: string[] = [];
      const shotDir = path.join(process.cwd(), "artifacts", "chat-shots");
      // capturePage 在合成器未就绪时会抛 UnknownVizError：重试几次并记录失败
      const shot = async (name: string) => {
        fs.mkdirSync(shotDir, { recursive: true });
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const img = await win!.webContents.capturePage();
            fs.writeFileSync(path.join(shotDir, name + ".png"), img.toPNG());
            return;
          } catch {
            await wait(350);
          }
        }
        shotsFailed.push(name);
      };
      const uiSmokeErrorFile = path.join(
        process.cwd(),
        "artifacts",
        "ui-smoke-error.txt",
      );
      // 先清掉上一轮残留，避免陈旧错误文件冒充本次失败
      try {
        fs.rmSync(uiSmokeErrorFile, { force: true });
      } catch {}
      try {
        await wait(500);
        // 首次引导：有则关闭，避免挡住首页操作
        await js(
          `(()=>{const btn=[...document.querySelectorAll('.modal button')].find(b=>b.textContent.includes('开始写作')||b.textContent.includes('Start writing'));if(btn)btn.click();return true})()`,
        );
        await wait(200);
        // 首页目标计必须标注「全部作品」，否则会与工作台的「本书」看起来互相矛盾
        const homeGoalScopeOk = await js(
          `(()=>{const el=document.querySelector('[data-fd-id="daily-goal-meter"]');if(!el)return false;const label=el.querySelector('.goal-meter__scope');return el.dataset.scope==='all'&&Boolean(label&&label.textContent.trim())})()`,
        );
        await js(
          `(()=>{const btn=[...document.querySelectorAll('.home button, .home-shell button')].find(b=>b.textContent.includes('新建小说')||b.textContent.includes('New novel'));if(!btn)throw new Error('home create button missing');btn.click();return true})()`,
        );
        await wait(150);
        const createFormOk = await js(
          `Boolean(document.querySelector('.create-novel-form'))`,
        );
        await js(
          `(()=>{const fields=document.querySelectorAll('.create-novel-form input');const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};set(fields[0],'界面测试作品');set(fields[1],'测试作者');[...document.querySelectorAll('.create-novel-form button')].find(b=>b.textContent.includes('创建并开始写作')).click()})()`,
        );
        let opened = false;
        for (let i = 0; i < 20 && !opened; i++) {
          opened = await js(
            `Boolean(document.querySelector('.workspace')&&document.querySelector('.manuscript'))`,
          );
          if (!opened) await wait(150);
        }
        if (!opened) throw new Error("UI smoke failed to open workspace");
        await js(
          `(()=>{const el=document.querySelector('.manuscript');el.focus();document.execCommand('insertText',false,'中文输入冒烟测试：山风越过长夜。')})()`,
        );
        await wait(1800);
        const status = await js(`document.querySelector('.save')?.textContent`);
        await js(
          `(()=>{const w=document.querySelector('.workspace');if(!w.classList.contains('typewriter-on'))([...document.querySelectorAll('button')].find(b=>b.title.startsWith('打字机模式')))?.click()})()`,
        );
        await wait(120);
        const typewriterOk = await js(
          `document.querySelector('.workspace').classList.contains('typewriter-on')`,
        );
        const zoomOk = await js(
          `Boolean(document.querySelector('.status-zoom'))`,
        );
        // 工作台的目标计只统计当前作品，必须显式标注为「本书」
        const goalScopeOk = await js(
          `(()=>{const el=document.querySelector('.status [data-fd-id="daily-goal-meter"]');if(!el)return false;const label=el.querySelector('.goal-meter__scope');return el.dataset.scope.startsWith('novel:')&&Boolean(label&&label.textContent.trim())})()`,
        );
        await js(`(()=>{if(!document.querySelector('.right-panel'))document.querySelector('.topbar .primary.small')?.click()})()`);
        await wait(250);
        const aiOk = await js(
          `Boolean(document.querySelector('.zchat [data-fd-id="ai-composer"]')&&document.querySelector('[data-fd-id="ai-toolbar"]'))`,
        );
        await js(
          `document.querySelector('[data-fd-id="ai-add-ref"]')?.click()`,
        );
        await wait(250);
        await shot("02-ref-picker");
        const pickerOk = await js(
          `Boolean(document.querySelector('[data-fd-id="ai-ref-picker"]')&&document.querySelector('[data-fd-id="ai-picker-chapter"]'))`,
        );
        await shot("02-ref-picker-open");
        await js(
          `document.querySelector('[data-fd-id="ai-ref-picker"] .zchat-icon-btn')?.click()`,
        );
        await wait(250);
        await shot("01-ai-empty");
        await js(`(()=>{const f=document.querySelector('[data-fd-id="ai-input"]');if(!f)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(f,'帮我想想第三章的场景推进');f.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
        await wait(300);
        await shot("05-composer-filled");
        // 顶部会话栏：历史抽屉可开合
        await js(`document.querySelector('[data-fd-id="ai-history-toggle"]')?.click()`);
        await wait(250);
        await shot("03-history-drawer");
        const historyDrawerOk = await js(
          `Boolean(document.querySelector('[data-fd-id="ai-history-drawer"]'))`,
        );
        await js(
          `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
        );
        await wait(200);
        const historyClosedOk = await js(
          `!document.querySelector('[data-fd-id="ai-history-drawer"]')`,
        );
        await js(
          `(()=>{document.querySelector('.toolbar-more').open=true;([...document.querySelectorAll('.toolbar-menu button')].find(b=>b.textContent.trim()==='设置'))?.click()})()`,
        );
        // Settings 模块是懒加载分包，轮询等待其挂载
        let settingsOk = false;
        for (let i = 0; i < 15 && !settingsOk; i++) {
          settingsOk = await js(
            `Boolean(document.querySelector('.settings-nav')&&document.querySelector('[data-fd-id="settings-language"] .zw-select-trigger'))`,
          );
          if (!settingsOk) await wait(200);
        }
        const languageOk = settingsOk && await js(
          `(()=>{const btn=document.querySelector('[data-fd-id="settings-language"] .zw-select-trigger');if(!btn)throw new Error('language select missing');btn.click();return true})()`,
        );
        await wait(150);
        await js(
          `(()=>{const opt=[...document.querySelectorAll('.zw-select-option')].find(o=>o.textContent.includes('English'));if(!opt)throw new Error('English option missing');opt.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return true})()`,
        );
        await wait(150);
        const translatedSettingsOk = await js(
          `Boolean([...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent.trim()==='General')&&[...document.querySelectorAll('.settings h3')].find(h=>h.textContent.includes('Language & general')))`,
        );
        await js(
          `([...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent.trim()==='AI models'))?.click()`,
        );
        await wait(100);
        const translatedAiSettingsOk = await js(
          `Boolean([...document.querySelectorAll('.settings h3')].find(h=>h.textContent.includes('AI API connections'))&&[...document.querySelectorAll('.settings h3')].find(h=>h.textContent.includes('Prompt templates')))`,
        );
        // 应用内确认弹窗：原生 confirm/prompt 已全部换成应用内弹窗。
        // 这里验证「恢复默认模板」确实弹出可取消的确认框——点取消，不落地任何改动。
        const dialogTriggeredOk = await js(
          `(()=>{const btn=[...document.querySelectorAll('button')].find(b=>/Reset built-in templates|恢复默认模板/.test(b.textContent));if(!btn)return false;btn.click();return true})()`,
        );
        await wait(200);
        const dialogOpenOk =
          dialogTriggeredOk &&
          (await js(
            `Boolean(document.querySelector('[data-fd-id="confirm-ok"]'))`,
          ));
        await js(
          `(()=>{const ok=document.querySelector('[data-fd-id="confirm-ok"]');const modal=ok&&ok.closest('.modal');if(!modal)return false;const btn=[...modal.querySelectorAll('button')].find(b=>b.getAttribute('data-fd-id')!=='confirm-ok');if(btn)btn.click();return true})()`,
        );
        await wait(200);
        const dialogCloseOk = await js(
          `!document.querySelector('[data-fd-id="confirm-ok"]')`,
        );
        const dialogOk = Boolean(
          dialogTriggeredOk && dialogOpenOk && dialogCloseOk,
        );
        // 新面板顶部显示会话标题；用发送按钮的可访问名断言英文界面仍然生效
        const translatedAiPanelOk = await js(
          `(() => {
             const send = document.querySelector('[data-fd-id="ai-send"]');
             const toolbar = document.querySelector('[data-fd-id="ai-toolbar"]');
             if (!send || !toolbar) return false;
             const label = send.getAttribute('aria-label') || '';
             const isEnglish = label === 'Send' || label === 'Generate continuation';
             const noLegacyBar = !document.querySelector('.conversation-bar');
             return isEnglish && noLegacyBar;
           })()`,
        );
        await js(`document.querySelector('button[data-view="library"]')?.click()`);
        let translatedLibraryOk = false;
        for (let i = 0; i < 15 && !translatedLibraryOk; i++) {
          translatedLibraryOk = await js(
            `Boolean(document.querySelector('.left-pane .panel-head strong')?.textContent.includes('Story Bible'))`,
          );
          if (!translatedLibraryOk) await wait(120);
        }
        await js(`document.querySelector('button[data-view="chapters"]')?.click()`);
        await js(
          `([...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent.trim()==='General'))?.click()`,
        );
        await wait(80);
        await js(
          `(()=>{const btn=document.querySelector('[data-fd-id="settings-language"] .zw-select-trigger');btn?.click();return true})()`,
        );
        await wait(120);
        await js(
          `(()=>{const opt=[...document.querySelectorAll('.zw-select-option')].find(o=>o.textContent.includes('简体中文'));opt?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));return true})()`,
        );
        await wait(120);
        const goalOk = await js(
          `Boolean([...document.querySelectorAll('.settings h3')].find(h=>h.textContent.includes('写作目标')))`,
        );
        await js(`([...document.querySelectorAll('.data-health button')].find(b=>b.textContent.includes('检查')))?.click()`);
        await wait(200);
        const healthOk = await js(`document.querySelector('.data-health b')?.textContent.includes('正常')`);
        await js(
          `([...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent.trim()==='编辑器'))?.click()`,
        );
        await wait(100);
        const typoOk = await js(
          `Boolean([...document.querySelectorAll('.settings h3')].find(h=>h.textContent.includes('正文排版')))`,
        );
        await js(
          `([...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent.includes('外观')))?.click()`,
        );
        await wait(100);
        const appearanceOk = await js(
          `Boolean(document.querySelector('.appearance-settings')&&document.querySelector('.background-picker')&&document.querySelector('.density-options'))`,
        );
        await js(
          `(()=>{const el=document.querySelector('[data-fd-id="settings-reduce-motion"]');if(!el)return false;el.click();return true})()`,
        );
        await wait(150);
        const reduceMotionOk = await js(
          `document.documentElement.classList.contains('reduce-motion')`,
        );
        // 「减少动态效果」与「减少透明效果」必须独立，不能互相带动
        const reduceMotionIndependentOk = await js(
          `document.documentElement.classList.contains('reduce-motion')&&!document.documentElement.classList.contains('reduce-transparency')`,
        );
        await js(
          `(()=>{const el=document.querySelector('[data-fd-id="settings-reduce-motion"]');if(el)el.click();return true})()`,
        );
        await wait(150);
        const reduceMotionOffOk = await js(
          `!document.documentElement.classList.contains('reduce-motion')`,
        );
        await js(`document.querySelector('.modal > header button')?.click()`);
        await wait(150);
        await js(
          `window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}))`,
        );
        await wait(200);
        const findOk = await js(`Boolean(document.querySelector('.find-bar'))`);
        await js(
          `document.querySelector('.topbar button[title="全书查找"]')?.click()`,
        );
        await wait(200);
        const bookSearchOk = await js(
          `Boolean(document.querySelector('.book-search'))`,
        );
        await js(`(()=>{const el=document.querySelector('.book-search input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,'山风');el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.book-search .primary')?.click()})()`);
        let bookSearchRunOk = false;
        for (let i = 0; i < 12 && !bookSearchRunOk; i++) {
          bookSearchRunOk = await js(`Boolean(document.querySelector('.search-results button'))`);
          if (!bookSearchRunOk) await wait(100);
        }
        await js(`document.querySelector('.modal > header button')?.click()`);
        await wait(150);
        await js(
          `(()=>{document.querySelector('.toolbar-more').open=true;([...document.querySelectorAll('.toolbar-menu button')].find(b=>b.textContent.trim()==='写作统计'||b.textContent.trim()==='Writing statistics'))?.click()})()`,
        );
        let statsOk = false;
        for (let i = 0; i < 15 && !statsOk; i++) {
          statsOk = await js(
            `Boolean(document.querySelector('[data-fd-id="stats-center"]')&&document.querySelector('.stats-kpis')&&document.querySelector('.stats-calendar'))`,
          );
          if (!statsOk) await wait(150);
        }
        await js(`document.querySelector('.modal > header button')?.click()`);
        await wait(150);
        await js(`document.querySelector('[data-fd-id="ai-add-ref"]')?.click()`);
        await wait(200);
        await js(`document.querySelector('[data-fd-id="ai-picker-chapter"]')?.click()`);
        await wait(300);
        const mainShared = await js(
          `Boolean(document.querySelector('[data-fd-id="ai-ref-chips"] .zchat-ref'))`,
        );
        // 浮窗入口已迁入「更多」菜单（功能不变，仅入口变化）
        await js(`document.querySelector('[data-fd-id="ai-more-menu"]')?.click()`);
        await wait(200);
        await shot("04-more-menu");
        const moreMenuOk = await js(
          `Boolean(document.querySelector('[data-fd-id="ai-menu-rename"]')&&document.querySelector('[data-fd-id="ai-menu-float"]'))`,
        );
        await js(`document.querySelector('[data-fd-id="ai-menu-float"]')?.click()`);
        await wait(1600);
        const floatLoaded = Boolean(floatWin && !floatWin.isDestroyed());
        let floatShared = false;
        if (floatLoaded) {
          for (let i = 0; i < 8 && !floatShared; i++) {
            try {
              floatShared = await floatWin!.webContents.executeJavaScript(
                `Boolean(document.querySelector('.float-window')&&document.querySelector('.zchat'))`,
              );
            } catch {}
            if (!floatShared) await wait(500);
          }
        }
        await js(
          `(()=>{document.querySelector('.toolbar-more').open=true;([...document.querySelectorAll('.toolbar-menu button')].find(b=>b.textContent.trim()==='摘要'))?.click()})()`,
        );
        let summaryOk = false;
        for (let i = 0; i < 15 && !summaryOk; i++) {
          summaryOk = await js(`Boolean(document.querySelector('.summary-modal'))`);
          if (!summaryOk) await wait(150);
        }
        await js(`document.querySelector('.modal > header button')?.click()`);
        await wait(150);
        await js(
          `document.querySelector('.workspace-rail button[data-view="library"]')?.click()`,
        );
        // 资料库分类：8 个 tab（大纲/章节细纲/人物卡/世界设定/灵感笔记/时间线/伏笔/人物关系）
        let kindTabsOk = false;
        for (let i = 0; i < 15 && !kindTabsOk; i++) {
          kindTabsOk = await js(
            `(()=>{const b=[...document.querySelectorAll('.kind-tabs button')].map(x=>x.textContent.trim());return b.length===8&&b.includes('章节细纲')&&b.includes('伏笔')})()`,
          );
          if (!kindTabsOk) await wait(150);
        }
        // 章节细纲分类：新建一条并落库，确认编辑器渲染的是该分类独有字段而非沿用上一分类
        if (aiSession.novelId) {
          await js(
            `window.zhuwen.invoke('library:save',{novelId:${JSON.stringify(aiSession.novelId)},kind:'scene',title:'细纲场景',content:{plotRole:'转折',hook:'身份曝光',cast:'甲'},tags:[]})`,
          );
          await wait(200);
        }
        await js(
          `([...document.querySelectorAll('.kind-tabs button')].find(b=>b.textContent.trim()==='章节细纲'))?.click()`,
        );
        let sceneListOk = false;
        for (let i = 0; i < 15 && !sceneListOk; i++) {
          sceneListOk = await js(`Boolean(document.querySelector('.library-list article'))`);
          if (!sceneListOk) await wait(150);
        }
        await js(`document.querySelector('.library-list article')?.click()`);
        let sceneKindOk = false;
        for (let i = 0; i < 15 && !sceneKindOk; i++) {
          sceneKindOk = await js(
            `(()=>{const box=document.querySelector('.editor-area > .library-detail-surface .library-edit');if(!box)return false;const ph=[...box.querySelectorAll('input,textarea')].map(x=>x.placeholder||'');return ph.some(p=>p.includes('章末钩子'))&&ph.some(p=>p.includes('剧情作用'))&&!ph.some(p=>p.includes('防崩')||p.includes('回收说明'))})()`,
          );
          if (!sceneKindOk) await wait(150);
        }
        await js(`document.querySelector('.library-detail-surface > header button')?.click()`);
        await wait(150);
        if (aiSession.novelId) {
          await js(
            `window.zhuwen.invoke('library:save',{novelId:${JSON.stringify(aiSession.novelId)},kind:'relation',title:'关系',content:{from:'甲',to:'乙',label:'师徒'},tags:[]})`,
          );
          await wait(200);
        }
        await js(
          `([...document.querySelectorAll('.kind-tabs button')].find(b=>b.textContent.trim()==='人物关系'))?.click()`,
        );
        let relationOk = false;
        for (let i = 0; i < 15 && !relationOk; i++) {
          relationOk = await js(`Boolean(document.querySelector('.relation-graph'))`);
          if (!relationOk) await wait(150);
        }
        await js(`document.querySelector('.graph-expand')?.click()`);
        await wait(150);
        const relationExpandOk = await js(`Boolean(document.querySelector('.relation-detail .relation-graph'))`);
        await js(`document.querySelector('.relation-detail > header button')?.click()`);
        await js(`document.querySelector('.library-list article')?.click()`);
        await wait(150);
        const libraryDetailOk = await js(`Boolean(document.querySelector('.editor-area > .library-detail-surface .library-edit'))`);
        // 设定库删除入口（library:trash）：按钮存在 → 弹出确认 → 取消不删除
        const libraryTrashBtnOk = await js(`Boolean(document.querySelector('[data-fd-id="library-trash"]'))`);
        const libraryCountBefore = await js(`document.querySelectorAll('.library-list article').length`);
        await js(`document.querySelector('[data-fd-id="library-trash"]')?.click()`);
        await wait(200);
        const libraryTrashDialogOk = await js(`Boolean(document.querySelector('[data-fd-id="confirm-ok"]'))`);
        await js(`document.querySelector('.modal > header button')?.click()`);
        await wait(200);
        const libraryTrashCancelOk = await js(`document.querySelectorAll('.library-list article').length===${libraryCountBefore}`);
        await js(`document.querySelector('.library-detail-surface > header button')?.click()`);
        const checks = {
          createFormOk,
          typewriterOk,
          zoomOk,
          aiOk,
          pickerOk,
          historyDrawerOk,
          historyClosedOk,
          typoOk,
          languageOk,
          translatedSettingsOk,
          translatedAiSettingsOk,
          dialogOk,
          translatedAiPanelOk,
          translatedLibraryOk,
          appearanceOk,
          goalOk,
          healthOk,
          findOk,
          bookSearchOk,
          bookSearchRunOk,
          statsOk,
          homeGoalScopeOk,
          goalScopeOk,
          reduceMotionOk,
          reduceMotionIndependentOk,
          reduceMotionOffOk,
          mainShared,
          moreMenuOk,
          floatLoaded,
          floatShared,
          summaryOk,
          kindTabsOk,
          sceneListOk,
          sceneKindOk,
          relationOk,
          relationExpandOk,
          libraryDetailOk,
          libraryTrashBtnOk,
          libraryTrashDialogOk,
          libraryTrashCancelOk,
        };
        const failedChecks = Object.entries(checks)
          .filter(([, v]) => !v)
          .map(([k, v]) => `${k}=${String(v)}`);
        if (failedChecks.length)
          throw new Error(
            `UI smoke feature failed: ${failedChecks.join(', ')} | ${JSON.stringify(checks)}`,
          );
        try {
          if (floatWin && !floatWin.isDestroyed()) floatWin.close();
        } catch {}
        const out = path.join(process.cwd(), "artifacts", "ui-smoke.png");
        fs.mkdirSync(path.dirname(out), { recursive: true });
        for (let i = 0; i < 3; i++) {
          try {
            fs.writeFileSync(
              out,
              (await win!.webContents.capturePage()).toPNG(),
            );
            break;
          } catch {
            await wait(400);
          }
        }
        if (shotsFailed.length)
          console.log(`UI_SHOTS_FAIL ${shotsFailed.join(",")}`);
        console.log(
          `UI_SMOKE_OK workspace_open editor_input settings_i18n ai_i18n library_i18n reference_picker typography_settings daily_goal database_health find_bar book_search book_search_run writing_stats goal_scope_home goal_scope_workspace reduce_motion_independent confirm_dialog ai_float_shared history_drawer summary_modal library_kinds relation_graph relation_expand library_detail library_trash ${status} ${out}`,
        );
        app.exit(0);
      } catch (e) {
        try { fs.mkdirSync(path.dirname(uiSmokeErrorFile), { recursive: true }); fs.writeFileSync(uiSmokeErrorFile, String(e instanceof Error ? e.stack || e.message : e)); } catch {}
        console.error(
          `UI_SMOKE_FAIL ${e instanceof Error ? e.message : String(e)}`,
        );
        app.exit(1);
      }
    });
}
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
app.on("before-quit", (e) => {
  if (closeReady) return;
  if (!win || win.isDestroyed()) {
    closeReady = true;
    return;
  }
  e.preventDefault();
  quitting = true;
  win.webContents.send("app:before-close");
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
let quitFinalizing = false;
app.on("will-quit", (e) => {
  cancelSessionBroadcast();
  try {
    focusTracker?.end();
  } catch {}
  if (quitFinalizing) {
    // 第二次进入：队列已等待完毕（或超时），安全收尾
    try {
      db?.close();
    } catch {}
    return;
  }
  // 首次 will-quit：有界等待草稿队列落盘，防止退出截断写入
  e.preventDefault();
  quitFinalizing = true;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try {
      db?.close();
    } catch {}
    app.quit();
  };
  const timer = setTimeout(() => {
    // 超时不是保存成功：状态层保留 error/saving，如实呈现
    if (draftStorage && draftStorage.isSaving)
      setDraftState("error", "退出等待超时，草稿可能未完成保存");
    finish();
  }, 2500);
  try {
    draftStorage
      ?.flush(2000)
      .then((r) => {
        if (!r.flushed && draftStorage?.isSaving)
          setDraftState("error", "退出等待超时，草稿可能未完成保存");
      })
      .catch((err) => {
        setDraftState("error", String(err?.message || err));
      })
      .finally(() => {
        clearTimeout(timer);
        finish();
      });
  } catch {
    clearTimeout(timer);
    finish();
  }
});

function all(sql: string, ...args: any[]) {
  return db.prepare(sql).all(...args);
}
function get(sql: string, ...args: any[]) {
  return db.prepare(sql).get(...args);
}
function contextText(items: any[] = []) {
  return items
    .map((x) => `【引用：${x.label} / ${x.kind}】\n${x.content}`)
    .join("\n\n");
}
function conversationHistory(conversationId: string) {
  if (!conversationId) return [];
  const rows: any[] = all(
    "SELECT id,role,content FROM ai_messages WHERE conversation_id=? ORDER BY created_at,rowid",
    conversationId,
  );
  const ids = rows.filter((x) => x.role === "user").map((x) => x.id);
  const snapshots: any[] = ids.length
    ? all(
        `SELECT message_id,label,kind,content FROM message_context_snapshots WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at,rowid`,
        ...ids,
      )
    : [];
  const grouped = new Map<string, any[]>();
  for (const item of snapshots)
    grouped.set(item.message_id, [...(grouped.get(item.message_id) || []), item]);
  return rows.map((row) => {
    const prefix = row.role === "user" ? contextText(grouped.get(row.id)) : "";
    return {
      role: row.role,
      content: (prefix ? `${prefix}\n\n` : "") + row.content,
    };
  });
}
/** 铸文写作助手人设：不暴露底层模型/供应商信息 */
const ZHUWEN_WRITER_PERSONA = [
  "你是「铸文」内置的文学创作助手，面向长篇小说作者。",
  "角色定位：专属写作灵感编审，专业、克制，贴合叙事节奏。",
  "身份约束：不要提及底层模型名称、研发公司、服务器或 API；若被问及你是谁，只回答「我是铸文的写作助手」。",
  "工作方式：优先依据用户明确添加的引用内容工作；无引用时不要编造正文细节。",
  "语言：默认使用与用户输入一致的语言。",
].join("\n");
function withWriterPersona(messages: any[]) {
  const list = Array.isArray(messages) ? [...messages] : [];
  // 人配置置顶，风格卡规则紧随其后
  list.unshift({ role: "system", content: ZHUWEN_WRITER_PERSONA });
  return list;
}
function styleCardRow(id: string) {
  const row: any = id ? get("SELECT * FROM ai_style_cards WHERE id=?", id) : null;
  if (!row) return null;
  let tasks: string[] = [];
  try { tasks = JSON.parse(row.tasks_json || "[]"); } catch {}
  const card = { ...row, tasks, version: Number(row.builtin_version || 1) };
  return { ...card, rules: effectiveStyleRules(card) };
}
function requestStyle(p: any) {
  const requestedIds = Array.isArray(p?.styleIds)
    ? p.styleIds
    : p?.styleId ? [p.styleId] : [];
  const ids: string[] = [...new Set<string>(requestedIds.map((id: unknown) => String(id || "").trim()).filter((id: string) => Boolean(id)))].slice(0, 6);
  const task = String(p?.taskKind || "chat");
  const cards = task === "chat" || task === "check"
    ? []
    : ids.map((id) => styleCardRow(id)).filter((card: any) =>
        card && (card.tasks.includes(task) || (task === "naturalize" && card.tasks.includes("polish"))),
      );
  const instruction = buildTaskAndStyleInstructions(cards, task);
  const card = cards.length
    ? {
        id: cards[0].id,
        name: cards.map((item: any) => item.name).join(" + "),
        version: Math.max(...cards.map((item: any) => Number(item.version || 1))),
        rules: instruction,
      }
    : null;
  return { card, cards, instruction };
}
const ok = <T>(data: T) => ({ ok: true, data });
const fail = (e: unknown) => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e),
});

async function readImportFile(
  file: string,
  total: number,
  progress: (read: number) => void,
  signal?: AbortSignal,
) {
  const chunks: Buffer[] = [];
  let read = 0;
  progress(0);
  const stream = fs.createReadStream(file, {
    highWaterMark: 512 * 1024,
    signal,
  });
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    read += buffer.length;
    progress(Math.min(read, total));
  }
  return Buffer.concat(chunks, read);
}

function registerIpc(userDir: string) {
  const librarySourceKinds = new Set([
    "outline", "scene", "character", "world", "inspiration", "timeline", "foreshadow", "relation",
  ]);
  const sourceState = (snapshot: any, novelId: string) => {
    if (!librarySourceKinds.has(String(snapshot.kind || "")) || !snapshot.source_id)
      return { ...snapshot, source_status: "untracked", current_data_version: null, current_title: null };
    const current: any = get(
      "SELECT title,data_version,deleted_at FROM library_items WHERE id=? AND novel_id=? AND kind=?",
      snapshot.source_id,
      novelId,
      snapshot.kind,
    );
    const status = !current
      ? "missing"
      : current.deleted_at
        ? "deleted"
        : snapshot.source_data_version == null
          ? "unknown"
          : Number(current.data_version) !== Number(snapshot.source_data_version)
            ? "changed"
            : "current";
    return {
      ...snapshot,
      source_status: status,
      current_data_version: current ? Number(current.data_version) : null,
      current_title: current?.title || null,
    };
  };
  ipcMain.handle("database:health", () => {
    try {
      db.pragma("wal_checkpoint(PASSIVE)");
      const rows: any[] = db.prepare("PRAGMA quick_check").all();
      const healthy = rows.length > 0 && rows.every((row) => row.quick_check === "ok");
      const file = path.join(userDir, "zhuwen.sqlite3");
      return ok({
        healthy,
        detail: rows.map((row) => row.quick_check).join("；"),
        size: fs.existsSync(file) ? fs.statSync(file).size : 0,
        novels: Number((get("SELECT COUNT(*) count FROM novels WHERE deleted_at IS NULL") as any)?.count || 0),
        chapters: Number((get("SELECT COUNT(*) count FROM chapters WHERE deleted_at IS NULL") as any)?.count || 0),
        checkedAt: timestamp(),
      });
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("app:close-ready", () => {
    closeReady = true;
    if (quitting) app.quit();
    else win?.close();
    return ok(true);
  });
  ipcMain.handle("preferences:get", (_, key) => {
    try {
      const row: any = get("SELECT value_json FROM preferences WHERE key=?", key);
      return ok(row?.value_json ? JSON.parse(row.value_json) : null);
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("preferences:set", (_, p) => {
    try {
      if (!p || typeof p.key !== "string" || !p.key.trim())
        throw new Error("无效的设置项");
      let next = p.value;
      if (p.merge && next && typeof next === "object" && !Array.isArray(next)) {
        const row: any = get(
          "SELECT value_json FROM preferences WHERE key=?",
          p.key,
        );
        let prev: any = {};
        try {
          prev = row?.value_json ? JSON.parse(row.value_json) : {};
        } catch {
          prev = {};
        }
        if (prev && typeof prev === "object" && !Array.isArray(prev))
          next = { ...prev, ...next };
      }
      const value = JSON.stringify(next ?? null);
      const t = timestamp();
      db.prepare(
        `INSERT INTO preferences(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,data_version=data_version+1`,
      ).run(p.key, value, t);
      if (p.key === "autoBackup") configureAutoBackup();
      return ok(true);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle("novels:list", (_, p = {}) =>
    ok(
      all(
        `SELECT n.*, (SELECT COUNT(*) FROM chapters c WHERE c.novel_id=n.id AND c.deleted_at IS NULL) chapter_count, (SELECT COALESCE(SUM(word_count),0) FROM chapters c WHERE c.novel_id=n.id AND c.deleted_at IS NULL) word_count, (SELECT c.title FROM chapters c WHERE c.id=n.last_chapter_id AND c.deleted_at IS NULL) last_chapter_title FROM novels n WHERE n.deleted_at IS NULL AND n.archived=? ORDER BY ${p.sort === "title" ? "n.title COLLATE NOCASE" : p.sort === "created" ? "n.created_at DESC" : "n.updated_at DESC"}`,
        p.archived ? 1 : 0,
      ),
    ),
  );
  ipcMain.handle("novels:create", (_, p) => {
    const id = newId(),
      t = timestamp();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO novels(id,title,author,synopsis,genre,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        p.title.trim(),
        p.author || "",
        p.synopsis || "",
        p.genre || "",
        t,
        t,
      );
      const cid = newId();
      db.prepare(
        "INSERT INTO chapters(id,novel_id,title,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      ).run(cid, id, "第一章", 0, t, t);
      db.prepare("UPDATE novels SET last_chapter_id=? WHERE id=?").run(cid, id);
    })();
    return ok({ id });
  });
  ipcMain.handle("novels:update", (_, p) => {
    const fields = [
      "title",
      "author",
      "synopsis",
      "genre",
      "cover_path",
      "last_chapter_id",
      "archived",
    ];
    const set = fields.filter((k) => k in p).map((k) => `${k}=@${k}`);
    db.prepare(
      `UPDATE novels SET ${set.join(",")},updated_at=@updated_at,data_version=data_version+1 WHERE id=@id`,
    ).run({ ...p, updated_at: timestamp() });
    return ok(true);
  });
  ipcMain.handle("novels:trash", (_, id) => {
    db.prepare("UPDATE novels SET deleted_at=?,updated_at=? WHERE id=?").run(
      timestamp(),
      timestamp(),
      id,
    );
    return ok(true);
  });
  ipcMain.handle("novels:restore", (_, id) => {
    db.prepare("UPDATE novels SET deleted_at=NULL,updated_at=? WHERE id=?").run(
      timestamp(),
      id,
    );
    return ok(true);
  });
  ipcMain.handle("novels:trashList", () =>
    ok(
      all(
        "SELECT * FROM novels WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
      ),
    ),
  );
  ipcMain.handle("novels:chooseCover", async () => {
    const r = await dialog.showOpenDialog({
      title: "选择封面图片",
      filters: [
        {
          name: "图片",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
        },
      ],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths[0]) return ok(null);
    const file = r.filePaths[0];
    if ((await fs.promises.stat(file)).size > 3 * 1024 * 1024)
      return fail("封面图片过大，请选择 3MB 以内的图片");
    const ext = path.extname(file).toLowerCase().replace(".", "");
    const mime =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "svg"
          ? "image/svg+xml"
          : `image/${ext || "png"}`;
    const dataUrl = `data:${mime};base64,${(await fs.promises.readFile(file)).toString("base64")}`;
    return ok({ dataUrl });
  });
  ipcMain.handle("appearance:chooseBackground", async () => {
    const r = await dialog.showOpenDialog({
      title: "选择写作背景",
      filters: [
        {
          name: "图片",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
        },
      ],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths[0]) return ok(null);
    const file = r.filePaths[0];
    if ((await fs.promises.stat(file)).size > 12 * 1024 * 1024)
      return fail("背景图片过大，请选择 12MB 以内的图片");
    const ext = path.extname(file).toLowerCase().replace(".", "");
    const mime =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext || "png"}`;
    return ok({
      dataUrl: `data:${mime};base64,${(await fs.promises.readFile(file)).toString("base64")}`,
      name: path.basename(file),
    });
  });
  ipcMain.handle("novels:open", (_, id) =>
    ok({
      novel: get("SELECT * FROM novels WHERE id=?", id),
      volumes: all(
        "SELECT * FROM volumes WHERE novel_id=? AND deleted_at IS NULL ORDER BY sort_order",
        id,
      ),
      // 章节列表只回传元数据：全书正文不进入渲染进程，单章全文按需通过 chapters:get 获取
      chapters: all(
        `SELECT id,novel_id,volume_id,title,word_count,status,sort_order,revision,
                cursor_pos,scroll_pos,summary,summary_revision,summary_updated_at,
                created_at,updated_at,data_version
         FROM chapters WHERE novel_id=? AND deleted_at IS NULL
         ORDER BY CASE WHEN volume_id IS NULL THEN 0 ELSE 1 END, sort_order`,
        id,
      ),
    }),
  );

  ipcMain.handle("chapters:get", (_, id) =>
    ok(
      get(
        "SELECT * FROM chapters WHERE id=? AND deleted_at IS NULL",
        id,
      ),
    ),
  );

  ipcMain.handle("characters:presence", (_, p) => {
    const novelId = String(p?.novelId || "");
    const includeMatches = Boolean(p?.includeMatches);
    const characters: any[] = all(
      "SELECT id,title,content_json FROM library_items WHERE novel_id=? AND kind='character' AND deleted_at IS NULL ORDER BY sort_order,title,id",
      novelId,
    ).map((row: any) => {
      let data: any = {};
      try { data = JSON.parse(row.content_json || "{}"); } catch {}
      const aliases = Array.isArray(data.alias)
        ? data.alias
        : String(data.alias || "").split(/[,，、;；]+/);
      const terms = [...new Map([row.title, ...aliases]
        .map((term: unknown) => String(term || "").trim())
        .filter((term: string) => term.length >= 2)
        .map((term: string) => [term.toLocaleLowerCase(), term])).values()];
      return { id: row.id, title: row.title, terms };
    });
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(characters.map(({ id, terms }) => [id, terms])))
      .digest("hex");
    const chapters: any[] = all(
      `SELECT c.id,c.title,c.data_version,c.sort_order,v.sort_order volume_sort_order FROM chapters c
       LEFT JOIN volumes v ON v.id=c.volume_id
       WHERE c.novel_id=? AND c.deleted_at IS NULL
       ORDER BY COALESCE(v.sort_order,-1),c.sort_order,c.id`,
      novelId,
    );
    const indexedRows: any[] = all(
      "SELECT chapter_id,chapter_data_version,entity_fingerprint FROM chapter_mention_index WHERE novel_id=?",
      novelId,
    );
    const indexed = new Map(indexedRows.map((row) => [row.chapter_id, row]));
    const staleChapters = chapters.filter((chapter) => {
      const state: any = indexed.get(chapter.id);
      return !state || Number(state.chapter_data_version) !== Number(chapter.data_version) || state.entity_fingerprint !== fingerprint;
    });
    if (staleChapters.length) {
      const clearChapter = db.prepare("DELETE FROM character_chapter_mentions WHERE chapter_id=?");
      const addMention = db.prepare("INSERT INTO character_chapter_mentions(novel_id,character_id,chapter_id,mention_count,first_offset,matched_terms_json) VALUES(?,?,?,?,?,?)");
      const saveState = db.prepare("INSERT INTO chapter_mention_index(chapter_id,novel_id,chapter_data_version,entity_fingerprint,indexed_at) VALUES(?,?,?,?,?) ON CONFLICT(chapter_id) DO UPDATE SET novel_id=excluded.novel_id,chapter_data_version=excluded.chapter_data_version,entity_fingerprint=excluded.entity_fingerprint,indexed_at=excluded.indexed_at");
      db.transaction(() => {
        for (const chapter of staleChapters) {
          const body: any = get("SELECT plain_text FROM chapters WHERE id=? AND deleted_at IS NULL", chapter.id);
          const text = String(body?.plain_text || "");
          clearChapter.run(chapter.id);
          for (const character of characters) {
            let count = 0;
            let firstOffset = -1;
            const matchedTerms = new Set<string>();
            const termByLower = new Map<string, string>(character.terms.map((term: string) => [term.toLocaleLowerCase(), term]));
            const alternatives = character.terms
              .slice()
              .sort((left: string, right: string) => right.length - left.length)
              .map((term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            const matcher = alternatives.length ? new RegExp(`(?:${alternatives.join("|")})`, "gi") : null;
            let match: RegExpExecArray | null;
            while (matcher && (match = matcher.exec(text)) !== null) {
              if (firstOffset < 0) firstOffset = match.index;
              count++;
              const matchedTerm = termByLower.get(match[0].toLocaleLowerCase());
              if (matchedTerm) matchedTerms.add(matchedTerm);
              if (match[0].length === 0) matcher.lastIndex++;
            }
            if (count) addMention.run(novelId, character.id, chapter.id, count, firstOffset, JSON.stringify([...matchedTerms]));
          }
          saveState.run(chapter.id, novelId, Number(chapter.data_version), fingerprint, timestamp());
        }
      })();
    }
    const presence: Record<
      string,
      { appearances: number; sinceLast: number; mentions: number; matches?: any[] }
    > = {};
    const summaryRows: any[] = all(
      `WITH chapter_order AS (
         SELECT c.id,ROW_NUMBER() OVER (ORDER BY COALESCE(v.sort_order,-1),c.sort_order,c.id)-1 AS chapter_index
         FROM chapters c LEFT JOIN volumes v ON v.id=c.volume_id
         WHERE c.novel_id=? AND c.deleted_at IS NULL
       )
       SELECT m.character_id,COUNT(*) appearances,SUM(m.mention_count) mentions,MAX(o.chapter_index) last_index
       FROM character_chapter_mentions m JOIN chapter_order o ON o.id=m.chapter_id
       WHERE m.novel_id=? GROUP BY m.character_id`,
      novelId,
      novelId,
    );
    const summaryByCharacter = new Map(summaryRows.map((row) => [row.character_id, row]));
    const selectedCharacterId = includeMatches ? String(p?.characterId || "") : "";
    for (const character of characters) {
      if (includeMatches && character.id !== selectedCharacterId) continue;
      const summary: any = summaryByCharacter.get(character.id);
      const appearances = Number(summary?.appearances || 0);
      const value = {
        appearances,
        mentions: Number(summary?.mentions || 0),
        sinceLast: summary ? chapters.length - 1 - Number(summary.last_index) : chapters.length,
      };
      if (includeMatches) {
        const rows: any[] = all(
          `SELECT m.chapter_id,m.mention_count,m.first_offset,m.matched_terms_json,c.title chapter_title,c.plain_text
           FROM character_chapter_mentions m JOIN chapters c ON c.id=m.chapter_id
           LEFT JOIN volumes v ON v.id=c.volume_id
           WHERE m.novel_id=? AND m.character_id=? AND c.deleted_at IS NULL
           ORDER BY COALESCE(v.sort_order,-1) DESC,c.sort_order DESC,c.id DESC LIMIT 200`,
          novelId,
          character.id,
        ).reverse();
        (value as any).matches = rows.map((row) => {
          let matchedTerms: string[] = [];
          try { matchedTerms = JSON.parse(row.matched_terms_json || "[]"); } catch {}
          const text = String(row.plain_text || "");
          const offset = Math.max(0, Number(row.first_offset) || 0);
          const start = Math.max(0, offset - 42);
          const end = Math.min(text.length, offset + 82);
          return {
            chapterId: row.chapter_id,
            chapterTitle: row.chapter_title,
            mentions: Number(row.mention_count || 0),
            matchedTerms,
            snippet: `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`,
          };
        });
      }
      presence[character.id] = value;
    }
    return ok({ presence, total: chapters.length });
  });

  ipcMain.handle("volumes:create", (_, p) => {
    const id = newId(),
      t = timestamp(),
      n = (
        get(
          "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM volumes WHERE novel_id=?",
          p.novelId,
        ) as any
      ).n;
    db.prepare(
      "INSERT INTO volumes(id,novel_id,title,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(id, p.novelId, p.title || "新建卷", n, t, t);
    return ok({ id });
  });
  ipcMain.handle("volumes:update", (_, p) => {
    db.prepare(
      "UPDATE volumes SET title=?,updated_at=?,data_version=data_version+1 WHERE id=?",
    ).run(p.title, timestamp(), p.id);
    return ok(true);
  });
  ipcMain.handle("volumes:trash", (_, id) =>
    db.transaction(() => {
      const t = timestamp();
      db.prepare("UPDATE volumes SET deleted_at=?,updated_at=? WHERE id=?").run(
        t,
        t,
        id,
      );
      db.prepare(
        "UPDATE chapters SET deleted_at=?,updated_at=? WHERE volume_id=?",
      ).run(t, t, id);
      return ok(true);
    })(),
  );
  ipcMain.handle("chapters:create", (_, p) => {
    const id = newId(),
      t = timestamp(),
      n = (
        get(
          "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM chapters WHERE novel_id=? AND (volume_id IS ? OR volume_id=?)",
          p.novelId,
          p.volumeId || null,
          p.volumeId || null,
        ) as any
      ).n;
    db.prepare(
      "INSERT INTO chapters(id,novel_id,volume_id,title,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(id, p.novelId, p.volumeId || null, p.title || "新建章节", n, t, t);
    return ok({ id });
  });
  ipcMain.handle("chapters:updateMeta", (_, p) => {
    const fields = ["title", "status", "volume_id", "sort_order"];
    const set = fields.filter((k) => k in p).map((k) => `${k}=@${k}`);
    db.prepare(
      `UPDATE chapters SET ${set.join(",")},updated_at=@updated_at,data_version=data_version+1 WHERE id=@id`,
    ).run({ ...p, updated_at: timestamp() });
    return ok(true);
  });
  ipcMain.handle("chapters:reorder", (_, p) =>
    db.transaction(() => {
      const t = timestamp();
      p.items.forEach((x: any, i: number) =>
        db
          .prepare(
            "UPDATE chapters SET volume_id=?,sort_order=?,updated_at=? WHERE id=?",
          )
          .run(x.volumeId || null, i, t, x.id),
      );
      return ok(true);
    })(),
  );
  ipcMain.handle("chapters:duplicate", (_, id) => {
    const c: any = get("SELECT * FROM chapters WHERE id=?", id);
    const nid = newId(),
      t = timestamp();
    db.prepare(
      `INSERT INTO chapters(id,novel_id,volume_id,title,content_json,plain_text,word_count,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      nid,
      c.novel_id,
      c.volume_id,
      c.title + " 副本",
      c.content_json,
      c.plain_text,
      c.word_count,
      c.status,
      c.sort_order + 1,
      t,
      t,
    );
    return ok({ id: nid });
  });
  ipcMain.handle("chapters:trash", (_, id) => {
    const t = timestamp();
    db.prepare("UPDATE chapters SET deleted_at=?,updated_at=? WHERE id=?").run(
      t,
      t,
      id,
    );
    return ok(true);
  });
  ipcMain.handle("chapters:batchMove", (_, p) =>
    db.transaction(() => {
      const ids: string[] = (p?.ids || []).filter(Boolean);
      if (!ids.length) return ok(0);
      const first: any = get(
        "SELECT novel_id FROM chapters WHERE id=?",
        ids[0],
      );
      if (!first) return fail("章节不存在");
      const t = timestamp();
      let n = (
        get(
          "SELECT COALESCE(MAX(sort_order),-1) n FROM chapters WHERE novel_id=? AND volume_id IS ? AND deleted_at IS NULL",
          first.novel_id,
          p.volumeId || null,
        ) as any
      ).n;
      for (const id of ids) {
        n += 1;
        db.prepare(
          "UPDATE chapters SET volume_id=?,sort_order=?,updated_at=?,data_version=data_version+1 WHERE id=?",
        ).run(p.volumeId || null, n, t, id);
      }
      return ok(ids.length);
    })(),
  );
  ipcMain.handle("chapters:batchTrash", (_, p) => {
    const ids: string[] = (p?.ids || []).filter(Boolean);
    if (!ids.length) return ok(0);
    const t = timestamp();
    const ph = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE chapters SET deleted_at=?,updated_at=? WHERE id IN (${ph})`,
    ).run(t, t, ...ids);
    return ok(ids.length);
  });
  ipcMain.handle("chapters:save", (_, p) => {
    try {
      return db.transaction(() => {
        const c: any = get(
          "SELECT revision,word_count FROM chapters WHERE id=? AND deleted_at IS NULL",
          p.id,
        );
        if (!c) throw new Error("章节不存在或已删除");
        if (c.revision !== p.baseRevision)
          return {
            ok: false,
            conflict: true,
            error: "正文已在其他位置更新，请重新加载后再保存",
          };
        const wc = countText(p.plainText, p.countPunctuation !== false);
        const rev = c.revision + 1,
          t = timestamp(),
          json = JSON.stringify(p.content);
        db.prepare(
          `UPDATE chapters SET content_json=?,plain_text=?,word_count=?,revision=?,cursor_pos=?,scroll_pos=?,updated_at=?,data_version=data_version+1 WHERE id=?`,
        ).run(
          json,
          p.plainText,
          wc,
          rev,
          p.cursorPos || 0,
          p.scrollPos || 0,
          t,
          p.id,
        );
        db.prepare(
          "UPDATE novels SET updated_at=?,last_chapter_id=?,data_version=data_version+1 WHERE id=(SELECT novel_id FROM chapters WHERE id=?)",
        ).run(t, p.id, p.id);
        const delta = wc - c.word_count;
        if (delta)
          db.prepare("INSERT INTO writing_activity VALUES(?,?,?,?,?,?,1)").run(
            newId(),
            (get("SELECT novel_id FROM chapters WHERE id=?", p.id) as any)
              .novel_id,
            p.id,
            localDate(),
            delta,
            t,
          );
        const last: any = get(
          "SELECT created_at FROM chapter_revisions WHERE chapter_id=? ORDER BY created_at DESC LIMIT 1",
          p.id,
        );
        if (
          !last ||
          Date.now() - new Date(last.created_at).getTime() > 15 * 60 * 1000
        )
          db.prepare(
            "INSERT INTO chapter_revisions VALUES(?,?,?,?,?,?,?,1)",
          ).run(newId(), p.id, json, p.plainText, wc, "auto", t);
        pruneRevisions(p.id);
        return ok({ revision: rev, wordCount: wc, updatedAt: t });
      })();
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("writing:today", (_, novelId) => {
    const row = novelId
      ? get(
          "SELECT COALESCE(SUM(delta),0) total FROM writing_activity WHERE novel_id=? AND date=?",
          novelId,
          localDate(),
        )
      : get(
          "SELECT COALESCE(SUM(delta),0) total FROM writing_activity WHERE date=?",
          localDate(),
        );
    return ok((row as any)?.total || 0);
  });
  ipcMain.handle("writing:stats", (_, p) => {
    const days = Math.max(1, Math.min(365, Number(p?.days) || 14));
    const novelId = p?.novelId ? String(p.novelId) : "";
    const end = new Date();
    end.setHours(12, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    const startKey = localDate(start);
    const endKey = localDate(end);
    const rows: any[] = novelId
      ? all(
          "SELECT date, COALESCE(SUM(delta),0) total FROM writing_activity WHERE novel_id=? AND date>=? AND date<=? GROUP BY date ORDER BY date ASC",
          novelId,
          startKey,
          endKey,
        )
      : all(
          "SELECT date, COALESCE(SUM(delta),0) total FROM writing_activity WHERE date>=? AND date<=? GROUP BY date ORDER BY date ASC",
          startKey,
          endKey,
        );
    const by = new Map<string, number>();
    for (const row of rows) by.set(String(row.date), Number(row.total) || 0);
    const filled: { date: string; total: number }[] = [];
    const cursor = new Date(start);
    for (let i = 0; i < days; i++) {
      const key = localDate(cursor);
      filled.push({ date: key, total: by.get(key) || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    return ok({
      start: startKey,
      end: endKey,
      days,
      novelId: novelId || null,
      rows: filled,
    });
  });

  ipcMain.handle("writing:focusPing", (event, p) => {
    try {
      // 仅接受主窗口信号
      if (win && event.sender !== win.webContents) return ok(false);
      if (!win || win.isDestroyed() || !win.isVisible() || !win.isFocused())
        return ok(false);
      const novelId = String(p?.novelId || "");
      const chapterId = p?.chapterId ? String(p.chapterId) : null;
      if (!novelId) return ok(false);
      const novel = get("SELECT id FROM novels WHERE id=? AND deleted_at IS NULL", novelId);
      if (!novel) return ok(false);
      if (chapterId) {
        const ch = get(
          "SELECT id FROM chapters WHERE id=? AND deleted_at IS NULL",
          chapterId,
        );
        if (!ch) return ok(false);
      }
      focusTracker.ping(novelId, chapterId);
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("writing:focusEnd", () => {
    try {
      focusTracker.end();
      return ok(true);
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("writing:overview", (_, p) => {
    try {
      const novelId = p?.novelId ? String(p.novelId) : "";
      const year = Number(p?.year) || new Date().getFullYear();
      const wordRow = novelId
        ? (get(
            "SELECT COALESCE(SUM(word_count),0) total FROM chapters WHERE novel_id=? AND deleted_at IS NULL",
            novelId,
          ) as any)
        : (get(
            "SELECT COALESCE(SUM(word_count),0) total FROM chapters WHERE deleted_at IS NULL",
          ) as any);
      const netRows: any[] = novelId
        ? all(
            "SELECT date, COALESCE(SUM(delta),0) total FROM writing_activity WHERE novel_id=? GROUP BY date",
            novelId,
          )
        : all(
            "SELECT date, COALESCE(SUM(delta),0) total FROM writing_activity GROUP BY date",
          );
      const focusRows: any[] = novelId
        ? all(
            "SELECT date, COALESCE(SUM(duration_ms),0) ms FROM writing_focus_sessions WHERE novel_id=? GROUP BY date",
            novelId,
          )
        : all(
            "SELECT date, COALESCE(SUM(duration_ms),0) ms FROM writing_focus_sessions GROUP BY date",
          );
      // 最长单次：按逻辑会话汇总（跨午夜不截断）
      const maxSessionRow: any = get(
        novelId
          ? `SELECT COALESCE(MAX(total_ms),0) max_ms FROM (
               SELECT SUM(duration_ms) total_ms FROM writing_focus_sessions
               WHERE novel_id=? AND logical_id!='' GROUP BY logical_id
             )`
          : `SELECT COALESCE(MAX(total_ms),0) max_ms FROM (
               SELECT SUM(duration_ms) total_ms FROM writing_focus_sessions
               WHERE logical_id!='' GROUP BY logical_id
             )`,
        ...(novelId ? [novelId] : []),
      );
      let totalNet = 0;
      let maxDayNet = 0;
      const netBy = new Map<string, number>();
      for (const r of netRows) {
        const v = Number(r.total) || 0;
        netBy.set(String(r.date), v);
        totalNet += v;
        if (v > maxDayNet) maxDayNet = v;
      }
      let totalFocusMs = 0;
      const focusBy = new Map<string, number>();
      const focusDay = new Set<string>();
      for (const r of focusRows) {
        const ms = Number(r.ms) || 0;
        focusBy.set(String(r.date), ms);
        if (ms > 0) focusDay.add(String(r.date));
        totalFocusMs += ms;
      }
      const maxSessionMs = Number(maxSessionRow?.max_ms) || 0;
      // 连续有效写作天（有 focus 记录）
      const sortedDays = [...focusDay].sort();
      let longestStreak = 0;
      let streakRun = 0;
      let prev: string | null = null;
      for (const d of sortedDays) {
        if (prev) {
          const a = new Date(prev + "T12:00:00");
          const b = new Date(d + "T12:00:00");
          const diff = Math.round((b.getTime() - a.getTime()) / 86400000);
          streakRun = diff === 1 ? streakRun + 1 : 1;
        } else streakRun = 1;
        if (streakRun > longestStreak) longestStreak = streakRun;
        prev = d;
      }
      const today = localDate();
      let currentStreak = 0;
      if (focusDay.has(today)) {
        let cur = new Date(today + "T12:00:00");
        while (focusDay.has(localDate(cur))) {
          currentStreak++;
          cur.setDate(cur.getDate() - 1);
        }
      } else {
        const y = new Date();
        y.setDate(y.getDate() - 1);
        const yKey = localDate(y);
        if (focusDay.has(yKey)) {
          let cur = new Date(yKey + "T12:00:00");
          while (focusDay.has(localDate(cur))) {
            currentStreak++;
            cur.setDate(cur.getDate() - 1);
          }
        }
      }
      // 年度/近 12 月网格
      const end = new Date(year, 11, 31);
      const start = new Date(year, 0, 1);
      const cells: any[] = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = localDate(new Date(d));
        cells.push({
          date: key,
          net: netBy.get(key) || 0,
          focusMs: focusBy.get(key) || 0,
          hasTimer: focusBy.has(key),
          hasNet: netBy.has(key),
        });
      }
      return ok({
        scope: novelId || null,
        year,
        wordCount: Number(wordRow?.total) || 0,
        totalNet,
        maxDayNet,
        totalFocusMs,
        maxSessionMs,
        currentStreak,
        longestStreak,
        focusDaysTracked: focusDay.size,
        timerAvailable: focusDay.size > 0,
        cells,
      });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle("writing:dayDetail", (_, p) => {
    try {
      const date = String(p?.date || "");
      const novelId = p?.novelId ? String(p.novelId) : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("无效日期");
      const nets: any[] = novelId
        ? all(
            "SELECT novel_id, chapter_id, COALESCE(SUM(delta),0) net FROM writing_activity WHERE date=? AND novel_id=? GROUP BY novel_id, chapter_id",
            date,
            novelId,
          )
        : all(
            "SELECT novel_id, chapter_id, COALESCE(SUM(delta),0) net FROM writing_activity WHERE date=? GROUP BY novel_id, chapter_id",
            date,
          );
      const focus: any[] = novelId
        ? all(
            "SELECT novel_id, chapter_id, COALESCE(SUM(duration_ms),0) ms FROM writing_focus_sessions WHERE date=? AND novel_id=? GROUP BY novel_id, chapter_id",
            date,
            novelId,
          )
        : all(
            "SELECT novel_id, chapter_id, COALESCE(SUM(duration_ms),0) ms FROM writing_focus_sessions WHERE date=? GROUP BY novel_id, chapter_id",
            date,
          );
      const chapters = new Map<
        string,
        { novelId: string; chapterId: string | null; net: number; focusMs: number; title: string; novelTitle: string; exists: boolean }
      >();
      for (const r of nets) {
        const key = `${r.novel_id}|${r.chapter_id || ""}`;
        chapters.set(key, {
          novelId: r.novel_id,
          chapterId: r.chapter_id,
          net: Number(r.net) || 0,
          focusMs: 0,
          title: r.chapter_id
            ? String(
                (get("SELECT title FROM chapters WHERE id=?", r.chapter_id) as any)?.title ||
                  trMissing(),
              )
            : "",
          novelTitle: String(
            (get("SELECT title FROM novels WHERE id=?", r.novel_id) as any)?.title || "",
          ),
          exists: r.chapter_id
            ? Boolean(
                get(
                  "SELECT id FROM chapters WHERE id=? AND deleted_at IS NULL",
                  r.chapter_id,
                ),
              )
            : true,
        });
      }
      for (const r of focus) {
        const key = `${r.novel_id}|${r.chapter_id || ""}`;
        const prev = chapters.get(key);
        if (prev) prev.focusMs = Number(r.ms) || 0;
        else
          chapters.set(key, {
            novelId: r.novel_id,
            chapterId: r.chapter_id,
            net: 0,
            focusMs: Number(r.ms) || 0,
            title: r.chapter_id
              ? String(
                  (get("SELECT title FROM chapters WHERE id=?", r.chapter_id) as any)
                    ?.title || "",
                )
              : "",
            novelTitle: String(
              (get("SELECT title FROM novels WHERE id=?", r.novel_id) as any)?.title ||
                "",
            ),
            exists: r.chapter_id
              ? Boolean(
                  get(
                    "SELECT id FROM chapters WHERE id=? AND deleted_at IS NULL",
                    r.chapter_id,
                  ),
                )
              : true,
          });
      }
      function trMissing() {
        return "";
      }
      return ok({ date, rows: [...chapters.values()] });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle("search:cancel", (_, requestId) => {
    const task = searchTasks.get(String(requestId || ""));
    if (task) task.cancelled = true;
    return ok(true);
  });
  ipcMain.handle("search:novel", async (event, p) => {
    const query = String(p?.query || "").trim();
    if (!query) return ok({ results: [], cancelled: false });
    const requestId = String(p?.requestId || randomUUID());
    const task = { cancelled: false };
    searchTasks.set(requestId, task);
    const lower = query.toLowerCase();
    const out: any[] = [];
    const total = Number(
      (get(
        "SELECT COUNT(*) total FROM chapters WHERE novel_id=? AND deleted_at IS NULL",
        p.novelId,
      ) as any)?.total || 0,
    );
    let scanned = 0;
    let cursorSort: number | null = null;
    let cursorId = "";
    try {
      while (scanned < total && !task.cancelled) {
        const rows: any[] = cursorSort === null
          ? all(
              "SELECT id,title,plain_text,sort_order FROM chapters WHERE novel_id=? AND deleted_at IS NULL ORDER BY sort_order,id LIMIT 24",
              p.novelId,
            )
          : all(
              "SELECT id,title,plain_text,sort_order FROM chapters WHERE novel_id=? AND deleted_at IS NULL AND (sort_order>? OR (sort_order=? AND id>?)) ORDER BY sort_order,id LIMIT 24",
              p.novelId,
              cursorSort,
              cursorSort,
              cursorId,
            );
        if (!rows.length) break;
        for (const r of rows) {
          const text = r.plain_text || "";
          const hay = text.toLowerCase();
          let idx = hay.indexOf(lower);
          if (idx === -1) continue;
          let count = 0;
          while (idx !== -1) {
            count++;
            idx = hay.indexOf(lower, idx + lower.length);
          }
          const first = hay.indexOf(lower);
          const start = Math.max(0, first - 24);
          out.push({
            chapterId: r.id,
            title: r.title,
            count,
            snippet:
              (start > 0 ? "…" : "") +
              text.slice(start, first + query.length + 48) +
              (first + query.length + 48 < text.length ? "…" : ""),
          });
        }
        scanned += rows.length;
        const cursor = rows[rows.length - 1];
        cursorSort = Number(cursor.sort_order);
        cursorId = String(cursor.id);
        event.sender.send("search:progress", {
          requestId,
          scanned,
          total,
          matches: out.length,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return ok({ results: out, cancelled: task.cancelled });
    } finally {
      if (searchTasks.get(requestId) === task) searchTasks.delete(requestId);
    }
  });

  ipcMain.handle("revisions:list", (_, id) =>
    ok(
      all(
        "SELECT id,chapter_id,word_count,source,created_at FROM chapter_revisions WHERE chapter_id=? ORDER BY created_at DESC LIMIT 100",
        id,
      ),
    ),
  );
  ipcMain.handle("revisions:create", (_, p) => {
    const c: any = get("SELECT * FROM chapters WHERE id=?", p.chapterId);
    if (!c) return fail("章节不存在");
    db.prepare("INSERT INTO chapter_revisions VALUES(?,?,?,?,?,?,?,1)").run(
      newId(),
      c.id,
      c.content_json,
      c.plain_text,
      c.word_count,
      p.source || "manual",
      timestamp(),
    );
    pruneRevisions(c.id);
    return ok(true);
  });
  ipcMain.handle("revisions:preview", (_, id) =>
    ok(get("SELECT * FROM chapter_revisions WHERE id=?", id)),
  );
  ipcMain.handle("revisions:restore", (_, id) => {
    const r: any = get("SELECT * FROM chapter_revisions WHERE id=?", id);
    if (!r) return fail("历史版本不存在");
    return db.transaction(() => {
      const c: any = get("SELECT * FROM chapters WHERE id=?", r.chapter_id);
      db.prepare("INSERT INTO chapter_revisions VALUES(?,?,?,?,?,?,?,1)").run(
        newId(),
        c.id,
        c.content_json,
        c.plain_text,
        c.word_count,
        "before_restore",
        timestamp(),
      );
      db.prepare(
        "UPDATE chapters SET content_json=?,plain_text=?,word_count=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(r.content_json, r.plain_text, r.word_count, timestamp(), c.id);
      return ok(true);
    })();
  });

  ipcMain.handle("library:list", (_, p) =>
    ok(
      all(
        `SELECT * FROM library_items WHERE novel_id=? AND kind=? AND deleted_at IS NULL AND (title LIKE ? OR content_json LIKE ? OR tags_json LIKE ?) ORDER BY sort_order,updated_at DESC`,
        p.novelId,
        p.kind,
        `%${p.search || ""}%`,
        `%${p.search || ""}%`,
        `%${p.search || ""}%`,
      ),
    ),
  );
  ipcMain.handle("library:listAll", (_, novelId) =>
    ok(
      all(
        "SELECT * FROM library_items WHERE novel_id=? AND deleted_at IS NULL ORDER BY kind,sort_order,updated_at DESC",
        novelId,
      ),
    ),
  );
  ipcMain.handle("library:save", (_, p) => {
    const t = timestamp();
    if (p.id) {
      db.prepare(
        "UPDATE library_items SET title=?,content_json=?,tags_json=?,status=?,chapter_id=?,updated_at=?,data_version=data_version+1 WHERE id=?",
      ).run(
        p.title,
        JSON.stringify(p.content || {}),
        JSON.stringify(p.tags || []),
        p.status || "idea",
        p.chapterId || null,
        t,
        p.id,
      );
      return ok({ id: p.id });
    }
    const id = newId();
    const sceneOrder = p.kind === "scene"
      ? Number((get("SELECT COALESCE(MAX(sort_order),-1)+1 n FROM library_items WHERE novel_id=? AND kind='scene' AND deleted_at IS NULL", p.novelId) as any)?.n || 0)
      : 0;
    db.prepare(
      "INSERT INTO library_items(id,novel_id,kind,title,content_json,tags_json,status,chapter_id,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      p.novelId,
      p.kind,
      p.title,
      JSON.stringify(p.content || {}),
      JSON.stringify(p.tags || []),
      p.status || "idea",
      p.chapterId || null,
      sceneOrder,
      t,
      t,
    );
    return ok({ id });
  });
  ipcMain.handle("library:reorderScenes", (_, p) => {
    const novelId = String(p?.novelId || "");
    const items: Array<{ id: string; chapterId: string | null; sortOrder: number }> = Array.isArray(p?.items) ? p.items : [];
    if (!novelId || !items.length) return fail("没有可保存的场景顺序");
    const ids = new Set<string>();
    for (const item of items) {
      if (!item?.id || ids.has(item.id)) return fail("场景列表包含无效或重复项目");
      ids.add(item.id);
      const scene = get("SELECT id FROM library_items WHERE id=? AND novel_id=? AND kind='scene' AND deleted_at IS NULL", item.id, novelId);
      if (!scene) return fail("场景已被删除或不属于当前作品，请刷新后重试");
      if (item.chapterId) {
        const chapter = get("SELECT id FROM chapters WHERE id=? AND novel_id=? AND deleted_at IS NULL", item.chapterId, novelId);
        if (!chapter) return fail("目标章节不存在或不属于当前作品");
      }
    }
    return db.transaction(() => {
      const update = db.prepare("UPDATE library_items SET chapter_id=?,sort_order=?,updated_at=?,data_version=data_version+1 WHERE id=? AND novel_id=? AND kind='scene'");
      const t = timestamp();
      items.forEach((item, index) => update.run(item.chapterId || null, Number.isFinite(item.sortOrder) ? item.sortOrder : index, t, item.id, novelId));
      return ok(true);
    })();
  });
  ipcMain.handle("library:trash", (_, id) => {
    db.prepare(
      "UPDATE library_items SET deleted_at=?,updated_at=? WHERE id=?",
    ).run(timestamp(), timestamp(), id);
    return ok(true);
  });
  ipcMain.handle("trash:list", (_, novelId) =>
    ok({
      chapters: all(
        "SELECT * FROM chapters WHERE novel_id=? AND deleted_at IS NOT NULL",
        novelId,
      ),
      volumes: all(
        "SELECT * FROM volumes WHERE novel_id=? AND deleted_at IS NOT NULL",
        novelId,
      ),
      library: all(
        "SELECT * FROM library_items WHERE novel_id=? AND deleted_at IS NOT NULL",
        novelId,
      ),
    }),
  );
  ipcMain.handle("trash:restore", (_, p) => {
    const table: { [k: string]: string } = {
      chapter: "chapters",
      volume: "volumes",
      library: "library_items",
      novel: "novels",
    };
    if (!table[p.kind]) return fail("未知类型");
    db.prepare(
      `UPDATE ${table[p.kind]} SET deleted_at=NULL,updated_at=? WHERE id=?`,
    ).run(timestamp(), p.id);
    return ok(true);
  });
  ipcMain.handle("trash:purge", (_, p) => {
    const table: { [k: string]: string } = {
      chapter: "chapters",
      volume: "volumes",
      library: "library_items",
      novel: "novels",
    };
    if (!table[p.kind] || !["永久删除", "DELETE"].includes(p.confirm))
      return fail("确认文字不正确");
    db.prepare(
      `DELETE FROM ${table[p.kind]} WHERE id=? AND deleted_at IS NOT NULL`,
    ).run(p.id);
    return ok(true);
  });

  ipcMain.handle("connections:list", () => ok([serverConnection()]));
  ipcMain.handle("connections:save", (_, p) => {
    try {
      if (!p || typeof p !== "object") throw new Error("连接配置无效");
      if (String(p.id || "") !== ZHUWEN_SERVER_CONNECTION_ID)
        throw new Error("铸文商用版仅支持内置 AI 服务");
      if (!String(p.name || "").trim()) throw new Error("请填写连接名称");
      const temperature = Number(p.temperature);
      const maxTokens = Number(p.maxTokens);
      const timeoutMs = Number(p.timeoutMs);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
        throw new Error("随机程度必须在 0 到 2 之间");
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 200000)
        throw new Error("最大输出 tokens 必须是 1 到 200000 的整数");
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
        throw new Error("超时必须在 1000 到 600000 毫秒之间");
      const t = timestamp(), id = ZHUWEN_SERVER_CONNECTION_ID;
      const reasoningEffort = ["", "low", "medium", "high"].includes(
        String(p.reasoningEffort || ""),
      )
        ? String(p.reasoningEffort || "")
        : "";
      db.prepare(
        `INSERT INTO api_connections(id,name,base_url,model,temperature,max_tokens,timeout_ms,streaming,reasoning_effort,created_at,updated_at) VALUES(@id,@name,@baseUrl,@model,@temperature,@maxTokens,@timeoutMs,@streaming,@reasoningEffort,@t,@t) ON CONFLICT(id) DO UPDATE SET name=@name,base_url=@baseUrl,model=@model,temperature=@temperature,max_tokens=@maxTokens,timeout_ms=@timeoutMs,streaming=@streaming,reasoning_effort=@reasoningEffort,updated_at=@t,data_version=data_version+1`,
      ).run({
        id,
        name: "铸文 AI",
        baseUrl: ZHUWEN_SERVER_BASE_URL,
        model: ZHUWEN_SERVER_MODEL,
        temperature,
        maxTokens,
        timeoutMs,
        streaming: p.streaming ? 1 : 0,
        reasoningEffort,
        t,
      });
      return ok({ id });
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("connections:test", async (_, id) => {
    try {
      if (id !== ZHUWEN_SERVER_CONNECTION_ID) throw new Error("连接不存在");
      const c: any = serverConnection();
      await chatRequest(
        c,
        requireServerToken(),
        [{ role: "user", content: "请只回复：连接成功" }],
        false,
        new AbortController(),
        () => {},
      );
      return ok(true);
    } catch (e) {
      return fail(classifyError(e));
    }
  });
  ipcMain.handle("connections:models", async (_, p) => {
    try {
      if (p?.connectionId === ZHUWEN_SERVER_CONNECTION_ID || String(p?.baseUrl || "").includes("118.31.220.154:8100"))
        return ok([ZHUWEN_SERVER_MODEL]);
      const base = String(p?.baseUrl || "");
      validateBaseUrl(base);
      const key =
        String(p?.apiKey || "") ||
        (p?.connectionId ? readSecret(userDir, p.connectionId) : "");
      if (!key) throw new Error("缺少 API Key，请先填写或保存连接");
      const res = await fetch(`${base.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const e: any = new Error((await res.text()).slice(0, 300) || res.statusText);
        e.status = res.status;
        throw e;
      }
      const j: any = await res.json();
      const ids: string[] = (j?.data || [])
        .map((m: any) => String(m?.id || ""))
        .filter(Boolean);
      if (!ids.length) throw new Error("服务未返回任何模型");
      return ok(ids);
    } catch (e) {
      return fail(classifyError(e));
    }
  });
  ipcMain.handle("prompts:list", () =>
    ok(all("SELECT * FROM prompt_templates ORDER BY builtin DESC,created_at")),
  );  ipcMain.handle("prompts:save", (_, p) => {
    const t = timestamp(),
      id = p.id || newId();
    db.prepare(
      `INSERT INTO prompt_templates(id,name,content,builtin,created_at,updated_at) VALUES(?,?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,content=excluded.content,updated_at=excluded.updated_at,data_version=data_version+1`,
    ).run(id, p.name, p.content, t, t);
    return ok({ id });
  });
  ipcMain.handle("prompts:delete", (_, id) => {
    const row: any = get("SELECT builtin FROM prompt_templates WHERE id=?", id);
    if (!row) return fail("模板不存在");
    if (row.builtin) return fail("内置模板不能删除");
    db.prepare("DELETE FROM prompt_templates WHERE id=?").run(id);
    return ok(true);
  });
  ipcMain.handle("prompts:restoreDefaults", () => {
    const t = timestamp();
    const ins = db.prepare(
      `INSERT INTO prompt_templates(id,name,content,builtin,created_at,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT(name) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,data_version=data_version+1`,
    );
    db.transaction(() => {
      for (const [name, content] of builtinPrompts)
        ins.run(newId(), name, content, t, t);
      return ok(true);
    })();
  });
  ipcMain.handle("ai:styles:list", () =>
    ok(
      all("SELECT * FROM ai_style_cards ORDER BY builtin DESC, created_at").map((row: any) => {
        let tasks: string[] = [];
        try { tasks = JSON.parse(row.tasks_json || "[]"); } catch {}
        const card = { ...row, tasks, version: Number(row.builtin_version || 1) };
        return { ...card, rules: effectiveStyleRules(card) };
      }),
    ),
  );
  ipcMain.handle("ai:style-selection:get", (_, novelId) => {
    const row: any = get(
      "SELECT style_id,style_ids_json FROM novel_ai_styles WHERE novel_id=?",
      String(novelId || ""),
    );
    let styleIds: string[] = [];
    try { styleIds = JSON.parse(row?.style_ids_json || "[]"); } catch {}
    if (!styleIds.length && row?.style_id) styleIds = [String(row.style_id)];
    const cards = [...new Set(styleIds)].map(styleCardRow).filter(Boolean);
    return ok({ styleIds: cards.map((card: any) => card.id), cards });
  });
  ipcMain.handle("ai:style-selection:set", (_, p) => {
    const novelId = String(p?.novelId || "");
    if (!get("SELECT id FROM novels WHERE id=?", novelId)) return fail("作品不存在");
    const rawIds = Array.isArray(p?.styleIds) ? p.styleIds : p?.styleId ? [p.styleId] : [];
    const styleIds: string[] = [...new Set<string>(rawIds.map((id: unknown) => String(id || "").trim()).filter((id: string) => Boolean(id)))];
    if (styleIds.length > 6) return fail("每个作品最多组合 6 张技法卡");
    const cards = styleIds.map(styleCardRow);
    if (cards.some((card) => !card)) return fail("写作风格不存在");
    const styleId = styleIds[0] || "";
    db.prepare(
      "INSERT INTO novel_ai_styles(novel_id,style_id,updated_at,style_ids_json) VALUES(?,?,?,?) ON CONFLICT(novel_id) DO UPDATE SET style_id=excluded.style_id,style_ids_json=excluded.style_ids_json,updated_at=excluded.updated_at,data_version=data_version+1",
    ).run(novelId, styleId || null, timestamp(), JSON.stringify(styleIds));
    return ok({ styleIds, cards });
  });
  ipcMain.handle("ai:style:estimate", (_, p) => {
    const style = requestStyle(p);
    return ok({ chars: style.instruction.length, instruction: style.instruction, styleIds: style.cards.map((card: any) => card.id), styleNames: style.cards.map((card: any) => card.name), taskKind: p?.taskKind || "chat" });
  });
  ipcMain.handle("ai:style:save", (_, p) => {
    const name = String(p?.name || "").trim();
    const rules = String(p?.rules || "").trim();
    if (!name || name.length > 80) return fail("风格名称需为 1 到 80 个字符");
    if (!rules || rules.length > 20000) return fail("风格规则需为 1 到 20000 个字符");
    const id = String(p?.id || newId());
    const old: any = get("SELECT builtin FROM ai_style_cards WHERE id=?", id);
    if (old?.builtin) return fail("内置风格不能直接修改，请先复制为自定义风格");
    const t = timestamp();
    const taskOptions = new Set(["continue", "polish", "naturalize", "outline"]);
    const tasks = [...new Set((Array.isArray(p?.tasks) ? p.tasks : ["continue", "polish"])
      .map((task: unknown) => String(task || ""))
      .filter((task: string) => taskOptions.has(task)))];
    if (!tasks.length) return fail("至少为技法卡选择一种适用任务");
    db.prepare(
      "INSERT INTO ai_style_cards(id,name,description,tasks_json,rules,builtin,builtin_version,created_at,updated_at) VALUES(?,?,?,?,?,0,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,tasks_json=excluded.tasks_json,rules=excluded.rules,updated_at=excluded.updated_at,data_version=data_version+1",
    ).run(id, name, String(p?.description || "").slice(0, 240), JSON.stringify(tasks), rules, t, t);
    return ok({ id });
  });
  ipcMain.handle("ai:style:export", async (_, styleId) => {
    try {
      const card: any = get("SELECT * FROM ai_style_cards WHERE id=?", String(styleId || ""));
      if (!card) return fail("写作技法卡不存在");
      if (card.builtin) return fail("请先复制内置卡，再导出自定义卡");
      const tasks = JSON.parse(card.tasks_json || "[]");
      const safeName = String(card.name || "写作技法卡").replace(/[<>:"/\\|?*]/g, "_").slice(0, 70);
      const target = await dialog.showSaveDialog({
        title: "导出写作技法卡",
        defaultPath: `${safeName}.zhuwen-style.json`,
        filters: [{ name: "铸文写作技法卡", extensions: ["json"] }],
      });
      if (target.canceled || !target.filePath) return ok(null);
      const bundle = {
        format: "zhuwen-ai-style-card",
        version: 1,
        card: { name: card.name, description: card.description || "", tasks, rules: card.rules },
      };
      await fs.promises.writeFile(target.filePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
      return ok({ file: target.filePath });
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("ai:style:import", async () => {
    try {
      const target = await dialog.showOpenDialog({
        title: "导入写作技法卡",
        filters: [{ name: "铸文写作技法卡", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (target.canceled || !target.filePaths[0]) return ok(null);
      const file = target.filePaths[0];
      if ((await fs.promises.stat(file)).size > 128 * 1024) throw new Error("技法卡文件过大，无法导入");
      const bundle = JSON.parse(await fs.promises.readFile(file, "utf8"));
      const card = bundle?.card;
      if (bundle?.format !== "zhuwen-ai-style-card" || bundle?.version !== 1 || !card || typeof card !== "object")
        throw new Error("文件格式不受支持或版本不兼容");
      const name = String(card.name || "").trim();
      const description = String(card.description || "").trim();
      const rules = String(card.rules || "").trim();
      const allowedTasks = new Set(["continue", "polish", "naturalize", "outline"]);
      const tasks = [...new Set((Array.isArray(card.tasks) ? card.tasks : [])
        .map((task: unknown) => String(task || ""))
        .filter((task: string) => allowedTasks.has(task)))];
      if (!name || name.length > 80) throw new Error("技法卡名称需为 1 到 80 个字符");
      if (description.length > 240) throw new Error("技法卡说明不能超过 240 个字符");
      if (!rules || rules.length > 20000) throw new Error("技法卡规则需为 1 到 20000 个字符");
      if (!tasks.length) throw new Error("文件中没有有效的适用任务");
      const id = newId();
      const now = timestamp();
      db.prepare(
        "INSERT INTO ai_style_cards(id,name,description,tasks_json,rules,builtin,builtin_version,created_at,updated_at) VALUES(?,?,?,?,?,0,1,?,?)",
      ).run(id, name, description, JSON.stringify(tasks), rules, now, now);
      return ok({ id, name });
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("ai:style:delete", (_, id) => {
    const row: any = get("SELECT builtin FROM ai_style_cards WHERE id=?", String(id || ""));
    if (!row) return fail("写作风格不存在");
    if (row.builtin) return fail("内置风格不能删除");
    db.transaction(() => {
      const selections: any[] = all("SELECT novel_id,style_id,style_ids_json FROM novel_ai_styles");
      const update = db.prepare("UPDATE novel_ai_styles SET style_id=?,style_ids_json=?,updated_at=?,data_version=data_version+1 WHERE novel_id=?");
      for (const selection of selections) {
        let ids: string[] = [];
        try { ids = JSON.parse(selection.style_ids_json || "[]"); } catch {}
        if (!ids.length && selection.style_id) ids = [String(selection.style_id)];
        const remaining = ids.filter((styleId) => styleId !== String(id));
        if (remaining.length !== ids.length)
          update.run(remaining[0] || null, JSON.stringify(remaining), timestamp(), selection.novel_id);
      }
      db.prepare("DELETE FROM ai_style_cards WHERE id=?").run(id);
    })();
    return ok(true);
  });
  ipcMain.handle("ai:conversations", (_, p) => {
    const novelId = typeof p === "string" ? p : String(p?.novelId || "");
    const limit = Math.min(200, Math.max(20, Number(p?.limit) || 50));
    const offset = Math.max(0, Number(p?.offset) || 0);
    const search = String(p?.search || "").trim();
    const like = `%${search}%`;
    const rows = search
      ? all(
          `SELECT c.*,
            (SELECT substr(m.content,1,120) FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_snippet,
            (SELECT m.incomplete FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_incomplete,
            (SELECT m.role FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_role
           FROM ai_conversations c
           WHERE c.novel_id=? AND c.deleted_at IS NULL
             AND (c.title LIKE ? OR EXISTS (SELECT 1 FROM ai_messages m WHERE m.conversation_id=c.id AND m.content LIKE ?))
           ORDER BY c.updated_at DESC, c.id DESC
           LIMIT ? OFFSET ?`,
          novelId,
          like,
          like,
          limit,
          offset,
        )
      : all(
          `SELECT c.*,
            (SELECT substr(m.content,1,120) FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_snippet,
            (SELECT m.incomplete FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_incomplete,
            (SELECT m.role FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_role
           FROM ai_conversations c
           WHERE c.novel_id=? AND c.deleted_at IS NULL
           ORDER BY c.updated_at DESC, c.id DESC
           LIMIT ? OFFSET ?`,
          novelId,
          limit,
          offset,
        );
    return ok({ rows, limit, offset, novelId, hasMore: rows.length === limit });
  });
  function broadcastConversations(novelId: string) {
    if (!novelId) return;
    try {
      const rows = all(
        `SELECT c.*,
          (SELECT substr(m.content,1,120) FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_snippet,
          (SELECT m.incomplete FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_incomplete,
          (SELECT m.role FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_role
         FROM ai_conversations c
         WHERE c.novel_id=? AND c.deleted_at IS NULL
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT 50`,
        novelId,
      );
      for (const w of [win, floatWin]) {
        if (w && !w.isDestroyed())
          w.webContents.send("ai:conversations:list", { novelId, rows });
      }
    } catch {}
  }
  ipcMain.handle("ai:conversation:update", (_, p) => {
    if (!p?.title?.trim()) return fail("会话名称不能为空");
    db.prepare(
      "UPDATE ai_conversations SET title=?,updated_at=?,data_version=data_version+1 WHERE id=?",
    ).run(p.title.trim(), timestamp(), p.id);
    return ok(true);
  });
  ipcMain.handle("ai:conversation:trash", (_, id) => {
    const conv: any = get(
      "SELECT novel_id FROM ai_conversations WHERE id=?",
      id,
    );
    db.prepare(
      "UPDATE ai_conversations SET deleted_at=?,updated_at=? WHERE id=?",
    ).run(timestamp(), timestamp(), id);
    if (conv?.novel_id)
      clearConversationDraft(String(conv.novel_id), String(id));
    if (aiSession.conversationId === id) {
      // 删除正在生成的会话：停止请求
      if (aiSession.requestId) requests.get(aiSession.requestId)?.abort();
      aiSession.conversationId = "";
      aiSession.messages = [];
      aiSession.generating = false;
      aiSession.requestId = "";
      broadcastSession();
    }
    broadcastConversations(String(aiSession.novelId || ""));
    return ok(true);
  });
  ipcMain.handle("ai:previewRequest", (_, p) => {
    const history = withWriterPersona(conversationHistory(String(p?.conversationId || "")));
    const prefix = contextText(p?.contexts || []);
    const style = requestStyle(p);
    if (style.instruction) history.splice(1, 0, { role: "system", content: style.instruction });
    history.push({
      role: "user",
      content: (prefix ? `${prefix}\n\n` : "") + String(p?.prompt || ""),
    });
    return ok(history);
  });
  ipcMain.handle("ai:send", async (_event, p) => {
    const requestId = p.requestId || randomUUID(),
      controller = new AbortController();
    let conv = String(p.conversationId || "");
    let content = "";
    let connection: any = null;
    const style = requestStyle(p);
    let assistantSaved = false;
    requests.set(requestId, controller);
    try {
      if (!conv) {
        conv = newId();
        const t = timestamp();
        db.prepare(
          "INSERT INTO ai_conversations(id,novel_id,chapter_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        ).run(
          conv,
          p.novelId,
          p.chapterId || null,
          p.prompt.slice(0, 24) || "新会话",
          t,
          t,
        );
      }
      const uid = newId(),
        t = timestamp();
      db.prepare(
        "INSERT INTO ai_messages(id,conversation_id,role,content,model,connection_id,chapter_id,source_revision,selection_text,selection_from,selection_to,task_kind,style_id,style_name,style_version,style_rules,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        uid,
        conv,
        "user",
        String(p.prompt ?? ""),
        p.model ?? null,
        p.connectionId ?? null,
        p.chapterId ?? null,
        p.sourceRevision ?? null,
        p.selectionText ?? "",
        p.selectionFrom ?? null,
        p.selectionTo ?? null,
        p.taskKind || "chat",
        style.card?.id || null,
        style.card?.name || null,
        style.card?.version || null,
        style.instruction || null,
        t,
      );
      aiSession.novelId = p.novelId ?? aiSession.novelId;
      aiSession.connectionId = p.connectionId || aiSession.connectionId;
      aiSession.conversationId = conv;
      aiSession.requestId = requestId;
      aiSession.generating = true;
      aiSession.generatingConversationId = conv;
      aiSession.text = "";
      aiSession.messages = [
        ...aiSession.messages,
        {
          id: uid,
          role: "user",
          content: p.prompt,
          chapter_id: p.chapterId ?? null,
          source_revision: p.sourceRevision ?? null,
          source_message_id: uid,
          source_refs: (p.contexts || []).map((x: any) => ({
            label: String(x.label || ""),
            kind: String(x.kind || ""),
            source_id: x.sourceId || null,
          })),
        },
        {
          role: "assistant",
          content: "",
          streaming: true,
          conversationId: conv,
          chapter_id: p.chapterId ?? null,
          source_revision: p.sourceRevision ?? null,
          source_message_id: uid,
          source_refs: (p.contexts || []).map((x: any) => ({
            label: String(x.label || ""),
            kind: String(x.kind || ""),
            source_id: x.sourceId || null,
          })),
        },
      ];
      broadcastSession();
      broadcastConversations(String(p.novelId || aiSession.novelId || ""));
      const savedRefs = (p.contexts || []).map((x: any) => {
        const snapshot = {
          label: String(x.label || ""),
          kind: String(x.kind || ""),
          content: String(x.content || ""),
          source_id: x.sourceId || null,
          source_data_version: null as number | null,
        };
        if (librarySourceKinds.has(snapshot.kind) && snapshot.source_id) {
          const source: any = get(
            "SELECT data_version FROM library_items WHERE id=? AND novel_id=? AND kind=? AND deleted_at IS NULL",
            snapshot.source_id,
            String(p.novelId || ""),
            snapshot.kind,
          );
          snapshot.source_data_version = source ? Number(source.data_version) : null;
        }
        db.prepare(
          "INSERT INTO message_context_snapshots(id,message_id,label,kind,content,source_id,created_at,source_data_version) VALUES(?,?,?,?,?,?,?,?)",
        ).run(newId(), uid, snapshot.label, snapshot.kind, snapshot.content, snapshot.source_id, t, snapshot.source_data_version);
        return sourceState(snapshot, String(p.novelId || ""));
      });
      const liveRefs = savedRefs.map((x: any) => ({
        label: x.label,
        kind: x.kind,
        source_id: x.source_id,
        source_status: x.source_status,
        current_data_version: x.current_data_version,
        current_title: x.current_title,
      }));
      for (const message of aiSession.messages.slice(-2)) message.source_refs = liveRefs;
      // 规则只在本次请求的内存快照中加入一次，不写入对话历史，避免逐轮累积。
      const history = withWriterPersona(conversationHistory(conv));
      if (style.instruction) history.splice(1, 0, { role: "system", content: style.instruction });
      connection =
        p.connectionId === ZHUWEN_SERVER_CONNECTION_ID
          ? serverConnection()
          : get("SELECT * FROM api_connections WHERE id=?", p.connectionId);
      const key =
        p.connectionId === ZHUWEN_SERVER_CONNECTION_ID
          ? requireServerToken()
          : readSecret(userDir, p.connectionId);
      if (!connection || !key) throw new Error("AI 连接或 API Key 未配置");
      for (let attempt = 0; ; attempt++) {
        try {
          await chatRequest(
            connection,
            key,
            history,
            Boolean(connection.streaming),
            controller,
            (chunk) => {
              content += chunk;
              // 仅当用户仍停留在该生成会话时更新共享流，避免串话
              if (aiSession.conversationId === conv) {
                const last = aiSession.messages[aiSession.messages.length - 1];
                if (last?.streaming) last.content += chunk;
                scheduleSessionBroadcast();
              }
            },
          );
          break;
        } catch (error: any) {
          const retryable =
            !content &&
            !controller.signal.aborted &&
            attempt === 0 &&
            (error?.status === 429 || error?.status >= 500 || !error?.status);
          if (!retryable) throw error;
          await new Promise((resolve) => setTimeout(resolve, 650));
        }
      }
      const aid = newId();
      db.prepare(
        "INSERT INTO ai_messages(id,conversation_id,role,content,model,connection_id,chapter_id,source_revision,selection_text,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        aid,
        conv,
        "assistant",
        String(content ?? ""),
        connection?.model ?? null,
        connection?.id ?? null,
        p.chapterId ?? null,
        p.sourceRevision ?? null,
        p.selectionText ?? "",
        timestamp(),
      );
      assistantSaved = true;
      db.prepare("UPDATE ai_conversations SET updated_at=? WHERE id=?").run(
        timestamp(),
        conv,
      );
      const last = aiSession.messages[aiSession.messages.length - 1];
      if (last?.streaming) {
        last.streaming = false;
        last.id = aid;
        last.source_revision = p.sourceRevision;
        last.model = connection.model;
      }
      aiSession.generating = false;
      broadcastSession();
      return ok({ requestId, conversationId: conv, messageId: aid });
    } catch (e) {
      const aborted = controller.signal.aborted;
      const last = aiSession.messages[aiSession.messages.length - 1];
      if (content && conv && !assistantSaved) {
        try {
          const aid = newId();
          const createdAt = timestamp();
          db.transaction(() => {
            db.prepare(
              "INSERT INTO ai_messages(id,conversation_id,role,content,model,connection_id,chapter_id,source_revision,selection_text,incomplete,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            ).run(
              aid,
              conv,
              "assistant",
              content,
              connection?.model || p.model || null,
              connection?.id || p.connectionId || null,
              p.chapterId || null,
              p.sourceRevision ?? null,
              p.selectionText || "",
              1,
              createdAt,
            );
            db.prepare(
              "UPDATE ai_conversations SET updated_at=? WHERE id=?",
            ).run(createdAt, conv);
          })();
          if (last?.streaming) {
            last.id = aid;
            last.model = connection?.model || p.model || null;
            last.source_revision = p.sourceRevision;
          }
        } catch {}
      }
      if (last?.streaming) {
        last.streaming = false;
        last.incomplete = true;
      }
      aiSession.generating = false;
      broadcastSession();
      return fail(aborted ? "已停止生成" : classifyError(e));
    } finally {
      requests.delete(requestId);
    }
  });
  ipcMain.handle("ai:cancel", (_, id) => {
    requests.get(id)?.abort();
    return ok(true);
  });
  ipcMain.handle("ai:summarize", async (_, p) => {
    try {
      const c: any = get(
        "SELECT * FROM chapters WHERE id=? AND deleted_at IS NULL",
        p.chapterId,
      );
      if (!c) throw new Error("章节不存在");
      const conn: any =
        p.connectionId === ZHUWEN_SERVER_CONNECTION_ID
          ? serverConnection()
          : get("SELECT * FROM api_connections WHERE id=?", p.connectionId);
      const key =
        p.connectionId === ZHUWEN_SERVER_CONNECTION_ID
          ? requireServerToken()
          : readSecret(userDir, p.connectionId);
      if (!conn || !key) throw new Error("AI 连接或 API Key 未配置");
      const text = String(c.plain_text || "")
        .slice(0, 12000)
        .trim();
      if (!text) throw new Error("章节内容为空，无法生成摘要");
      let summary = "";
      await chatRequest(
        conn,
        key,
        [
          {
            role: "system",
            content:
              "你是小说编辑。用不超过 150 字概括给定章节的主要情节、出场人物与推进方向。只输出摘要正文，不要添加原文没有的事实。",
          },
          { role: "user", content: text },
        ],
        false,
        new AbortController(),
        (chunk) => {
          summary += chunk;
        },
      );
      summary = summary.trim();
      if (!summary) throw new Error("接口未返回摘要内容");
      db.prepare(
        "UPDATE chapters SET summary=?,summary_revision=?,summary_updated_at=? WHERE id=?",
      ).run(summary, c.revision, timestamp(), c.id);
      return ok({
        summary,
        sourceRevision: c.revision,
        updatedAt: timestamp(),
      });
    } catch (e) {
      return fail(classifyError(e));
    }
  });
  ipcMain.handle("ai:session:get", () => ok(aiSessionSnapshot()));
  ipcMain.handle("ai:session:patch", (_, p) => {
    const prevNovel = aiSession.novelId;
    const prevConv = aiSession.conversationId;
    // 文本/引用走带版本的草稿通道，防止延迟提交串写
    if (p && (typeof p.text === "string" || Array.isArray(p.contexts))) {
      const accepted = applyDraftPatch(userDir, p);
      if (!accepted) return ok({ accepted: false });
      // 其余字段继续处理
      const rest = { ...p };
      delete rest.text;
      delete rest.contexts;
      p = rest;
    }
    const keys = [
      "novelId",
      "chapter",
      "selectionText",
      "connectionId",
      "conversationId",
      "messages",
    ];
    if (p && "conversationId" in p && p.conversationId !== prevConv) {
      saveConversationDraft(userDir);
    }
    for (const k of keys) if (p && k in p) (aiSession as any)[k] = p[k];
    if (p && "novelId" in p && p.novelId !== prevNovel) {
      saveConversationDraft(userDir);
      aiSession.conversationId = "";
      aiSession.messages = [];
      aiSession.contexts = [];
      aiSession.text = "";
    }
    if (p && "conversationId" in p && p.conversationId !== prevConv) {
      loadConversationDraft(
        String(aiSession.novelId || ""),
        String(aiSession.conversationId || ""),
      );
    }
    broadcastSession();
    return ok(true);
  });
  ipcMain.handle("ai:session:loadConversation", (_, conversationId) => {
    saveConversationDraft(userDir);
    if (!conversationId) {
      aiSession.conversationId = "";
      aiSession.messages = [];
    } else {
      aiSession.conversationId = conversationId;
      const rows: any[] = all(
        "SELECT * FROM ai_messages WHERE conversation_id=? ORDER BY created_at,rowid",
        conversationId,
      );
      const userIds = rows.filter((row) => row.role === "user").map((row) => row.id);
      const snapshots: any[] = userIds.length
        ? all(
            `SELECT message_id,label,kind,source_id,source_data_version FROM message_context_snapshots WHERE message_id IN (${userIds.map(() => "?").join(",")}) ORDER BY created_at,rowid`,
            ...userIds,
          )
        : [];
      const refsByMessage = new Map<string, any[]>();
      for (const snapshot of snapshots) {
        refsByMessage.set(snapshot.message_id, [
          ...(refsByMessage.get(snapshot.message_id) || []),
          ((source) => ({
            label: source.label,
            kind: source.kind,
            source_id: source.source_id,
            source_status: source.source_status,
            current_data_version: source.current_data_version,
            current_title: source.current_title,
          }))(sourceState(snapshot, String(aiSession.novelId || ""))),
        ]);
      }
      let lastSourceMessageId = "";
      let lastSourceRefs: any[] = [];
      aiSession.messages = rows.map((row) => {
        if (row.role === "user") {
          lastSourceMessageId = row.id;
          lastSourceRefs = refsByMessage.get(row.id) || [];
          return {
            ...row,
            source_message_id: row.id,
            source_refs: lastSourceRefs,
          };
        }
        return {
          ...row,
          source_message_id: row.role === "assistant" ? lastSourceMessageId : "",
          source_refs: row.role === "assistant" ? lastSourceRefs : [],
        };
      });
    }
    loadConversationDraft(
      String(aiSession.novelId || ""),
      String(aiSession.conversationId || ""),
    );
    broadcastSession();
    return ok(true);
  });
  ipcMain.handle("ai:message:contexts", (_, messageId) => {
    const row: any = get(
      "SELECT m.id,c.novel_id FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.role='user'",
      String(messageId || ""),
    );
    if (!row || row.novel_id !== aiSession.novelId)
      return fail("引用快照不存在或不属于当前作品");
    return ok(
      all(
        "SELECT label,kind,content,source_id AS sourceId,source_data_version AS sourceDataVersion FROM message_context_snapshots WHERE message_id=? ORDER BY created_at,rowid",
        row.id,
      ).map((snapshot: any) => {
        const state = sourceState({
          ...snapshot,
          source_id: snapshot.sourceId,
          source_data_version: snapshot.sourceDataVersion,
        }, String(row.novel_id));
        return {
          ...snapshot,
          sourceStatus: state.source_status,
          currentDataVersion: state.current_data_version,
          currentTitle: state.current_title,
        };
      }),
    );
  });
  ipcMain.handle("ai:float:open", () => {
    openFloatWindow();
    return ok(true);
  });
  ipcMain.handle("ai:float:close", () => {
    floatWin?.close();
    return ok(true);
  });

  ipcMain.handle("backup:create", async (_, p) => {
    try {
      const target = await dialog.showOpenDialog({
        title: "选择备份目录",
        properties: ["openDirectory", "createDirectory"],
      });
      if (target.canceled) return ok(null);
      const bundle = buildBackup(p.novelId);
      const safe = String(bundle.novel.title).replace(/[<>:"/\\|?*]/g, "_");
      const file = path.join(
        target.filePaths[0],
        `${safe}-${timestamp().replace(/[:.]/g, "-")}.zhuwen-backup.json`,
      );
      await writeVerifiedJson(file, bundle, verifyBackup);
      const stat = await fs.promises.stat(file);
      db.prepare("INSERT INTO backup_records VALUES(?,?,?,?,?,?,?,1)").run(
        newId(),
        p.novelId,
        file,
        stat.size,
        "success",
        null,
        timestamp(),
      );
      return ok({ file });
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("backup:list", (_, novelId) =>
    ok(
      all(
        "SELECT * FROM backup_records WHERE novel_id=? ORDER BY created_at DESC",
        novelId,
      ),
    ),
  );
  ipcMain.handle("backup:chooseDir", async () => {
    const target = await dialog.showOpenDialog({
      title: "选择自动备份目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (target.canceled) return ok(null);
    return ok({ directory: target.filePaths[0] });
  });
  ipcMain.handle("backup:runAutoNow", async () => {
    const row: any = get(
      "SELECT value_json FROM preferences WHERE key='autoBackup'",
    );
    let cfg: any = {};
    try {
      cfg = row?.value_json ? JSON.parse(row.value_json) : {};
    } catch {}
    if (!cfg?.directory) return fail("尚未设置自动备份目录");
    const result = await runAutoBackup(cfg);
    return result.ok ? ok(result) : fail(result.error || "自动备份失败");
  });
  ipcMain.handle("backup:restore", async () => {
    try {
      const f = await dialog.showOpenDialog({
        title: "选择铸文备份",
        filters: [{ name: "铸文备份", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (f.canceled) return ok(null);
      if ((await fs.promises.stat(f.filePaths[0])).size > MAX_BACKUP_FILE_BYTES)
        throw new Error("备份文件过大，无法安全恢复");
      const raw = await fs.promises.readFile(f.filePaths[0], "utf8"),
        bundle = JSON.parse(raw);
      verifyBackup(bundle);
      const id = restoreBackupAsCopy(bundle);
      return ok({ id });
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("export:novel", async (_, p) => {
    try {
      const requestedFormat = String(p?.format || "");
      const ext = ["txt", "md", "docx", "epub"].includes(requestedFormat)
        ? requestedFormat
        : "txt";
      const rows: any[] = all(
        `SELECT c.*,v.title volume_title FROM chapters c LEFT JOIN volumes v ON c.volume_id=v.id WHERE c.novel_id=? AND c.deleted_at IS NULL ${p.chapterIds?.length ? `AND c.id IN (${p.chapterIds.map(() => "?").join(",")})` : ""} ORDER BY COALESCE(v.sort_order,-1),c.sort_order`,
        p.novelId,
        ...(p.chapterIds || []),
      );
      if (ext === "epub" && !rows.length)
        throw new Error("没有可导出的章节内容");
      const novel: any = get("SELECT * FROM novels WHERE id=?", p.novelId);
      const safeTitle = String(novel?.title || p?.title || "小说")
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
        .replace(/[. ]+$/g, "")
        .slice(0, 100) || "小说";
      const f = await dialog.showSaveDialog({
        title: "导出稿件",
        defaultPath: `${safeTitle}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (f.canceled || !f.filePath) return ok(null);
      if (ext === "docx") await writeDocx(f.filePath, novel, rows, p);
      else if (ext === "epub")
        await fs.promises.writeFile(f.filePath, await buildEpub(novel, rows, p));
      else
        await fs.promises.writeFile(
          f.filePath,
          renderText(novel, rows, p, ext === "md"),
          p.encoding === "utf16le" ? "utf16le" : "utf8",
        );
      return ok({ file: f.filePath });
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("import:text", async (event) => {
    const taskId = event.sender.id;
    importTasks.get(taskId)?.abort();
    const controller = new AbortController();
    importTasks.set(taskId, controller);
    try {
      const f = await dialog.showOpenDialog({
        title: "导入 TXT、Markdown 或 DOCX",
        filters: [
          { name: "文本或文档", extensions: ["txt", "md", "markdown", "docx"] },
        ],
        properties: ["openFile"],
      });
      if (f.canceled) return ok(null);
      const file = f.filePaths[0];
      const size = (await fs.promises.stat(file)).size;
      if (size > 100 * 1024 * 1024)
        throw new Error("导入文件过大，请选择 100MB 以内的文件");
      const sendProgress = (read: number) =>
        event.sender.send("import:progress", { read, total: size });
      const buf = await readImportFile(
        file,
        size,
        sendProgress,
        controller.signal,
      );
      if (path.extname(file).toLowerCase() === ".docx") {
        const text = extractDocxTextBuffer(buf);
        if (!text)
          throw new Error(
            "未从 DOCX 中提取到正文文字（可能为图片型或加密文档）",
          );
        return ok({
          path: file,
          token: registerImportFile(file),
          encoding: "docx",
          parts: splitChapters(text),
        });
      }
      const { text, encoding } = decodeImportBuffer(buf);
      const parts = splitChapters(text);
      return ok({
        path: file,
        token: registerImportFile(file),
        encoding,
        parts,
      });
    } catch (e) {
      if (controller.signal.aborted) return fail("IMPORT_CANCELLED");
      return fail(e);
    } finally {
      if (importTasks.get(taskId) === controller) importTasks.delete(taskId);
    }
  });
  ipcMain.handle("import:decode", async (event, p) => {
    const taskId = event.sender.id;
    importTasks.get(taskId)?.abort();
    const controller = new AbortController();
    importTasks.set(taskId, controller);
    try {
      const entry = importFiles.get(String(p?.token || ""));
      if (!entry || entry.createdAt < Date.now() - IMPORT_SESSION_TTL) {
        if (entry) importFiles.delete(String(p?.token || ""));
        throw new Error("导入会话已失效，请重新选择文件");
      }
      const file = entry.file;
      if (path.extname(file).toLowerCase() === ".docx")
        throw new Error("DOCX 不支持切换文本编码");
      const size = (await fs.promises.stat(file)).size;
      const buffer = await readImportFile(file, size, (read) =>
        event.sender.send("import:progress", { read, total: size }),
        controller.signal,
      );
      const decoded = decodeImportBuffer(buffer, String(p?.encoding || "utf-8"));
      return ok({ encoding: decoded.encoding, parts: splitChapters(decoded.text) });
    } catch (error) {
      if (controller.signal.aborted) return fail("IMPORT_CANCELLED");
      return fail(error);
    } finally {
      if (importTasks.get(taskId) === controller) importTasks.delete(taskId);
    }
  });
  ipcMain.handle("import:cancel", (event) => {
    importTasks.get(event.sender.id)?.abort();
    return ok(true);
  });
  ipcMain.handle("import:commit", (_, p) => {
    try {
      const result = db.transaction(() => {
        const id = newId(),
          t = timestamp();
        db.prepare(
          "INSERT INTO novels(id,title,author,created_at,updated_at) VALUES(?,?,?,?,?)",
        ).run(id, p.title || "导入作品", p.author || "", t, t);
        const ins = db.prepare(
          "INSERT INTO chapters(id,novel_id,title,content_json,plain_text,word_count,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        );
        p.parts.forEach((x: any, i: number) => {
          const content = {
            type: "doc",
            content: x.text
              .split(/\n+/)
              .filter(Boolean)
              .map((s: string) => ({
                type: "paragraph",
                content: [{ type: "text", text: s }],
              })),
          };
          ins.run(
            newId(),
            id,
            x.title,
            JSON.stringify(content),
            x.text,
            countText(x.text),
            i,
            t,
            t,
          );
        });
        return ok({ id });
      })();
      if (p.token) importFiles.delete(String(p.token));
      return result;
    } catch (e) {
      return fail(e);
    }
  });
}

function pruneRevisions(chapterId: string) {
  db.prepare(
    `DELETE FROM chapter_revisions WHERE chapter_id=? AND id NOT IN (
       SELECT id FROM chapter_revisions WHERE chapter_id=?
       ORDER BY created_at DESC, rowid DESC LIMIT 100)`,
  ).run(chapterId, chapterId);
}
function validateBaseUrl(raw: string) {
  const u = new URL(raw);
  if (u.username || u.password)
    throw new Error("API 地址不能包含用户名或密码");
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(u.hostname)
    )
  )
    throw new Error("远程 API 必须使用 HTTPS；仅 localhost 可使用 HTTP");
}
function secretPath(userDir: string) {
  return path.join(userDir, "secrets.json");
}
function secretMap(userDir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(secretPath(userDir), "utf8"));
  } catch {
    return {};
  }
}
function saveSecret(userDir: string, id: string, key: string) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("系统安全凭据加密当前不可用");
  const m = secretMap(userDir);
  m[id] = safeStorage.encryptString(key).toString("base64");
  fs.writeFileSync(secretPath(userDir), JSON.stringify(m), "utf8");
}
function readSecret(userDir: string, id: string) {
  const v = secretMap(userDir)[id];
  if (!v) return "";
  return safeStorage.decryptString(Buffer.from(v, "base64"));
}
function deleteSecret(userDir: string, id: string) {
  const m = secretMap(userDir);
  delete m[id];
  fs.writeFileSync(secretPath(userDir), JSON.stringify(m), "utf8");
}
function apiUrl(base: string) {
  const b = base.replace(/\/$/, "");
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
}
async function chatRequest(
  c: any,
  key: string,
  messages: any[],
  stream: boolean,
  controller: AbortController,
  onChunk: (s: string) => void,
) {
  const timer = setTimeout(
    () => controller.abort(new Error("请求超时")),
    c.timeout_ms,
  );
  try {
      const body: Record<string, unknown> = {
        model: c.model,
        messages,
        temperature: c.temperature,
        max_tokens: c.max_tokens,
        stream,
      };
      const effort = String(c.reasoning_effort || "").trim();
      if (effort === "low" || effort === "medium" || effort === "high")
        body.reasoning_effort = effort;
      const res = await fetch(apiUrl(c.base_url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 1000);
      const e: any = new Error(body || res.statusText);
      e.status = res.status;
      throw e;
    }
    if (!stream) {
      const j: any = await res.json();
      const text = j.choices?.[0]?.message?.content;
      if (typeof text !== "string")
        throw new Error("响应格式不兼容：缺少 choices[0].message.content");
      onChunk(text);
      return;
    }
    if (!res.body) throw new Error("响应格式不兼容：没有响应流");
    const reader = res.body.getReader(),
      decoder = new TextDecoder();
    let pending = "";
    let completed = false;
    const consume = (line: string) => {
      const s = line.trim();
      if (!s || s.startsWith(":")) return;
      if (!s.startsWith("data:")) return;
      const data = s.slice(5).trim();
      if (data === "[DONE]") {
        completed = true;
        return;
      }
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        throw new Error("响应格式不兼容：流式数据不是有效 JSON");
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) onChunk(delta);
      if (choice?.finish_reason != null) completed = true;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        consume(line);
        if (completed) return;
      }
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
    if (!completed) throw new Error("AI 响应流意外中断");
  } finally {
    clearTimeout(timer);
  }
}
function classifyError(e: any) {
  const s = String(e?.message || e);
  const cause = String(e?.cause?.code || e?.code || "");
  if (e?.name === "TimeoutError" || cause === "UND_ERR_CONNECT_TIMEOUT")
    return "请求超时，可在连接设置中调大超时时间";
  if (e?.status === 401) return "身份验证失败：API Key 不正确或已失效";
  if (e?.status === 403) return "无权访问该模型或服务，请检查 Key 权限";
  if (e?.status === 404)
    return /model/i.test(s)
      ? "模型不存在或无权访问，请检查模型 ID"
      : "接口地址不存在，请检查 API 基础地址";
  if (e?.status === 429) return "请求过于频繁或额度受限";
  if (e?.status >= 500) return "AI 服务暂时异常，请稍后重试";
  if (/context|token.*limit/i.test(s)) return "上下文过长，请减少引用内容";
  if (/abort|timeout|超时/i.test(s))
    return "请求超时，可在连接设置中调大超时时间";
  if (/ENOTFOUND|EAI_AGAIN/.test(cause + s))
    return "API 地址不可访问，请检查基础地址拼写";
  if (/ECONNREFUSED/.test(cause + s))
    return "无法连接到服务器，请确认地址与端口";
  if (/CERT|SSL/i.test(cause + s))
    return "HTTPS 证书校验失败，请检查服务端证书";
  if (/fetch|network|ECONN/i.test(cause + s))
    return "网络连接失败或地址不可访问";
  return s.replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 500);
}
const MAX_BACKUP_FILE_BYTES = 512 * 1024 * 1024;
const MAX_BACKUP_ITEMS = 200_000;

let autoBackupTimer: ReturnType<typeof setInterval> | null = null;
let autoBackupKickoffTimer: ReturnType<typeof setTimeout> | null = null;
let autoBackupRunning = false;
function configureAutoBackup() {
  if (autoBackupTimer) {
    clearInterval(autoBackupTimer);
    autoBackupTimer = null;
  }
  if (autoBackupKickoffTimer) {
    clearTimeout(autoBackupKickoffTimer);
    autoBackupKickoffTimer = null;
  }
  const row: any = get(
    "SELECT value_json FROM preferences WHERE key='autoBackup'",
  );
  let cfg: any = {};
  try {
    cfg = row?.value_json ? JSON.parse(row.value_json) : {};
  } catch {}
  if (!cfg?.enabled || !cfg?.directory || !cfg?.intervalMinutes) return;
  const minutes = Math.min(10080, Math.max(1, Math.floor(cfg.intervalMinutes)));
  const lastRow: any = get(
    "SELECT value_json FROM preferences WHERE key='autoBackupLast'",
  );
  let lastAt = 0;
  try {
    const parsed = lastRow?.value_json ? JSON.parse(lastRow.value_json) : null;
    lastAt = parsed?.at ? Date.parse(parsed.at) : 0;
  } catch {
    lastAt = 0;
  }
  if (!lastAt || Date.now() - lastAt >= minutes * 60 * 1000) {
    autoBackupKickoffTimer = setTimeout(() => {
      autoBackupKickoffTimer = null;
      void runAutoBackup(cfg);
    }, 5000);
  }
  autoBackupTimer = setInterval(() => void runAutoBackup(cfg), minutes * 60 * 1000);
}
async function runAutoBackup(cfg: any): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  if (autoBackupRunning)
    return { ok: false, error: "自动备份正在进行中" };
  autoBackupRunning = true;
  try {
    if (!cfg?.directory || !fs.existsSync(cfg.directory))
      throw new Error("自动备份目录不存在");
    const novelsList: any[] = all(
      "SELECT * FROM novels WHERE deleted_at IS NULL",
    );
    let count = 0;
    for (const n of novelsList) {
      const bundle = buildBackup(n.id);
      const safe = String(bundle.novel.title).replace(/[<>:"/\\|?*]/g, "_");
      const file = path.join(
        cfg.directory,
        `${safe}-auto-${timestamp().replace(/[:.]/g, "-")}.zhuwen-backup.json`,
      );
      await writeVerifiedJson(file, bundle, verifyBackup);
      const stat = await fs.promises.stat(file);
      db.prepare("INSERT INTO backup_records VALUES(?,?,?,?,?,?,?,1)").run(
        newId(),
        n.id,
        file,
        stat.size,
        "auto",
        null,
        timestamp(),
      );
      count++;
      const keep = Math.min(100, Math.max(1, Math.floor(cfg.keep || 10)));
      const autos: any[] = all(
        "SELECT * FROM backup_records WHERE novel_id=? AND status='auto' ORDER BY created_at DESC",
        n.id,
      );
      for (const old of autos.slice(keep)) {
        try {
          await fs.promises.unlink(old.file_path);
        } catch {
          // A missing old file should not prevent pruning its stale record.
        }
        db.prepare("DELETE FROM backup_records WHERE id=?").run(old.id);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    writeAutoStatus({ at: timestamp(), ok: true, count });
    return { ok: true, count };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    writeAutoStatus({ at: timestamp(), ok: false, error });
    return { ok: false, error };
  } finally {
    autoBackupRunning = false;
  }
}
function writeAutoStatus(value: any) {
  try {
    db.prepare(
      "INSERT INTO preferences(key,value_json,updated_at) VALUES('autoBackupLast',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    ).run(JSON.stringify(value), timestamp());
  } catch {}
}
function buildBackup(novelId: string) {
  const novel: any = get("SELECT * FROM novels WHERE id=?", novelId);
  if (!novel) throw new Error("小说不存在");
  const bundle: any = {
    format: "zhuwen-backup",
    version: 1,
    createdAt: timestamp(),
    novel,
    volumes: all("SELECT * FROM volumes WHERE novel_id=?", novelId),
    chapters: all("SELECT * FROM chapters WHERE novel_id=?", novelId),
    revisions: all(
      "SELECT r.* FROM chapter_revisions r JOIN chapters c ON c.id=r.chapter_id WHERE c.novel_id=? ORDER BY r.created_at",
      novelId,
    ),
    library: all("SELECT * FROM library_items WHERE novel_id=?", novelId),
    conversations: all(
      "SELECT * FROM ai_conversations WHERE novel_id=?",
      novelId,
    ),
  };
  const convIds = bundle.conversations.map((x: any) => x.id);
  bundle.messages = convIds.length
    ? all(
        `SELECT * FROM ai_messages WHERE conversation_id IN (${convIds.map(() => "?").join(",")})`,
        ...convIds,
      )
    : [];
  const messageIds = bundle.messages.map((x: any) => x.id);
  bundle.contexts = messageIds.length
    ? all(
        `SELECT * FROM message_context_snapshots WHERE message_id IN (${messageIds.map(() => "?").join(",")})`,
        ...messageIds,
      )
    : [];
  const selectedStyle: any = get("SELECT style_id,style_ids_json FROM novel_ai_styles WHERE novel_id=?", novelId);
  let styleIds: string[] = [];
  try { styleIds = JSON.parse(selectedStyle?.style_ids_json || "[]"); } catch {}
  if (!styleIds.length && selectedStyle?.style_id) styleIds = [String(selectedStyle.style_id)];
  bundle.styleSelection = [...new Set(styleIds)];
  bundle.styleCards = bundle.styleSelection.flatMap((id: string) => {
    const card = get("SELECT * FROM ai_style_cards WHERE id=? AND builtin=0", id);
    return card ? [card] : [];
  });
  bundle.checksum = createHash("sha256")
    .update(JSON.stringify(bundle))
    .digest("hex");
  return bundle;
}
function verifyBackup(b: any) {
  if (
    b?.format !== "zhuwen-backup" ||
    b.version !== 1 ||
    !b.novel ||
    typeof b.novel.title !== "string" ||
    !Array.isArray(b.volumes) ||
    !Array.isArray(b.chapters) ||
    !Array.isArray(b.library) ||
    !Array.isArray(b.conversations) ||
    !Array.isArray(b.messages) ||
    !Array.isArray(b.contexts) ||
    (b.styleCards !== undefined && !Array.isArray(b.styleCards))
  )
    throw new Error("备份格式或版本不受支持");
  for (const key of [
    "volumes",
    "chapters",
    "revisions",
    "library",
    "conversations",
    "messages",
    "contexts",
  ]) {
    const value = b[key];
    if (value !== undefined && !Array.isArray(value))
      throw new Error(`备份字段 ${key} 格式不正确`);
    if (Array.isArray(value) && value.length > MAX_BACKUP_ITEMS)
      throw new Error(`备份字段 ${key} 的记录数量超过安全限制`);
  }
  const hash = b.checksum,
    copy = { ...b };
  delete copy.checksum;
  if (createHash("sha256").update(JSON.stringify(copy)).digest("hex") !== hash)
    throw new Error("备份完整性检查失败，文件可能已损坏");
}
function restoreBackupAsCopy(b: any) {
  return db.transaction(() => {
    const novelId = newId(),
      t = timestamp(),
      idMap = new Map<string, string>(),
      libraryMap = new Map<string, string>(),
      convMap = new Map<string, string>(),
      messageMap = new Map<string, string>();
    db.prepare(
      "INSERT INTO novels(id,title,author,synopsis,genre,cover_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      novelId,
      b.novel.title + "（恢复）",
      b.novel.author || "",
      b.novel.synopsis || "",
      b.novel.genre || "",
      b.novel.cover_path || null,
      t,
      t,
    );
    for (const v of b.volumes) {
      const id = newId();
      idMap.set(v.id, id);
      db.prepare(
        "INSERT INTO volumes(id,novel_id,title,sort_order,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(id, novelId, v.title, v.sort_order, v.deleted_at || null, t, t);
    }
    for (const c of b.chapters) {
      const id = newId();
      idMap.set(c.id, id);
      db.prepare(
        "INSERT INTO chapters(id,novel_id,volume_id,title,content_json,plain_text,word_count,status,sort_order,revision,cursor_pos,scroll_pos,deleted_at,summary,summary_revision,summary_updated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        novelId,
        idMap.get(c.volume_id) || null,
        c.title,
        c.content_json,
        c.plain_text,
        c.word_count,
        c.status,
        c.sort_order,
        c.revision,
        c.cursor_pos || 0,
        c.scroll_pos || 0,
        c.deleted_at || null,
        c.summary || "",
        c.summary_revision ?? -1,
        c.summary_updated_at || null,
        t,
        t,
      );
    }
    if (b.novel.last_chapter_id && idMap.has(b.novel.last_chapter_id))
      db.prepare("UPDATE novels SET last_chapter_id=? WHERE id=?").run(
        idMap.get(b.novel.last_chapter_id)!,
        novelId,
      );
    for (const x of b.library || []) {
      const id = newId();
      libraryMap.set(x.id, id);
      db.prepare(
        "INSERT INTO library_items(id,novel_id,kind,title,content_json,tags_json,status,chapter_id,sort_order,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        novelId,
        x.kind,
        x.title,
        x.content_json,
        x.tags_json,
        x.status,
        idMap.get(x.chapter_id) || null,
        x.sort_order,
        x.deleted_at || null,
        t,
        t,
      );
    }
    for (const revision of b.revisions || []) {
      const chapterId = idMap.get(revision.chapter_id);
      if (!chapterId) continue;
      db.prepare(
        "INSERT INTO chapter_revisions(id,chapter_id,content_json,plain_text,word_count,source,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        newId(),
        chapterId,
        revision.content_json,
        revision.plain_text,
        revision.word_count,
        revision.source,
        revision.created_at || t,
      );
    }
    for (const c of b.conversations || []) {
      const id = newId();
      convMap.set(c.id, id);
      db.prepare(
        "INSERT INTO ai_conversations(id,novel_id,chapter_id,title,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        novelId,
        idMap.get(c.chapter_id) || null,
        c.title,
        c.deleted_at || null,
        c.created_at || t,
        c.updated_at || t,
      );
    }
    for (const m of b.messages || []) {
      const id = newId();
      messageMap.set(m.id, id);
      db.prepare(
        "INSERT INTO ai_messages(id,conversation_id,role,content,model,connection_id,chapter_id,source_revision,selection_text,incomplete,task_kind,style_id,style_name,style_version,style_rules,selection_from,selection_to,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        convMap.get(m.conversation_id)!,
        m.role,
        m.content,
        m.model,
        m.connection_id,
        idMap.get(m.chapter_id) || null,
        m.source_revision,
        m.selection_text,
        m.incomplete || 0,
        m.task_kind || "chat",
        m.style_id || null,
        m.style_name || null,
        m.style_version || null,
        m.style_rules || null,
        m.selection_from ?? null,
        m.selection_to ?? null,
        m.created_at || t,
      );
    }
    for (const x of b.contexts || [])
      if (messageMap.has(x.message_id))
        db.prepare(
          "INSERT INTO message_context_snapshots(id,message_id,label,kind,content,source_id,created_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          newId(),
          messageMap.get(x.message_id)!,
          x.label,
          x.kind,
          x.content,
          idMap.get(x.source_id) ||
            libraryMap.get(x.source_id) ||
            x.source_id ||
            null,
          x.created_at || t,
        );
    const restoredStyles = new Map<string, string>();
    for (const source of b.styleCards || []) {
      if (!source?.id || restoredStyles.has(String(source.id))) continue;
      const restoredId = newId();
      db.prepare(
        "INSERT INTO ai_style_cards(id,name,description,tasks_json,rules,builtin,builtin_version,created_at,updated_at) VALUES(?,?,?,?,?,0,1,?,?)",
      ).run(
        restoredId,
        source.name,
        source.description || "",
        source.tasks_json || "[]",
        source.rules || "",
        t,
        t,
      );
      restoredStyles.set(String(source.id), restoredId);
    }
    const sourceSelection = Array.isArray(b.styleSelection)
      ? b.styleSelection.map((id: unknown) => String(id || ""))
      : b.styleSelection ? [String(b.styleSelection)] : [];
    const restoredStyleIds: string[] = [...new Set<string>(sourceSelection.map((id: string) =>
      restoredStyles.get(id) || (styleCardRow(id) ? id : ""),
    ).filter((id: string): id is string => Boolean(id)))].slice(0, 6);
    if (restoredStyleIds.length)
      db.prepare("INSERT INTO novel_ai_styles(novel_id,style_id,updated_at,style_ids_json) VALUES(?,?,?,?)")
        .run(novelId, restoredStyleIds[0], t, JSON.stringify(restoredStyleIds));
    return novelId;
  })();
}
function renderText(n: any, rows: any[], p: any, md: boolean) {
  const out: string[] = [];
  if (p.includeTitle !== false) out.push(md ? `# ${n.title}` : n.title);
  if (p.includeAuthor !== false && n.author)
    out.push(md ? `> 作者：${n.author}` : `作者：${n.author}`);
  let vol = "";
  for (const c of rows) {
    if (p.includeVolume !== false && c.volume_title && c.volume_title !== vol) {
      vol = c.volume_title;
      out.push(md ? `## ${vol}` : vol);
    }
    if (p.includeChapter !== false) out.push(md ? `### ${c.title}` : c.title);
    out.push(c.plain_text);
  }
  return out.join("\n\n");
}
async function writeDocx(file: string, n: any, rows: any[], p: any) {
  const children: Paragraph[] = [];
  if (p.includeTitle !== false)
    children.push(
      new Paragraph({ text: n.title, heading: HeadingLevel.TITLE }),
    );
  if (p.includeAuthor !== false && n.author)
    children.push(new Paragraph({ text: `作者：${n.author}` }));
  let vol = "";
  for (const c of rows) {
    if (p.includeVolume !== false && c.volume_title && c.volume_title !== vol) {
      vol = c.volume_title;
      children.push(
        new Paragraph({
          text: vol,
          heading: HeadingLevel.HEADING_1,
          pageBreakBefore: true,
        }),
      );
    }
    if (p.includeChapter !== false)
      children.push(
        new Paragraph({
          text: c.title,
          heading: HeadingLevel.HEADING_2,
          pageBreakBefore: true,
        }),
      );
    for (const line of c.plain_text.split(/\n+/).filter(Boolean))
      children.push(
        new Paragraph({
          indent: { firstLine: 480 },
          spacing: { line: 360, after: 120 },
          children: [new TextRun({ text: line, font: "宋体", size: 24 })],
        }),
      );
  }
  const doc = new Document({
    styles: { default: { document: { run: { font: "宋体", size: 24 } } } },
    sections: [{ children }],
  });
  await fs.promises.writeFile(file, await Packer.toBuffer(doc));
}
function splitChapters(text: string) {
  const re = /^(第[零〇一二三四五六七八九十百千万\d]+[章节回卷部].*)$/gm,
    matches = [...text.matchAll(re)];
  if (!matches.length) return [{ title: "正文", text: text.trim() }];
  const parts: any[] = [];
  if ((matches[0].index || 0) > 0) {
    const pre = text.slice(0, matches[0].index).trim();
    if (pre) parts.push({ title: "前言", text: pre });
  }
  matches.forEach((m, i) => {
    const start = (m.index || 0) + m[0].length,
      end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    parts.push({ title: m[1].trim(), text: text.slice(start, end).trim() });
  });
  return parts;
}
