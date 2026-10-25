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
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { extractDocxTextBuffer } from "./docx";
import { decodeImportBuffer } from "./text-import";
import { writeVerifiedJson } from "./atomic-json";
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from "docx";
import { buildEpub, buildPrintHtml } from "./epub";
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
import { buildTaskAndStyleInstructions, effectiveStyleRules, normalizeStyleIntensity } from "./ai-style-cards";
import { parseStyleCompositionBundle } from "./ai-style-bundle";
import { formatConversationMarkdown, safeConversationFilename } from "./ai-conversation-export";

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
let uiSmokeEchoBaseUrl = "";
let uiSmokeEchoServer: ReturnType<typeof createServer> | null = null;
let uiSmokeEchoRequest: { authorization: string; payload: any } | null = null;
function closeUiSmokeEchoServer() {
  if (!uiSmokeEchoServer) return;
  uiSmokeEchoServer.closeAllConnections();
  uiSmokeEchoServer.close();
  uiSmokeEchoServer = null;
  uiSmokeEchoBaseUrl = "";
}
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
  draftStyleIds: string[] | null;
  draftVersion: number;
  messages: any[];
  generating: boolean;
  requestId: string;
  generatingConversationId?: string;
  messageWindow?: { hasEarlier: boolean; beforeMessageId: string | null };
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
  draftStyleIds: null,
  draftVersion: 0,
  messages: [],
  messageWindow: { hasEarlier: false, beforeMessageId: null },
  generating: false,
  requestId: "",
  generatingConversationId: "",
};
const AI_SESSION_MESSAGE_WINDOW = 80;
function trimAiSessionMessageWindow() {
  const allMessages = aiSession.messages;
  let start = Math.max(0, allMessages.length - AI_SESSION_MESSAGE_WINDOW);
  let messages = allMessages.slice(start);
  if (start > 0 && messages[0]?.role === "assistant" && allMessages[start - 1]?.role === "user") {
    start -= 1;
    messages = allMessages.slice(start);
  }
  const hasEarlier = Boolean(aiSession.messageWindow?.hasEarlier || start > 0);
  aiSession.messages = messages;
  aiSession.messageWindow = {
    hasEarlier,
    beforeMessageId: hasEarlier ? String(messages[0]?.id || "") || null : null,
  };
}
function resetAiSessionMessageWindow() {
  aiSession.messages = [];
  aiSession.messageWindow = { hasEarlier: false, beforeMessageId: null };
}
function aiSessionSnapshot() {
  return JSON.parse(JSON.stringify({
    ...aiSession,
  }));
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
function saveConversationDraft(userDir: string, versionHint?: number) {
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
    ...(Array.isArray(aiSession.draftStyleIds) ? { styleIds: [...aiSession.draftStyleIds] } : {}),
    version: Math.max(
      Math.max(prev?.version || 0, draftTombstones[key] || 0) + 1,
      Number.isFinite(versionHint) ? Number(versionHint) : 0,
    ),
    updatedAt: new Date().toISOString(),
  };
  conversationDrafts[key] = next;
  aiSession.draftVersion = next.version;
  persistDrafts();
  return next;
}
function loadConversationDraft(novelId: string, convId: string) {
  const d = conversationDrafts[draftKey(novelId, convId || "")];
  aiSession.text = d?.text || "";
  aiSession.contexts = d?.contexts ? JSON.parse(JSON.stringify(d.contexts)) : [];
  aiSession.draftStyleIds = Array.isArray(d?.styleIds) ? [...d.styleIds] : null;
  aiSession.draftVersion = d?.version || 0;
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
  let nextStyleIds: string[] | null | undefined;
  if ("draftStyleIds" in p) {
    if (p.draftStyleIds === null) nextStyleIds = null;
    else if (
      Array.isArray(p.draftStyleIds) &&
      p.draftStyleIds.length <= 6 &&
      p.draftStyleIds.every((id: unknown) => typeof id === "string" && id.length <= 200)
    ) nextStyleIds = [...new Set<string>(p.draftStyleIds.map((id: string) => id.trim()).filter(Boolean))];
    else return false;
  }
  if (typeof p.text === "string") aiSession.text = p.text;
  if (Array.isArray(p.contexts)) aiSession.contexts = p.contexts;
  if (nextStyleIds !== undefined) aiSession.draftStyleIds = nextStyleIds;
  const saved = saveConversationDraft(userDir, v ?? undefined);
  broadcastSession();
  return { accepted: true, version: saved?.version ?? 0 };
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
if (process.env.ZHUWEN_USER_DATA_DIR?.trim())
  app.setPath("userData", path.resolve(process.env.ZHUWEN_USER_DATA_DIR.trim()));
else if (process.env.ZHUWEN_UI_SMOKE)
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
        if (process.env.ZHUWEN_AI_ECHO === "1") {
          uiSmokeEchoRequest = null;
          uiSmokeEchoServer = createServer((req, res) => {
            const body: Buffer[] = [];
            req.on("data", (chunk: Buffer) => body.push(Buffer.from(chunk)));
            req.on("end", () => {
              try {
                const payload = JSON.parse(Buffer.concat(body).toString("utf8"));
                uiSmokeEchoRequest = {
                  authorization: String(req.headers.authorization || ""),
                  payload,
                };
                const lastUser = [...(Array.isArray(payload.messages) ? payload.messages : [])]
                  .reverse()
                  .find((message: any) => message?.role === "user");
                const responseText = `Echo response: ${String(lastUser?.content || "")}`;
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
                const chunks = Array.from(responseText).reduce((all: string[][], char) => {
                  if (!all.length || all[all.length - 1].length >= 6) all.push([]);
                  all[all.length - 1].push(char);
                  return all;
                }, []);
                let index = 0;
                const sendChunk = () => {
                  if (index >= chunks.length) {
                    res.write("data: [DONE]\n\n");
                    res.end();
                    return;
                  }
                  const content = chunks[index++].join("");
                  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
                  setTimeout(sendChunk, 45);
                };
                sendChunk();
              } catch {
                res.writeHead(400);
                res.end("invalid test request");
              }
            });
          });
          await new Promise<void>((resolve, reject) => {
            uiSmokeEchoServer!.once("error", reject);
            uiSmokeEchoServer!.listen(0, "127.0.0.1", resolve);
          });
          const address = uiSmokeEchoServer.address();
          if (!address || typeof address === "string") throw new Error("Local AI echo server did not bind a TCP port");
          uiSmokeEchoBaseUrl = `http://127.0.0.1:${address.port}/v1`;
        }
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
        await js(`document.querySelector('[data-fd-id="workspace-focus-session-trigger"]')?.click()`);
        await wait(120);
        const focusSessionSetupOk = await js(`Boolean(document.querySelector('[data-fd-id="focus-session-setup"]')&&document.querySelector('.focus-session-mode button[aria-pressed="true"]'))`);
        await shot("focus-session-setup");
        await js(`(()=>{document.querySelectorAll('.focus-session-mode button')[0]?.click();[...document.querySelectorAll('.focus-session-start')][0]?.click()})()`);
        await wait(150);
        let focusSessionActiveOk = await js(`Boolean(document.querySelector('[data-fd-id="focus-session-live"]')&&document.querySelector('.focus-session-state.running'))`);
        await js(`document.querySelector('.modal > header button')?.click()`);
        await wait(80);
        await js(`document.querySelector('[data-fd-id="workspace-focus-session-trigger"]')?.click()`);
        await wait(100);
        await js(`([...document.querySelectorAll('.focus-session-actions button')].find(b=>b.textContent.includes('暂停')||b.textContent.includes('Pause')))?.click()`);
        await wait(80);
        const focusSessionPauseOk = await js(`Boolean(document.querySelector('.focus-session-state.paused'))`);
        await js(`([...document.querySelectorAll('.focus-session-actions button')].find(b=>b.textContent.includes('继续专注')||b.textContent.includes('Resume')))?.click()`);
        await wait(80);
        focusSessionActiveOk = focusSessionActiveOk && await js(`Boolean(document.querySelector('.focus-session-state.running'))`);
        await js(`([...document.querySelectorAll('.focus-session-actions button')].find(b=>b.textContent.includes('结束会话')||b.textContent.includes('End session')))?.click()`);
        await wait(120);
        const focusSessionFinishOk = await js(`!document.querySelector('[data-fd-id="focus-session-live"]')&&!document.querySelector('[data-fd-id="focus-session-setup"]')`);
        await js(`(()=>{if(!document.querySelector('.right-panel'))document.querySelector('.topbar .primary.small')?.click()})()`);
        await wait(250);
        const aiOk = await js(
          `Boolean(document.querySelector('.zchat [data-fd-id="ai-composer"]')&&document.querySelector('[data-fd-id="ai-toolbar"]'))`,
        );
        const smokeAiSession: any = await js(`window.zhuwen.invoke('ai:session:get').then(r=>r.data||{})`);
        const smokeAiNovel: any = smokeAiSession.novelId
          ? db.prepare("SELECT id FROM novels WHERE id=?").get(smokeAiSession.novelId)
          : db.prepare("SELECT id FROM novels WHERE title=?").get("界面测试作品");
        const smokeAiChapter: any = smokeAiSession.chapter?.id && smokeAiNovel
          ? db.prepare("SELECT id FROM chapters WHERE id=? AND novel_id=?").get(smokeAiSession.chapter.id, smokeAiNovel.id)
          : null;
        let regenerateUiOk = false;
        const regenerateDiagnostics: Record<string, unknown> = {
          activeNovelId: smokeAiSession.novelId,
          activeChapterId: smokeAiSession.chapter?.id,
          seededNovelId: smokeAiNovel?.id,
          seededChapterId: smokeAiChapter?.id,
        };
        if (smokeAiNovel && smokeAiChapter) {
          const sourceConvId = randomUUID();
          const sourcePromptId = randomUUID();
          const sourceReplyId = randomUUID();
          const createdAt = timestamp();
          db.prepare("INSERT INTO ai_conversations(id,novel_id,chapter_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)")
            .run(sourceConvId, smokeAiNovel.id, smokeAiChapter.id, "UI smoke regeneration", createdAt, createdAt);
          db.prepare("INSERT INTO ai_messages(id,conversation_id,role,content,chapter_id,created_at) VALUES(?,?,?,?,?,?)")
            .run(sourcePromptId, sourceConvId, "user", "UI smoke: regenerate this exact prompt", smokeAiChapter.id, createdAt);
          db.prepare("INSERT INTO ai_messages(id,conversation_id,role,content,chapter_id,created_at) VALUES(?,?,?,?,?,?)")
            .run(sourceReplyId, sourceConvId, "assistant", "Original response remains in its source conversation.", smokeAiChapter.id, createdAt);
          const bridgeReady = await js(`typeof window.zhuwen.__uiSmokeGetLastAiSend==='function'`);
          regenerateDiagnostics.bridgeReady = bridgeReady;
          if (bridgeReady) {
            await js(`window.zhuwen.invoke('ai:session:patch',{connectionId:'ui-smoke-no-network'})`);
            await js(`window.zhuwen.invoke('ai:session:loadConversation','${sourceConvId}')`);
            let sourceReplyReady = false;
            for (let i = 0; i < 20 && !sourceReplyReady; i++) {
              sourceReplyReady = await js(`Boolean([...document.querySelectorAll('.zchat-msg.assistant .zchat-msg-content')].some(el=>el.textContent.includes('Original response remains in its source conversation.')))`);
              if (!sourceReplyReady) await wait(100);
            }
            regenerateDiagnostics.sourceReplyReady = sourceReplyReady;
            await js(`document.querySelector('.zchat-msg.assistant [data-fd-id="ai-retry-options"]')?.click()`);
            await wait(80);
            const retryMenuOk = await js(`Boolean(document.querySelector('[data-fd-id="ai-regenerate-branch"]')&&document.querySelector('[data-fd-id="ai-edit-prompt-branch"]'))`);
            regenerateDiagnostics.retryMenuOk = retryMenuOk;
            await shot("ai-retry-options");
            await js(`document.querySelector('[data-fd-id="ai-regenerate-branch"]')?.click()`);
            let retrySent = false;
            let echoReplyReady = false;
            let echoStreamingObserved = false;
            let echoReplyText = "";
            for (let i = 0; i < 160 && !echoReplyReady; i++) {
              retrySent = await js(`Boolean(window.zhuwen.__uiSmokeGetLastAiSend()?.prompt)`);
              const visible = await js(`(()=>{const content=[...document.querySelectorAll('.zchat-msg.assistant .zchat-msg-content')].map(el=>el.textContent||'').find(text=>text.includes('Echo response:'));return {streaming:Boolean(document.querySelector('.zchat-msg.assistant .zchat-cursor')),content:content||''}})()`);
              echoStreamingObserved ||= Boolean(visible.streaming);
              echoReplyText = String(visible.content || "");
              echoReplyReady = echoReplyText.includes("Echo response: UI smoke: regenerate this exact prompt");
              if (!echoReplyReady) await wait(50);
            }
            regenerateDiagnostics.retrySent = retrySent;
            regenerateDiagnostics.echoStreamingObserved = echoStreamingObserved;
            regenerateDiagnostics.echoReplyReady = echoReplyReady;
            regenerateDiagnostics.echoReplyText = echoReplyText;
            regenerateDiagnostics.toast = await js(`document.querySelector('.toast')?.textContent||''`);
            regenerateDiagnostics.currentSession = await js(`window.zhuwen.invoke('ai:session:get').then(r=>({conversationId:r.data?.conversationId,novelId:r.data?.novelId,chapterId:r.data?.chapter?.id}))`);
            regenerateDiagnostics.branchRows = db.prepare("SELECT id,title FROM ai_conversations WHERE novel_id=? AND title LIKE '%分支%' ORDER BY created_at DESC LIMIT 2").all(smokeAiNovel.id);
            regenerateDiagnostics.sentPayload = retrySent ? await js(`({prompt:window.zhuwen.__uiSmokeGetLastAiSend()?.prompt,conversationId:window.zhuwen.__uiSmokeGetLastAiSend()?.conversationId,connectionId:window.zhuwen.__uiSmokeGetLastAiSend()?.connectionId})`) : null;
            const currentSessionForEcho = regenerateDiagnostics.currentSession as { conversationId?: string } | null;
            const branchId = String(currentSessionForEcho?.conversationId || "");
            const savedEchoReply: any = branchId
              ? db.prepare("SELECT content,incomplete FROM ai_messages WHERE conversation_id=? AND role='assistant' AND content LIKE 'Echo response:%' ORDER BY rowid DESC LIMIT 1").get(branchId)
              : null;
            const savedOriginalPrompt: any = branchId
              ? db.prepare("SELECT content FROM ai_messages WHERE conversation_id=? AND role='user' ORDER BY rowid DESC LIMIT 1").get(branchId)
              : null;
            const echoPayload = uiSmokeEchoRequest?.payload;
            const echoLastUser = [...(Array.isArray(echoPayload?.messages) ? echoPayload.messages : [])]
              .reverse()
              .find((message: any) => message?.role === "user");
            const echoTransportOk = Boolean(
              uiSmokeEchoRequest?.authorization === "Bearer ui-smoke-key" &&
              echoPayload?.stream === true &&
              echoLastUser?.content === "UI smoke: regenerate this exact prompt",
            );
            const echoPersistenceOk = Boolean(
              savedEchoReply && Number(savedEchoReply.incomplete || 0) === 0 &&
              savedEchoReply.content === "Echo response: UI smoke: regenerate this exact prompt" &&
              savedOriginalPrompt?.content === "UI smoke: regenerate this exact prompt",
            );
            regenerateDiagnostics.echoTransportOk = echoTransportOk;
            regenerateDiagnostics.echoPersistenceOk = echoPersistenceOk;
            regenerateUiOk = sourceReplyReady && retryMenuOk && retrySent && echoReplyReady && echoStreamingObserved && echoTransportOk && echoPersistenceOk && await js(
              `window.zhuwen.__uiSmokeGetLastAiSend().prompt==='UI smoke: regenerate this exact prompt'&&window.zhuwen.__uiSmokeGetLastAiSend().conversationId!=='${sourceConvId}'&&window.zhuwen.__uiSmokeGetLastAiSend().connectionId==='ui-smoke-no-network'`,
            );
          }
        }
        await js(`document.querySelector('[data-fd-id="ai-style-menu"]')?.click()`);
        await wait(100);
        await js(`([...document.querySelectorAll('.zchat-menu-item')].find(button=>/查看与管理风格卡|View and manage style cards/.test(button.textContent))?.click())`);
        await wait(180);
        await js(`document.querySelector('.zchat-style-select')?.click()`);
        await wait(80);
        const aiStyleManagerOk = await js(
          `(()=>{const list=document.querySelector('.zchat-style-list');const actions=[...document.querySelectorAll('.zchat-style-row-actions button')];return Boolean(document.querySelector('[data-fd-id="ai-style-presets"]')&&list?.querySelector('.zchat-style-check.selected svg')&&actions.length>=2&&actions.every(button=>button.querySelector('svg')&&(button.getAttribute('aria-label')||button.title)))})()`,
        );
        await shot("03-ai-style-manager");
        await js(`document.querySelector('.zchat-style-list')?.scrollIntoView({block:'center'})`);
        await wait(100);
        await shot("03a-ai-style-card-actions");
        await js(`document.querySelector('.modal > header button')?.click()`);
        await wait(120);
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
          `Boolean(document.querySelector('[data-fd-id="ai-history-drawer"]')&&document.querySelector('[data-fd-id="ai-history-scope"]')&&document.querySelector('[data-fd-id="ai-history-novel-scope"]')?.textContent.includes('界面测试作品'))`,
        );
        const historyArchiveScopeOk = await js(
          `(async()=>{const scope=document.querySelector('[data-fd-id="ai-history-scope"]');const archived=[...scope?.querySelectorAll('button')||[]].find(b=>b.textContent.includes('已归档')||b.textContent.includes('Archived'));if(!archived)return false;archived.click();await new Promise(r=>setTimeout(r,80));const switched=archived.getAttribute('aria-pressed')==='true';const active=[...scope.querySelectorAll('button')].find(b=>b!==archived);active?.click();await new Promise(r=>setTimeout(r,80));return switched&&active?.getAttribute('aria-pressed')==='true'})()`,
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
        let managedAiCardReady = false;
        for (let i = 0; i < 12 && !managedAiCardReady; i++) {
          managedAiCardReady = await js(`Boolean(document.querySelector('[data-fd-id="settings-managed-ai"]'))`);
          if (!managedAiCardReady) await wait(120);
        }
        const translatedAiSettingsOk = await js(
          `Boolean([...document.querySelectorAll('.settings h3')].find(h=>h.textContent.includes('AI API connections'))&&[...document.querySelectorAll('.settings h3')].find(h=>h.textContent.includes('Prompt templates')))`,
        );
        const managedAiSettingsOk = managedAiCardReady && await js(
          `(()=>{const managed=document.querySelector('[data-fd-id="settings-managed-ai"]');const generation=document.querySelector('[data-fd-id="settings-generation-options"]');const save=document.querySelector('[data-fd-id="settings-ai-save"]');return Boolean(managed&&!document.querySelector('[data-fd-id="settings-provider-fields"]')&&generation&&getComputedStyle(managed).display==='flex'&&getComputedStyle(generation).display==='grid'&&save?.textContent.includes('Save AI settings'))})()`,
        );
        await shot("01a-settings-ai-managed");
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
        await js(`(()=>{document.querySelector('.toolbar-more').open=true;([...document.querySelectorAll('.toolbar-menu button')].find(b=>b.textContent.includes('导入导出与备份')||b.textContent.includes('Import, export & backup')))?.click()})()`);
        let epubExportReady = false;
        for (let i = 0; i < 15 && !epubExportReady; i++) {
          epubExportReady = await js(`Boolean(document.querySelector('.io-export-actions button:last-child:not(:disabled)'))`);
          if (!epubExportReady) await wait(120);
        }
        await js(`document.querySelector('.io-export-actions button:last-child')?.click()`);
        let epubPreviewReady = false;
        for (let i = 0; i < 15 && !epubPreviewReady; i++) {
          epubPreviewReady = await js(`Boolean(document.querySelector('.epub-preview-device-control .zw-select-trigger'))`);
          if (!epubPreviewReady) await wait(120);
        }
        await wait(180);
        await shot("10-epub-reader-preview");
        await js(`document.querySelector('.epub-preview-device-control .zw-select-trigger')?.click()`);
        await wait(100);
        await js(`([...document.querySelectorAll('.zw-select-option')].find(option=>option.textContent.includes('手机')))?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
        await wait(120);
        const epubReaderViewportOk = epubPreviewReady && await js(
          `(()=>{const reader=document.querySelector('.epub-preview-reader');const trigger=document.querySelector('.epub-preview-device-control .zw-select-trigger');return Boolean(reader&&trigger?.textContent.includes('390')&&Math.round(reader.getBoundingClientRect().width)<=390&&reader.getBoundingClientRect().height>200)})()`,
        );
        await shot("10a-epub-reader-phone");
        await js(`document.querySelector('.epub-preview-dialog')?.closest('.modal')?.querySelector('header button')?.click()`);
        await wait(120);
        await js(`document.querySelector('.io')?.closest('.modal')?.querySelector('header button')?.click()`);
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
          `Boolean(document.querySelector('[data-fd-id="ai-menu-rename"]')&&document.querySelector('[data-fd-id="ai-menu-archive"]')&&document.querySelector('[data-fd-id="ai-menu-dock-side"]')&&document.querySelector('[data-fd-id="ai-menu-float"]'))`,
        );
        await js(`document.querySelector('[data-fd-id="ai-menu-dock-side"]')?.click()`);
        await wait(180);
        const aiDockLeftOk = await js(`(()=>{const body=document.querySelector('.workbody'),ai=document.querySelector('.right-panel'),editor=document.querySelector('.editor-area'),tools=document.querySelector('.left-panel');return body?.dataset.aiDock==='left'&&getComputedStyle(ai).order==='0'&&getComputedStyle(editor).order==='1'&&getComputedStyle(tools).order==='2'})()`);
        await shot("06-ai-dock-left");
        await js(`document.querySelector('[data-fd-id="ai-more-menu"]')?.click()`);
        await wait(120);
        await js(`document.querySelector('[data-fd-id="ai-menu-dock-side"]')?.click()`);
        await wait(180);
        const aiDockRestoreOk = await js(`document.querySelector('.workbody')?.dataset.aiDock==='right'`);
        await js(`document.querySelector('[data-fd-id="ai-more-menu"]')?.click()`);
        await wait(120);
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
          regenerateUiOk,
          aiStyleManagerOk,
          pickerOk,
          historyDrawerOk,
          historyArchiveScopeOk,
          historyClosedOk,
          typoOk,
          languageOk,
          translatedSettingsOk,
          translatedAiSettingsOk,
          managedAiSettingsOk,
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
          epubReaderViewportOk,
          homeGoalScopeOk,
          goalScopeOk,
          focusSessionSetupOk,
          focusSessionActiveOk,
          focusSessionPauseOk,
          focusSessionFinishOk,
          reduceMotionOk,
          reduceMotionIndependentOk,
          reduceMotionOffOk,
          mainShared,
          moreMenuOk,
          aiDockLeftOk,
          aiDockRestoreOk,
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
        console.log(`REGENERATE_UI_DIAGNOSTICS ${JSON.stringify(regenerateDiagnostics)}`);
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
          `UI_SMOKE_OK workspace_open editor_input settings_i18n ai_i18n library_i18n ai_managed_settings epub_reader_viewport reference_picker typography_settings daily_goal focus_session database_health find_bar book_search book_search_run writing_stats goal_scope_home goal_scope_workspace reduce_motion_independent confirm_dialog ai_float_shared ai_style_manager_action_icons history_drawer history_archive_scope ai_dock_left ai_dock_restore summary_modal library_kinds relation_graph relation_expand library_detail library_trash ${status} ${out}`,
        );
        closeUiSmokeEchoServer();
        app.exit(0);
      } catch (e) {
        try { fs.mkdirSync(path.dirname(uiSmokeErrorFile), { recursive: true }); fs.writeFileSync(uiSmokeErrorFile, String(e instanceof Error ? e.stack || e.message : e)); } catch {}
        console.error(
          `UI_SMOKE_FAIL ${e instanceof Error ? e.message : String(e)}`,
        );
        closeUiSmokeEchoServer();
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
const AI_HISTORY_TRIM_NOTICE = "[Context management:";
function fitAiHistoryToContextLimit(messages: any[], limit: number) {
  const bounded = messages.map((message) => ({ ...message }));
  let omittedMessages = 0;
  const countChars = (items: any[]) => items.reduce(
    (total, item) => total + Array.from(String(item?.content || "")).length,
    0,
  );
  const notice = () => ({
    role: "system",
    content: `${AI_HISTORY_TRIM_NOTICE} ${omittedMessages} earlier conversation messages were omitted to stay within the ${limit.toLocaleString()}-character limit. Do not assume knowledge of omitted content; ask the user to restate critical details when needed.`,
  });
  while (countChars(bounded) + (omittedMessages ? countChars([notice()]) : 0) > limit) {
    const userIndexes = bounded
      .map((message, index) => message.role === "user" ? index : -1)
      .filter((index) => index >= 0);
    if (userIndexes.length < 2) break;
    const start = userIndexes[0];
    const end = userIndexes[1];
    const removed = bounded.splice(start, end - start);
    if (!removed.length) break;
    omittedMessages += removed.length;
  }
  if (omittedMessages) {
    const firstUser = bounded.findIndex((message) => message.role === "user");
    bounded.splice(firstUser < 0 ? bounded.length : firstUser, 0, notice());
  }
  return { messages: bounded, omittedMessages };
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
function readProjectInstructions(novelId: string) {
  const row: any = get(
    "SELECT instructions FROM novel_ai_instructions WHERE novel_id=?",
    String(novelId || ""),
  );
  return String(row?.instructions || "").trim();
}
function projectInstructionPrompt(instructions: string) {
  const text = String(instructions || "").trim();
  return text
    ? `【当前作品固定指令】这些要求适用于本作品的每次请求；与本轮用户明确任务或已确认作品事实冲突时，以本轮任务和已确认事实为准。\n${text}`
    : "";
}
function addProjectInstructions(messages: any[], systemText: string) {
  if (systemText) messages.splice(1, 0, { role: "system", content: systemText });
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
  const styleIntensity = normalizeStyleIntensity(p?.styleIntensity);
  const instruction = buildTaskAndStyleInstructions(cards, task, styleIntensity);
  const card = cards.length
    ? {
        id: cards[0].id,
        name: cards.map((item: any) => item.name).join(" + "),
        version: Math.max(...cards.map((item: any) => Number(item.version || 1))),
        rules: instruction,
      }
    : null;
  return { card, cards, instruction, styleIntensity };
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
  ipcMain.handle("chapters:chooseImage", async () => {
    try {
      const picked = await dialog.showOpenDialog({
        title: "选择插入正文的图片",
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
        properties: ["openFile"],
      });
      if (picked.canceled || !picked.filePaths[0]) return ok(null);
      const stat = await fs.promises.stat(picked.filePaths[0]);
      if (stat.size <= 0 || stat.size > 3 * 1024 * 1024)
        return fail("图片为空或超过 3 MB，请选择较小的图片");
      const bytes = await fs.promises.readFile(picked.filePaths[0]);
      if (!bytes.length || bytes.length > 3 * 1024 * 1024)
        return fail("图片为空或超过 3 MB，请选择较小的图片");
      const mime = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        ? "image/png"
        : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          ? "image/jpeg"
          : bytes.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)
            ? "image/gif"
            : bytes.subarray(0, 2).toString("ascii") === "BM"
              ? "image/bmp"
              : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
                ? "image/webp"
                : "";
      if (!mime) return fail("无法识别该图片格式，请选择有效的 PNG、JPEG、WebP、GIF 或 BMP 图片");
      return ok({ dataUrl: `data:${mime};base64,${bytes.toString("base64")}` });
    } catch (error) {
      return fail(error);
    }
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

  ipcMain.handle("world:presence", (_, p) => {
    const novelId = String(p?.novelId || "");
    const includeMatches = Boolean(p?.includeMatches);
    if (!novelId) return fail("作品信息无效");
    const entities: any[] = all(
      "SELECT id,title,content_json FROM library_items WHERE novel_id=? AND kind='world' AND deleted_at IS NULL ORDER BY sort_order,title,id",
      novelId,
    ).flatMap((row: any) => {
      let data: any = {};
      try { data = JSON.parse(row.content_json || "{}"); } catch {}
      const category = String(data.category || "").trim();
      if (category !== "地点" && category !== "势力") return [];
      const aliases = Array.isArray(data.alias) ? data.alias : String(data.alias || "").split(/[,，、;；]+/);
      const terms = [...new Map([row.title, ...aliases]
        .map((term: unknown) => String(term || "").trim())
        .filter((term: string) => term.length >= 2)
        .map((term: string) => [term.toLocaleLowerCase(), term])).values()];
      return [{ id: row.id, title: row.title, category, terms }];
    });
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(entities.map(({ id, category, terms }) => [id, category, terms])))
      .digest("hex");
    const chapters: any[] = all(
      `SELECT c.id,c.title,c.data_version,c.sort_order,v.sort_order volume_sort_order FROM chapters c
       LEFT JOIN volumes v ON v.id=c.volume_id
       WHERE c.novel_id=? AND c.deleted_at IS NULL
       ORDER BY COALESCE(v.sort_order,-1),c.sort_order,c.id`,
      novelId,
    );
    const indexedRows: any[] = all(
      "SELECT chapter_id,chapter_data_version,entity_fingerprint FROM world_chapter_mention_index WHERE novel_id=?",
      novelId,
    );
    const indexed = new Map(indexedRows.map((row) => [row.chapter_id, row]));
    const staleChapters = chapters.filter((chapter) => {
      const state: any = indexed.get(chapter.id);
      return !state || Number(state.chapter_data_version) !== Number(chapter.data_version) || state.entity_fingerprint !== fingerprint;
    });
    if (staleChapters.length) {
      const clearChapter = db.prepare("DELETE FROM world_chapter_mentions WHERE chapter_id=?");
      const addMention = db.prepare("INSERT INTO world_chapter_mentions(novel_id,world_id,chapter_id,mention_count,first_offset,matched_terms_json) VALUES(?,?,?,?,?,?)");
      const saveState = db.prepare("INSERT INTO world_chapter_mention_index(chapter_id,novel_id,chapter_data_version,entity_fingerprint,indexed_at) VALUES(?,?,?,?,?) ON CONFLICT(chapter_id) DO UPDATE SET novel_id=excluded.novel_id,chapter_data_version=excluded.chapter_data_version,entity_fingerprint=excluded.entity_fingerprint,indexed_at=excluded.indexed_at");
      db.transaction(() => {
        for (const chapter of staleChapters) {
          const body: any = get("SELECT plain_text FROM chapters WHERE id=? AND deleted_at IS NULL", chapter.id);
          const text = String(body?.plain_text || "");
          clearChapter.run(chapter.id);
          for (const entity of entities) {
            const alternatives = entity.terms.slice().sort((a: string, b: string) => b.length - a.length)
              .map((term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            const matcher = alternatives.length ? new RegExp(`(?:${alternatives.join("|")})`, "gi") : null;
            const termByLower = new Map<string, string>(entity.terms.map((term: string) => [term.toLocaleLowerCase(), term]));
            const matchedTerms = new Set<string>();
            let count = 0;
            let firstOffset = -1;
            let match: RegExpExecArray | null;
            while (matcher && (match = matcher.exec(text)) !== null) {
              if (firstOffset < 0) firstOffset = match.index;
              count++;
              const matchedTerm = termByLower.get(match[0].toLocaleLowerCase());
              if (matchedTerm) matchedTerms.add(matchedTerm);
            }
            if (count) addMention.run(novelId, entity.id, chapter.id, count, firstOffset, JSON.stringify([...matchedTerms]));
          }
          saveState.run(chapter.id, novelId, Number(chapter.data_version), fingerprint, timestamp());
        }
      })();
    }
    const summaryRows: any[] = all(
      `WITH chapter_order AS (
         SELECT c.id,ROW_NUMBER() OVER (ORDER BY COALESCE(v.sort_order,-1),c.sort_order,c.id)-1 AS chapter_index
         FROM chapters c LEFT JOIN volumes v ON v.id=c.volume_id
         WHERE c.novel_id=? AND c.deleted_at IS NULL
       )
       SELECT m.world_id,COUNT(*) appearances,SUM(m.mention_count) mentions,MAX(o.chapter_index) last_index
       FROM world_chapter_mentions m JOIN chapter_order o ON o.id=m.chapter_id
       WHERE m.novel_id=? GROUP BY m.world_id`,
      novelId,
      novelId,
    );
    const summaryByEntity = new Map(summaryRows.map((row) => [row.world_id, row]));
    const selectedId = includeMatches ? String(p?.worldId || "") : "";
    const presence: Record<string, any> = {};
    for (const entity of entities) {
      if (includeMatches && entity.id !== selectedId) continue;
      const summary: any = summaryByEntity.get(entity.id);
      const value: any = {
        appearances: Number(summary?.appearances || 0),
        mentions: Number(summary?.mentions || 0),
        sinceLast: summary ? chapters.length - 1 - Number(summary.last_index) : chapters.length,
      };
      if (includeMatches) {
        const rows: any[] = all(
          `SELECT m.chapter_id,m.mention_count,m.first_offset,m.matched_terms_json,c.title chapter_title,c.plain_text
           FROM world_chapter_mentions m JOIN chapters c ON c.id=m.chapter_id
           LEFT JOIN volumes v ON v.id=c.volume_id
           WHERE m.novel_id=? AND m.world_id=? AND c.deleted_at IS NULL
           ORDER BY COALESCE(v.sort_order,-1) DESC,c.sort_order DESC,c.id DESC LIMIT 200`,
          novelId,
          entity.id,
        ).reverse();
        value.matches = rows.map((row) => {
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
      presence[entity.id] = value;
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
    const chapterTotal = Number(
      (get("SELECT COUNT(*) total FROM chapters WHERE novel_id=? AND deleted_at IS NULL", p.novelId) as any)?.total || 0,
    );
    const libraryTotal = Number(
      (get("SELECT COUNT(*) total FROM library_items WHERE novel_id=? AND deleted_at IS NULL", p.novelId) as any)?.total || 0,
    );
    const total = chapterTotal + libraryTotal;
    let scanned = 0;
    let cursorSort: number | null = null;
    let cursorId = "";
    try {
      event.sender.send("search:progress", { requestId, scanned, total, matches: 0 });
      while (scanned < chapterTotal && !task.cancelled) {
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
            resultType: "chapter",
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
      let libraryCursor: { kind: string; sort_order: number; id: string } | null = null;
      while (scanned < total && !task.cancelled) {
        const rows: any[] = libraryCursor === null
          ? all(
              "SELECT id,title,kind,content_json,tags_json,sort_order FROM library_items WHERE novel_id=? AND deleted_at IS NULL ORDER BY kind,sort_order,id LIMIT 48",
              p.novelId,
            )
          : all(
              "SELECT id,title,kind,content_json,tags_json,sort_order FROM library_items WHERE novel_id=? AND deleted_at IS NULL AND (kind>? OR (kind=? AND (sort_order>? OR (sort_order=? AND id>?)))) ORDER BY kind,sort_order,id LIMIT 48",
              p.novelId,
              libraryCursor.kind,
              libraryCursor.kind,
              libraryCursor.sort_order,
              libraryCursor.sort_order,
              libraryCursor.id,
            );
        if (!rows.length) break;
        for (const row of rows) {
          let content: unknown = {};
          try { content = JSON.parse(String(row.content_json || "{}")); } catch { content = {}; }
          const textParts: string[] = [String(row.title || "")];
          const collectText = (value: unknown, key = "") => {
            if (["id", "chapterId", "chapter_id", "archivedAt", "createdAt", "updatedAt"].includes(key)) return;
            if (typeof value === "string") {
              if (value.trim()) textParts.push(value);
            } else if (Array.isArray(value)) {
              for (const item of value) collectText(item, key);
            } else if (value && typeof value === "object") {
              for (const [childKey, childValue] of Object.entries(value)) collectText(childValue, childKey);
            }
          };
          collectText(content);
          try {
            const tags = JSON.parse(String(row.tags_json || "[]"));
            collectText(tags, "tags");
          } catch { /* Invalid legacy tags should not stop a project search. */ }
          const text = textParts.join("\n");
          const hay = text.toLowerCase();
          let idx = hay.indexOf(lower);
          if (idx !== -1) {
            let count = 0;
            while (idx !== -1) {
              count++;
              idx = hay.indexOf(lower, idx + lower.length);
            }
            const first = hay.indexOf(lower);
            const start = Math.max(0, first - 24);
            out.push({
              resultType: "library",
              sourceId: row.id,
              kind: row.kind,
              title: row.title,
              count,
              snippet: (start > 0 ? "…" : "") + text.slice(start, first + query.length + 48) + (first + query.length + 48 < text.length ? "…" : ""),
            });
          }
        }
        scanned += rows.length;
        const cursor = rows[rows.length - 1];
        libraryCursor = { kind: String(cursor.kind), sort_order: Number(cursor.sort_order), id: String(cursor.id) };
        event.sender.send("search:progress", { requestId, scanned, total, matches: out.length });
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
      const current: any = get("SELECT * FROM library_items WHERE id=? AND deleted_at IS NULL", String(p.id));
      if (!current) return fail("资料不存在或已移入回收站");
      const contentJson = JSON.stringify(p.content || {});
      const tagsJson = JSON.stringify(p.tags || []);
      const status = p.status || "idea";
      const chapterId = p.chapterId || null;
      if (current.kind === "scene" && (
        current.title !== p.title ||
        current.content_json !== contentJson ||
        current.tags_json !== tagsJson ||
        current.status !== status
      )) saveLibraryItemRevision(current, "before_edit");
      db.prepare(
        "UPDATE library_items SET title=?,content_json=?,tags_json=?,status=?,chapter_id=?,updated_at=?,data_version=data_version+1 WHERE id=?",
      ).run(
        p.title,
        contentJson,
        tagsJson,
        status,
        chapterId,
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
  ipcMain.handle("library:revisions:list", (_, p) => {
    const itemId = String(p?.itemId || "");
    const novelId = String(p?.novelId || "");
    if (!get("SELECT id FROM library_items WHERE id=? AND novel_id=? AND kind='scene'", itemId, novelId))
      return fail("场景不存在");
    return ok(all(
      "SELECT id,item_id,title,status,source,created_at FROM library_item_revisions WHERE item_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
      itemId,
    ));
  });
  ipcMain.handle("library:revisions:create", (_, p) => {
    const itemId = String(p?.itemId || "");
    const novelId = String(p?.novelId || "");
    const item: any = get("SELECT * FROM library_items WHERE id=? AND novel_id=? AND kind='scene' AND deleted_at IS NULL", itemId, novelId);
    if (!item) return fail("场景不存在或已移入回收站");
    return saveLibraryItemRevision(item, "manual");
  });
  ipcMain.handle("library:revisions:preview", (_, p) => {
    const itemId = String(p?.itemId || "");
    const novelId = String(p?.novelId || "");
    const revisionId = String(p?.revisionId || "");
    const row = get(
      "SELECT r.* FROM library_item_revisions r JOIN library_items i ON i.id=r.item_id WHERE r.id=? AND r.item_id=? AND i.novel_id=? AND i.kind='scene'",
      revisionId, itemId, novelId,
    );
    return row ? ok(row) : fail("细纲版本不存在");
  });
  ipcMain.handle("library:revisions:restore", (_, p) => {
    const itemId = String(p?.itemId || "");
    const novelId = String(p?.novelId || "");
    const revisionId = String(p?.revisionId || "");
    return db.transaction(() => {
      const current: any = get("SELECT * FROM library_items WHERE id=? AND novel_id=? AND kind='scene' AND deleted_at IS NULL", itemId, novelId);
      const revision: any = get(
        "SELECT r.* FROM library_item_revisions r JOIN library_items i ON i.id=r.item_id WHERE r.id=? AND r.item_id=? AND i.novel_id=? AND i.kind='scene'",
        revisionId, itemId, novelId,
      );
      if (!current) return fail("场景不存在或已移入回收站");
      if (!revision) return fail("细纲版本不存在");
      saveLibraryItemRevision(current, "before_restore");
      db.prepare(
        "UPDATE library_items SET title=?,content_json=?,tags_json=?,status=?,updated_at=?,data_version=data_version+1 WHERE id=? AND novel_id=?",
      ).run(revision.title, revision.content_json, revision.tags_json, revision.status, timestamp(), itemId, novelId);
      return ok({ id: itemId });
    })();
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
  ipcMain.handle("ai:style-compositions:list", () => {
    const rows: any[] = all("SELECT id,name,description,style_ids_json,updated_at FROM ai_style_compositions ORDER BY name COLLATE NOCASE,id");
    return ok(rows.flatMap((row) => {
      let styleIds: string[] = [];
      try { styleIds = JSON.parse(row.style_ids_json || "[]"); } catch {}
      styleIds = [...new Set(styleIds.map((id) => String(id || "").trim()).filter((id) => Boolean(styleCardRow(id))))];
      if (!styleIds.length) return [];
      return [{ id: row.id, name: row.name, description: row.description, styleIds, updatedAt: row.updated_at }];
    }));
  });
  ipcMain.handle("ai:style-compositions:save", (_, p) => {
    const name = String(p?.name || "").trim();
    const description = String(p?.description || "").trim();
    if (!name || name.length > 80) return fail("组合名称需为 1 到 80 个字符");
    if (description.length > 240) return fail("组合说明不能超过 240 个字符");
    const styleIds = [...new Set<string>((Array.isArray(p?.styleIds) ? p.styleIds : [])
      .map((id: unknown) => String(id || "").trim())
      .filter((id: string) => Boolean(id)))];
    if (!styleIds.length || styleIds.length > 6) return fail("组合需包含 1 到 6 张技法卡");
    if (styleIds.some((id) => !styleCardRow(id))) return fail("组合中包含不存在的技法卡");
    const id = String(p?.id || newId());
    const old = get("SELECT id FROM ai_style_compositions WHERE id=?", id);
    if (p?.id && !old) return fail("要编辑的技法组合不存在");
    const t = timestamp();
    db.prepare("INSERT INTO ai_style_compositions(id,name,description,style_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,style_ids_json=excluded.style_ids_json,updated_at=excluded.updated_at,data_version=data_version+1")
      .run(id, name, description, JSON.stringify(styleIds), t, t);
    return ok({ id, name, description, styleIds });
  });
  ipcMain.handle("ai:style-compositions:delete", (_, id) => {
    const compositionId = String(id || "");
    const row = get("SELECT id FROM ai_style_compositions WHERE id=?", compositionId);
    if (!row) return fail("技法组合不存在");
    db.prepare("DELETE FROM ai_style_compositions WHERE id=?").run(compositionId);
    return ok(true);
  });
  ipcMain.handle("ai:style-compositions:export", async (_, compositionId) => {
    try {
      const composition: any = get("SELECT id,name,description,style_ids_json FROM ai_style_compositions WHERE id=?", String(compositionId || ""));
      if (!composition) return fail("技法组合不存在");
      const styleIds: string[] = JSON.parse(composition.style_ids_json || "[]");
      if (!Array.isArray(styleIds) || styleIds.length < 1 || styleIds.length > 6) throw new Error("组合中的技法卡数量无效");
      const cards = styleIds.map((styleId) => {
        const row: any = get("SELECT id,name,description,tasks_json,rules,builtin FROM ai_style_cards WHERE id=?", String(styleId));
        if (!row) throw new Error("组合包含已不存在的技法卡，请先编辑组合");
        return {
          id: row.id,
          builtin: Boolean(row.builtin),
          name: row.name,
          description: row.description || "",
          tasks: JSON.parse(row.tasks_json || "[]"),
          rules: row.rules || "",
        };
      });
      const safeName = String(composition.name || "写作技法组合").replace(/[<>:"/\\|?*]/g, "_").slice(0, 70);
      const target = await dialog.showSaveDialog({
        title: "导出写作技法组合",
        defaultPath: `${safeName}.zhuwen-style-set.json`,
        filters: [{ name: "铸文写作技法组合", extensions: ["json"] }],
      });
      if (target.canceled || !target.filePath) return ok(null);
      const bundle = {
        format: "zhuwen-ai-style-composition",
        version: 1,
        composition: { name: composition.name, description: composition.description || "", cards },
      };
      await fs.promises.writeFile(target.filePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
      return ok({ file: target.filePath });
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("ai:style-compositions:import", async () => {
    try {
      const target = await dialog.showOpenDialog({
        title: "导入写作技法组合",
        filters: [{ name: "铸文写作技法组合", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (target.canceled || !target.filePaths[0]) return ok(null);
      const file = target.filePaths[0];
      if ((await fs.promises.stat(file)).size > 512 * 1024) throw new Error("技法组合文件过大，无法导入");
      const bundle = parseStyleCompositionBundle(JSON.parse(await fs.promises.readFile(file, "utf8")));
      const mapped = bundle.cards.map((card) => {
        if (card.builtin && get("SELECT id FROM ai_style_cards WHERE id=? AND builtin=1", card.id))
          return { styleId: card.id, card: null as typeof card | null };
        return { styleId: newId(), card };
      });
      const compositionId = newId();
      const now = timestamp();
      db.transaction(() => {
        for (const entry of mapped) {
          if (!entry.card) continue;
          db.prepare("INSERT INTO ai_style_cards(id,name,description,tasks_json,rules,builtin,builtin_version,created_at,updated_at) VALUES(?,?,?,?,?,0,1,?,?)")
            .run(entry.styleId, entry.card.name, entry.card.description, JSON.stringify(entry.card.tasks), entry.card.rules, now, now);
        }
        db.prepare("INSERT INTO ai_style_compositions(id,name,description,style_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
          .run(compositionId, bundle.name, bundle.description, JSON.stringify(mapped.map((entry) => entry.styleId)), now, now);
      })();
      return ok({ id: compositionId, name: bundle.name, description: bundle.description, styleIds: mapped.map((entry) => entry.styleId) });
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("ai:style-selection:get", (_, novelId) => {
    const row: any = get(
      "SELECT style_id,style_ids_json,style_intensity FROM novel_ai_styles WHERE novel_id=?",
      String(novelId || ""),
    );
    let styleIds: string[] = [];
    try { styleIds = JSON.parse(row?.style_ids_json || "[]"); } catch {}
    if (!styleIds.length && row?.style_id) styleIds = [String(row.style_id)];
    const cards = [...new Set(styleIds)].map(styleCardRow).filter(Boolean);
    return ok({ styleIds: cards.map((card: any) => card.id), cards, styleIntensity: normalizeStyleIntensity(row?.style_intensity) });
  });
  ipcMain.handle("ai:project-instructions:get", (_, novelId) => {
    const id = String(novelId || "");
    if (!get("SELECT id FROM novels WHERE id=? AND deleted_at IS NULL", id))
      return fail("作品不存在");
    const row: any = get(
      "SELECT instructions,updated_at FROM novel_ai_instructions WHERE novel_id=?",
      id,
    );
    return ok({ instructions: String(row?.instructions || ""), updatedAt: row?.updated_at || null });
  });
  ipcMain.handle("ai:project-instructions:set", (_, p) => {
    const novelId = String(p?.novelId || "");
    if (!get("SELECT id FROM novels WHERE id=? AND deleted_at IS NULL", novelId))
      return fail("作品不存在");
    const instructions = String(p?.instructions || "").trim();
    if (Array.from(instructions).length > 8000)
      return fail("作品指令最多 8000 个字符");
    const updatedAt = timestamp();
    db.prepare(
      "INSERT INTO novel_ai_instructions(novel_id,instructions,updated_at) VALUES(?,?,?) ON CONFLICT(novel_id) DO UPDATE SET instructions=excluded.instructions,updated_at=excluded.updated_at,data_version=data_version+1",
    ).run(novelId, instructions, updatedAt);
    return ok({ instructions, updatedAt });
  });
  ipcMain.handle("ai:style-selection:set", (_, p) => {
    const novelId = String(p?.novelId || "");
    if (!get("SELECT id FROM novels WHERE id=?", novelId)) return fail("作品不存在");
    const rawIds = Array.isArray(p?.styleIds) ? p.styleIds : p?.styleId ? [p.styleId] : [];
    const styleIds: string[] = [...new Set<string>(rawIds.map((id: unknown) => String(id || "").trim()).filter((id: string) => Boolean(id)))];
    if (styleIds.length > 6) return fail("每个作品最多组合 6 张技法卡");
    const cards = styleIds.map(styleCardRow);
    if (cards.some((card) => !card)) return fail("写作风格不存在");
    const styleIntensity = normalizeStyleIntensity(p?.styleIntensity);
    const styleId = styleIds[0] || "";
    db.prepare(
      "INSERT INTO novel_ai_styles(novel_id,style_id,updated_at,style_ids_json,style_intensity) VALUES(?,?,?,?,?) ON CONFLICT(novel_id) DO UPDATE SET style_id=excluded.style_id,style_ids_json=excluded.style_ids_json,style_intensity=excluded.style_intensity,updated_at=excluded.updated_at,data_version=data_version+1",
    ).run(novelId, styleId || null, timestamp(), JSON.stringify(styleIds), styleIntensity);
    return ok({ styleIds, cards, styleIntensity });
  });
  ipcMain.handle("ai:style:estimate", (_, p) => {
    const style = requestStyle(p);
    return ok({ chars: style.instruction.length, instruction: style.instruction, styleIds: style.cards.map((card: any) => card.id), styleNames: style.cards.map((card: any) => card.name), styleIntensity: style.styleIntensity, taskKind: p?.taskKind || "chat" });
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
      const compositions: any[] = all("SELECT id,style_ids_json FROM ai_style_compositions");
      for (const composition of compositions) {
        let ids: string[] = [];
        try { ids = JSON.parse(composition.style_ids_json || "[]"); } catch {}
        const remaining = ids.filter((styleId) => styleId !== String(id));
        if (!remaining.length) db.prepare("DELETE FROM ai_style_compositions WHERE id=?").run(composition.id);
        else if (remaining.length !== ids.length)
          db.prepare("UPDATE ai_style_compositions SET style_ids_json=?,updated_at=?,data_version=data_version+1 WHERE id=?")
            .run(JSON.stringify(remaining), timestamp(), composition.id);
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
    const archivedAtFilter = p?.archived === true ? "IS NOT NULL" : "IS NULL";
    const like = `%${search}%`;
    const rows = search
      ? all(
          `SELECT c.*,
            (SELECT substr(m.content,1,120) FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_snippet,
            (SELECT m.incomplete FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_incomplete,
            (SELECT m.role FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_role
           FROM ai_conversations c
           WHERE c.novel_id=? AND c.deleted_at IS NULL AND c.archived_at ${archivedAtFilter}
             AND (c.title LIKE ? OR EXISTS (SELECT 1 FROM ai_messages m WHERE m.conversation_id=c.id AND m.content LIKE ?))
           ORDER BY c.pinned DESC, c.updated_at DESC, c.id DESC
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
           WHERE c.novel_id=? AND c.deleted_at IS NULL AND c.archived_at ${archivedAtFilter}
           ORDER BY c.pinned DESC, c.updated_at DESC, c.id DESC
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
         WHERE c.novel_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL
         ORDER BY c.pinned DESC, c.updated_at DESC, c.id DESC
         LIMIT 50`,
        novelId,
      );
      for (const w of [win, floatWin]) {
        if (w && !w.isDestroyed())
          w.webContents.send("ai:conversations:list", { novelId, rows });
      }
    } catch {}
  }
  ipcMain.handle("ai:conversation:pin", (_, p) => {
    const id = String(p?.id || "").trim();
    const conversation: any = get("SELECT novel_id FROM ai_conversations WHERE id=? AND deleted_at IS NULL", id);
    if (!id || !conversation || String(conversation.novel_id) !== String(aiSession.novelId || ""))
      return fail("对话不存在或不属于当前作品");
    const pinned = p?.pinned === true ? 1 : 0;
    db.prepare("UPDATE ai_conversations SET pinned=?,data_version=data_version+1 WHERE id=?")
      .run(pinned, id);
    broadcastConversations(String(conversation.novel_id));
    return ok({ id, pinned: Boolean(pinned) });
  });
  ipcMain.handle("ai:conversation:archive", (_, p) => {
    const id = String(p?.id || "").trim();
    const conversation: any = get("SELECT novel_id FROM ai_conversations WHERE id=? AND deleted_at IS NULL", id);
    if (!id || !conversation || String(conversation.novel_id) !== String(aiSession.novelId || ""))
      return fail("对话不存在或不属于当前作品");
    const archived = p?.archived === true;
    if (archived && aiSession.generatingConversationId === id)
      return fail("请等待当前回复完成后再归档对话");
    const changedAt = timestamp();
    if (archived) {
      db.prepare("UPDATE ai_conversations SET archived_at=?,data_version=data_version+1 WHERE id=?")
        .run(changedAt, id);
    } else {
      db.prepare("UPDATE ai_conversations SET archived_at=NULL,updated_at=?,data_version=data_version+1 WHERE id=?")
        .run(changedAt, id);
    }
    broadcastConversations(String(conversation.novel_id));
    return ok({ id, archived });
  });
  ipcMain.handle("ai:conversation:status", (_, id) => {
    const conversation: any = get(
      "SELECT archived_at,title FROM ai_conversations WHERE id=? AND novel_id=? AND deleted_at IS NULL",
      String(id || ""),
      String(aiSession.novelId || ""),
    );
    if (!conversation) return ok({ archived: false });
    return ok({ archived: Boolean(conversation.archived_at), title: String(conversation.title || "") });
  });
  ipcMain.handle("ai:conversation:update", (_, p) => {
    if (!p?.title?.trim()) return fail("会话名称不能为空");
    db.prepare(
      "UPDATE ai_conversations SET title=?,updated_at=?,data_version=data_version+1 WHERE id=?",
    ).run(p.title.trim(), timestamp(), p.id);
    return ok(true);
  });
  ipcMain.handle("ai:conversation:branch", (_, messageId) => {
    if (aiSession.generating) return fail("请等待当前回复完成后再创建分支");
    const targetId = String(messageId || "");
    const target: any = get(
      `SELECT m.id,m.conversation_id,m.role,m.chapter_id AS message_chapter_id,c.novel_id,c.chapter_id,c.title
       FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id
       WHERE m.id=? AND c.deleted_at IS NULL`,
      targetId,
    );
    if (!target || target.role !== "user") return fail("找不到这条用户提问，无法创建分支");
    if (target.novel_id !== aiSession.novelId) return fail("这条提问不属于当前小说项目");

    const sourceRows: any[] = all(
      `SELECT rowid AS source_rowid,* FROM ai_messages
       WHERE conversation_id=? ORDER BY created_at,rowid`,
      target.conversation_id,
    );
    const targetIndex = sourceRows.findIndex((row) => row.id === targetId);
    if (targetIndex < 0) return fail("找不到这条提问，无法创建分支");
    const historyRows = sourceRows.slice(0, targetIndex);
    const historyIds = historyRows.map((row) => String(row.id));
    const snapshots: any[] = historyIds.length
      ? all(
          `SELECT * FROM message_context_snapshots
           WHERE message_id IN (${historyIds.map(() => "?").join(",")})
           ORDER BY created_at,rowid`,
          ...historyIds,
        )
      : [];
    const branchId = randomUUID();
    const branchTitle = `${String(target.title || "新对话").trim() || "新对话"} · 分支`;
    const createdAt = timestamp();
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO ai_conversations(id,novel_id,chapter_id,title,created_at,updated_at)
           VALUES(?,?,?,?,?,?)`,
        ).run(branchId, target.novel_id, target.message_chapter_id || target.chapter_id || null, branchTitle, createdAt, createdAt);

        const messageColumns = (db.prepare("PRAGMA table_info(ai_messages)").all() as any[])
          .map((column) => String(column.name))
          .filter((name) => name !== "id" && name !== "conversation_id" && name !== "data_version");
        const messageSql = `INSERT INTO ai_messages(id,conversation_id,${messageColumns.join(",")},data_version)
          VALUES(${Array(messageColumns.length + 3).fill("?").join(",")})`;
        const messageInsert = db.prepare(messageSql);
        const clonedIds = new Map<string, string>();
        for (const row of historyRows) {
          const clonedId = randomUUID();
          clonedIds.set(String(row.id), clonedId);
          messageInsert.run(
            clonedId,
            branchId,
            ...messageColumns.map((column) => row[column]),
            1,
          );
        }

        const snapshotColumns = (db.prepare("PRAGMA table_info(message_context_snapshots)").all() as any[])
          .map((column) => String(column.name))
          .filter((name) => name !== "id" && name !== "message_id" && name !== "data_version");
        const snapshotSql = `INSERT INTO message_context_snapshots(id,message_id,${snapshotColumns.join(",")},data_version)
          VALUES(${Array(snapshotColumns.length + 3).fill("?").join(",")})`;
        const snapshotInsert = db.prepare(snapshotSql);
        for (const row of snapshots) {
          const clonedMessageId = clonedIds.get(String(row.message_id));
          if (!clonedMessageId) continue;
          snapshotInsert.run(
            randomUUID(),
            clonedMessageId,
            ...snapshotColumns.map((column) => row[column]),
            1,
          );
        }
      })();
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    broadcastConversations(String(target.novel_id));
    return ok({ conversationId: branchId, title: branchTitle });
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
      resetAiSessionMessageWindow();
      aiSession.generating = false;
      aiSession.requestId = "";
      broadcastSession();
    }
    broadcastConversations(String(aiSession.novelId || ""));
    return ok(true);
  });
  ipcMain.handle("ai:conversation:export", async (_, id) => {
    try {
      const conversationId = String(id || "").trim();
      if (!conversationId) return fail("没有可导出的对话");
      const conversation: any = get(
        "SELECT title FROM ai_conversations WHERE id=? AND deleted_at IS NULL",
        conversationId,
      );
      if (!conversation) return fail("对话不存在或已删除");
      const messages: any[] = all(
        "SELECT role,content,created_at,incomplete FROM ai_messages WHERE conversation_id=? ORDER BY created_at,rowid",
        conversationId,
      );
      if (!messages.length) return fail("空对话没有可导出的消息");
      const target = await dialog.showSaveDialog({
        title: "导出 AI 对话",
        defaultPath: safeConversationFilename(String(conversation.title || "")),
        filters: [{ name: "Markdown 文档", extensions: ["md"] }],
      });
      if (target.canceled || !target.filePath) return ok(null);
      await fs.promises.writeFile(
        target.filePath,
        formatConversationMarkdown(String(conversation.title || ""), messages),
        "utf8",
      );
      return ok({ file: target.filePath });
    } catch (error) {
      return fail(error);
    }
  });
  ipcMain.handle("ai:previewRequest", (_, p) => {
    const history = withWriterPersona(conversationHistory(String(p?.conversationId || "")));
    addProjectInstructions(
      history,
      projectInstructionPrompt(readProjectInstructions(String(p?.novelId || ""))),
    );
    const prefix = contextText(p?.contexts || []);
    const style = requestStyle(p);
    if (style.instruction) history.splice(1, 0, { role: "system", content: style.instruction });
    history.push({
      role: "user",
      content: (prefix ? `${prefix}\n\n` : "") + String(p?.prompt || ""),
    });
    return ok(fitAiHistoryToContextLimit(history, ZHUWEN_MAX_CONTEXT_CHARS).messages);
  });
  ipcMain.handle("ai:send", async (_event, p) => {
    const requestId = p.requestId || randomUUID(),
      controller = new AbortController();
    let conv = String(p.conversationId || "");
    let isNewConversation = false;
    let content = "";
    let connection: any = null;
    let projectInstructionSnapshot = "";
    const style = requestStyle(p);
    let assistantSaved = false;
    requests.set(requestId, controller);
    try {
      if (!conv) {
        conv = newId();
        isNewConversation = true;
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
      } else {
        const existing: any = get("SELECT novel_id,archived_at FROM ai_conversations WHERE id=? AND deleted_at IS NULL", conv);
        if (!existing || String(existing.novel_id) !== String(p.novelId || ""))
          return fail("对话不存在或不属于当前作品");
        if (existing.archived_at) {
          db.prepare("UPDATE ai_conversations SET archived_at=NULL,updated_at=?,data_version=data_version+1 WHERE id=?")
            .run(timestamp(), conv);
          broadcastConversations(String(existing.novel_id));
        }
      }
      projectInstructionSnapshot = projectInstructionPrompt(
        readProjectInstructions(String(p.novelId || "")),
      );
      const uid = newId(),
        t = timestamp();
      db.prepare(
        "INSERT INTO ai_messages(id,conversation_id,role,content,model,connection_id,chapter_id,source_revision,selection_text,selection_from,selection_to,task_kind,style_id,style_name,style_version,style_rules,style_ids_json,project_instructions,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
        JSON.stringify(style.cards.map((card: any) => String(card.id))),
        projectInstructionSnapshot,
        t,
      );
      aiSession.novelId = p.novelId ?? aiSession.novelId;
      aiSession.connectionId = p.connectionId || aiSession.connectionId;
      if (isNewConversation) resetAiSessionMessageWindow();
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
          project_instructions: projectInstructionSnapshot,
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
      trimAiSessionMessageWindow();
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
      addProjectInstructions(history, projectInstructionSnapshot);
      if (style.instruction) history.splice(1, 0, { role: "system", content: style.instruction });
      const requestHistory = fitAiHistoryToContextLimit(history, ZHUWEN_MAX_CONTEXT_CHARS).messages;
      const useUiSmokeEcho =
        process.env.ZHUWEN_UI_SMOKE === "1" &&
        process.env.ZHUWEN_AI_ECHO === "1" &&
        p.connectionId === "ui-smoke-no-network";
      connection = useUiSmokeEcho
        ? {
            id: "ui-smoke-echo",
            name: "Local UI smoke echo",
            base_url: uiSmokeEchoBaseUrl,
            model: "ui-smoke-echo",
            temperature: 0,
            max_tokens: 1024,
            timeout_ms: 10000,
            streaming: 1,
          }
        : p.connectionId === ZHUWEN_SERVER_CONNECTION_ID
          ? serverConnection()
          : get("SELECT * FROM api_connections WHERE id=?", p.connectionId);
      const key = useUiSmokeEcho
        ? "ui-smoke-key"
        : p.connectionId === ZHUWEN_SERVER_CONNECTION_ID
          ? requireServerToken()
          : readSecret(userDir, p.connectionId);
      if (!connection || !key) throw new Error("AI 连接或 API Key 未配置");
      for (let attempt = 0; ; attempt++) {
        try {
          await chatRequest(
            connection,
            key,
            requestHistory,
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
    if (p && (typeof p.text === "string" || Array.isArray(p.contexts) || "draftStyleIds" in p)) {
      const accepted = applyDraftPatch(userDir, p);
      if (!accepted || typeof accepted !== "object") return ok({ accepted: false, version: aiSession.draftVersion });
      // 其余字段继续处理
      const rest = { ...p };
      delete rest.text;
      delete rest.contexts;
      delete rest.draftStyleIds;
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
      resetAiSessionMessageWindow();
      aiSession.contexts = [];
      aiSession.text = "";
      aiSession.draftStyleIds = null;
      aiSession.draftVersion = 0;
    }
    if (p && "conversationId" in p && p.conversationId !== prevConv) {
      loadConversationDraft(
        String(aiSession.novelId || ""),
        String(aiSession.conversationId || ""),
      );
    }
    broadcastSession();
    return ok({ accepted: true, version: aiSession.draftVersion });
  });
  ipcMain.handle("ai:session:loadConversation", (_, conversationId) => {
    saveConversationDraft(userDir);
    if (!conversationId) {
      aiSession.conversationId = "";
      resetAiSessionMessageWindow();
    } else {
      aiSession.conversationId = conversationId;
      const descending: any[] = all(
        "SELECT m.*,m.rowid AS _row_order FROM ai_messages m WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
        conversationId,
        AI_SESSION_MESSAGE_WINDOW + 1,
      );
      let hasEarlier = descending.length > AI_SESSION_MESSAGE_WINDOW;
      let rows: any[] = descending.slice(0, AI_SESSION_MESSAGE_WINDOW).reverse();
      if (rows[0]?.role === "assistant") {
        const first = rows[0];
        const previousUser: any = get(
          "SELECT m.*,m.rowid AS _row_order FROM ai_messages m WHERE conversation_id=? AND role='user' AND (created_at<? OR (created_at=? AND rowid<?)) ORDER BY created_at DESC,rowid DESC LIMIT 1",
          conversationId,
          first.created_at,
          first.created_at,
          Number(first._row_order),
        );
        if (previousUser) {
          rows.unshift(previousUser);
        }
      }
      const firstLoadedMessage = rows[0];
      hasEarlier = Boolean(firstLoadedMessage && get(
        "SELECT 1 FROM ai_messages WHERE conversation_id=? AND (created_at<? OR (created_at=? AND rowid<?)) LIMIT 1",
        conversationId,
        firstLoadedMessage.created_at,
        firstLoadedMessage.created_at,
        Number(firstLoadedMessage._row_order),
      ));
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
      aiSession.messages = rows.map((rawRow) => {
        const { _row_order, ...row } = rawRow;
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
      aiSession.messageWindow = {
        hasEarlier,
        beforeMessageId: hasEarlier ? String(aiSession.messages[0]?.id || "") || null : null,
      };
    }
    loadConversationDraft(
      String(aiSession.novelId || ""),
      String(aiSession.conversationId || ""),
    );
    broadcastSession();
    return ok(true);
  });
  ipcMain.handle("ai:conversation:messages:before", (_, p) => {
    const conversationId = String(p?.conversationId || "").trim();
    const novelId = String(p?.novelId || "").trim();
    const beforeMessageId = String(p?.beforeMessageId || "").trim();
    const limit = Math.min(100, Math.max(1, Math.floor(Number(p?.limit) || AI_SESSION_MESSAGE_WINDOW)));
    const conversation: any = get(
      "SELECT id FROM ai_conversations WHERE id=? AND novel_id=? AND deleted_at IS NULL",
      conversationId,
      novelId,
    );
    if (!conversation || novelId !== String(aiSession.novelId || ""))
      return fail("对话不存在或不属于当前作品");
    const cursor: any = get(
      "SELECT id,created_at,rowid AS row_order FROM ai_messages WHERE id=? AND conversation_id=?",
      beforeMessageId,
      conversationId,
    );
    if (!cursor) return fail("历史消息游标无效，请重新打开对话");
    const descending: any[] = all(
      "SELECT m.*,m.rowid AS _row_order FROM ai_messages m WHERE m.conversation_id=? AND (m.created_at<? OR (m.created_at=? AND m.rowid<?)) ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?",
      conversationId,
      cursor.created_at,
      cursor.created_at,
      cursor.row_order,
      limit + 1,
    );
    let hasEarlier = descending.length > limit;
    let rows: any[] = descending.slice(0, limit).reverse();
    if (rows[0]?.role === "assistant") {
      const first = rows[0];
      const previousUser: any = get(
        "SELECT m.*,m.rowid AS _row_order FROM ai_messages m WHERE m.conversation_id=? AND m.role='user' AND (m.created_at<? OR (m.created_at=? AND m.rowid<?)) ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1",
        conversationId,
        first.created_at,
        first.created_at,
        first._row_order,
      );
      if (previousUser) rows.unshift(previousUser);
    }
    const firstLoadedMessage = rows[0];
    hasEarlier = Boolean(firstLoadedMessage && get(
      "SELECT 1 FROM ai_messages WHERE conversation_id=? AND (created_at<? OR (created_at=? AND rowid<?)) LIMIT 1",
      conversationId,
      firstLoadedMessage.created_at,
      firstLoadedMessage.created_at,
      Number(firstLoadedMessage._row_order),
    ));
    const userIds = [...new Set(rows.filter((row) => row.role === "user").map((row) => String(row.id)))];
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
        }))(sourceState(snapshot, novelId)),
      ]);
    }
    let lastSourceMessageId = "";
    let lastSourceRefs: any[] = [];
    const hydrated = rows.map((row) => {
      const { _row_order, ...message } = row;
      if (row.role === "user") {
        lastSourceMessageId = row.id;
        lastSourceRefs = refsByMessage.get(row.id) || [];
        return { ...message, source_message_id: row.id, source_refs: lastSourceRefs };
      }
      return {
        ...message,
        source_message_id: row.role === "assistant" ? lastSourceMessageId : "",
        source_refs: row.role === "assistant" ? lastSourceRefs : [],
      };
    });
    return ok({ rows: hydrated, hasEarlier });
  });
  ipcMain.handle("ai:conversation:read", (_, p) => {
    const conversationId = String(p?.conversationId || "").trim();
    const novelId = String(p?.novelId || "").trim();
    const conversation: any = get(
      "SELECT id,title FROM ai_conversations WHERE id=? AND novel_id=? AND deleted_at IS NULL",
      conversationId,
      novelId,
    );
    if (!conversation || novelId !== String(aiSession.novelId || ""))
      return fail("对话不存在或不属于当前作品");
    const rows: any[] = all(
      "SELECT id,role,content,created_at,incomplete FROM ai_messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 120",
      conversationId,
    ).reverse();
    return ok({ conversation, rows });
  });
  ipcMain.handle("ai:conversation:messages:stats", (_, p) => {
    const conversationId = String(p?.conversationId || "").trim();
    const novelId = String(p?.novelId || "").trim();
    const conversation: any = get(
      "SELECT id FROM ai_conversations WHERE id=? AND novel_id=? AND deleted_at IS NULL",
      conversationId,
      novelId,
    );
    if (!conversation || novelId !== String(aiSession.novelId || ""))
      return fail("对话不存在或不属于当前作品");
    const rows: any[] = all(
      "SELECT content FROM ai_messages WHERE conversation_id=? ORDER BY created_at,rowid",
      conversationId,
    );
    const liveStreamingChars = conversationId === aiSession.conversationId
      ? aiSession.messages.reduce(
          (total, row) => total + (row.streaming ? String(row.content || "").length : 0),
          0,
        )
      : 0;
    return ok({
      messageCount: rows.length,
      characterCount:
        rows.reduce((total, row) => total + String(row.content || "").length, 0) +
        liveStreamingChars,
    });
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
      const ext = ["txt", "md", "docx", "epub", "pdf"].includes(requestedFormat)
        ? requestedFormat
        : "txt";
      const rows: any[] = all(
        `SELECT c.*,v.title volume_title FROM chapters c LEFT JOIN volumes v ON c.volume_id=v.id WHERE c.novel_id=? AND c.deleted_at IS NULL ${p.chapterIds?.length ? `AND c.id IN (${p.chapterIds.map(() => "?").join(",")})` : ""} ORDER BY COALESCE(v.sort_order,-1),c.sort_order`,
        p.novelId,
        ...(p.chapterIds || []),
      );
      if (["epub", "pdf"].includes(ext) && !rows.length)
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
      else if (ext === "pdf") await writePdf(f.filePath, novel, rows, p);
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
function saveLibraryItemRevision(item: any, source: string) {
  const id = newId();
  db.prepare(
    "INSERT INTO library_item_revisions(id,item_id,title,content_json,tags_json,status,source,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    id,
    String(item.id),
    String(item.title || ""),
    String(item.content_json || "{}"),
    String(item.tags_json || "[]"),
    String(item.status || "idea"),
    source,
    timestamp(),
  );
  pruneLibraryItemRevisions(String(item.id));
  return ok({ id });
}
function pruneLibraryItemRevisions(itemId: string) {
  db.prepare(
    `DELETE FROM library_item_revisions WHERE item_id=? AND id NOT IN (
       SELECT id FROM library_item_revisions WHERE item_id=?
       ORDER BY created_at DESC,rowid DESC LIMIT 100)`,
  ).run(itemId, itemId);
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
  const maxContextChars = Number(c.max_context_chars);
  if (Number.isFinite(maxContextChars) && maxContextChars > 0) {
    const payloadChars = messages.reduce(
      (total, message) => total + Array.from(String(message?.content || "")).length,
      0,
    );
    if (payloadChars > maxContextChars)
      throw new Error(`上下文已超过 ${maxContextChars.toLocaleString()} 字上限（当前约 ${payloadChars.toLocaleString()} 字），请减少引用或历史消息。`);
  }
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
    libraryItemRevisions: all(
      "SELECT r.* FROM library_item_revisions r JOIN library_items i ON i.id=r.item_id WHERE i.novel_id=? AND i.kind='scene' ORDER BY r.created_at,r.id",
      novelId,
    ),
    conversations: all(
      "SELECT * FROM ai_conversations WHERE novel_id=?",
      novelId,
    ),
    projectInstructions: String(
      (get(
        "SELECT instructions FROM novel_ai_instructions WHERE novel_id=?",
        novelId,
      ) as any)?.instructions || "",
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
  const selectedStyle: any = get("SELECT style_id,style_ids_json,style_intensity FROM novel_ai_styles WHERE novel_id=?", novelId);
  let styleIds: string[] = [];
  try { styleIds = JSON.parse(selectedStyle?.style_ids_json || "[]"); } catch {}
  if (!styleIds.length && selectedStyle?.style_id) styleIds = [String(selectedStyle.style_id)];
  bundle.styleSelection = [...new Set(styleIds)];
  bundle.styleIntensity = normalizeStyleIntensity(selectedStyle?.style_intensity);
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
    (b.projectInstructions !== undefined &&
      (typeof b.projectInstructions !== "string" ||
        Array.from(b.projectInstructions).length > 8000)) ||
    (b.styleCards !== undefined && !Array.isArray(b.styleCards))
  )
    throw new Error("备份格式或版本不受支持");
  for (const key of [
    "volumes",
    "chapters",
    "revisions",
    "library",
    "libraryItemRevisions",
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
  if (Array.isArray(b.libraryItemRevisions)) {
    const sceneIds = new Set(
      b.library.filter((item: any) => item?.kind === "scene").map((item: any) => item.id),
    );
    for (const revision of b.libraryItemRevisions) {
      if (
        !revision ||
        typeof revision.item_id !== "string" ||
        !sceneIds.has(revision.item_id) ||
        typeof revision.title !== "string" ||
        typeof revision.content_json !== "string" ||
        typeof revision.tags_json !== "string" ||
        typeof revision.status !== "string" ||
        typeof revision.source !== "string" ||
        typeof revision.created_at !== "string"
      )
        throw new Error("备份中的场景细纲历史格式不正确");
    }
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
    const projectInstructions = String(b.projectInstructions || "").trim();
    if (projectInstructions) {
      db.prepare(
        "INSERT INTO novel_ai_instructions(novel_id,instructions,updated_at) VALUES(?,?,?)",
      ).run(novelId, projectInstructions, t);
    }
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
    for (const revision of b.libraryItemRevisions || []) {
      const itemId = libraryMap.get(revision.item_id);
      if (!itemId) continue;
      db.prepare(
        "INSERT INTO library_item_revisions(id,item_id,title,content_json,tags_json,status,source,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        newId(),
        itemId,
        revision.title,
        revision.content_json,
        revision.tags_json,
        revision.status,
        revision.source || "before_edit",
        revision.created_at || t,
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
        "INSERT INTO ai_messages(id,conversation_id,role,content,model,connection_id,chapter_id,source_revision,selection_text,incomplete,task_kind,style_id,style_name,style_version,style_rules,selection_from,selection_to,style_ids_json,project_instructions,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
        m.style_ids_json || JSON.stringify(m.style_id ? [m.style_id] : []),
        m.project_instructions || "",
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
    if (restoredStyleIds.length || b.styleIntensity)
      db.prepare("INSERT INTO novel_ai_styles(novel_id,style_id,updated_at,style_ids_json,style_intensity) VALUES(?,?,?,?,?)")
        .run(novelId, restoredStyleIds[0] || null, t, JSON.stringify(restoredStyleIds), normalizeStyleIntensity(b.styleIntensity));
    return novelId;
  })();
}
async function writePdf(file: string, novel: any, rows: any[], options: any) {
  if (!rows.length) throw new Error("没有可导出的章节内容");
  const tempDir = await fs.promises.mkdtemp(path.join(app.getPath("temp"), "zhuwen-pdf-"));
  const htmlPath = path.join(tempDir, "manuscript.html");
  let printWindow: BrowserWindow | null = null;
  try {
    await fs.promises.writeFile(htmlPath, buildPrintHtml(novel, rows, options), "utf8");
    printWindow = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await printWindow.loadURL(pathToFileURL(htmlPath).href);
    const buffer = await printWindow.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: '<div style="width:100%;padding:0 18mm;color:#777;font:9px sans-serif;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      generateDocumentOutline: true,
    });
    await fs.promises.writeFile(file, buffer);
  } finally {
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
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
function docxImageDimensions(data: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === "image/png" && data.length >= 24)
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (mime === "image/gif" && data.length >= 10)
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (mime === "image/bmp" && data.length >= 26)
    return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 4 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && offset + 9 < data.length)
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return null;
}
function makeDocxImage(node: any): ImageRun {
  const src = String(node?.attrs?.src || "");
  const match = /^data:(image\/(?:png|jpeg|webp|gif|bmp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
  if (!match || match[2].length % 4 !== 0) throw new Error("正文图片格式无效，无法导出 DOCX");
  const mime = match[1];
  if (mime === "image/webp") throw new Error("DOCX 暂不支持 WebP 正文图片，请将图片转换为 PNG、JPEG、GIF 或 BMP 后重试");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > 3 * 1024 * 1024 || data.toString("base64") !== match[2])
    throw new Error("正文图片为空或超过 3 MB，无法导出 DOCX");
  const valid = mime === "image/png"
    ? data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === "image/jpeg"
      ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : mime === "image/gif"
        ? /^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))
        : data.subarray(0, 2).toString("ascii") === "BM";
  if (!valid) throw new Error("正文图片内容与格式不匹配，无法导出 DOCX");
  const natural = docxImageDimensions(data, mime);
  const width = Number(node.attrs?.width) || natural?.width || 0;
  const height = Number(node.attrs?.height) || natural?.height || 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error("无法读取正文图片尺寸，无法导出 DOCX");
  const scale = Math.min(1, 560 / width, 760 / height);
  return new ImageRun({
    type: mime === "image/jpeg" ? "jpg" : mime.slice("image/".length) as "png" | "gif" | "bmp",
    data,
    transformation: { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) },
  });
}
function docxInlineRuns(nodes: any[]): (TextRun | ImageRun)[] {
  const runs: (TextRun | ImageRun)[] = [];
  for (const node of nodes) {
    if (node?.type === "image") {
      runs.push(makeDocxImage(node));
    } else if (node?.type === "hardBreak") {
      runs.push(new TextRun({ break: 1 }));
    } else if (node?.type === "text" && typeof node.text === "string") {
      const marks = new Set((node.marks || []).map((mark: any) => mark.type));
      runs.push(new TextRun({
        text: node.text,
        font: marks.has("code") ? "Consolas" : "宋体",
        size: 24,
        bold: marks.has("bold"),
        italics: marks.has("italic"),
        strike: marks.has("strike"),
      }));
    } else if (Array.isArray(node?.content)) {
      runs.push(...docxInlineRuns(node.content));
    }
  }
  return runs;
}
function docxText(node: any): string {
  if (node?.type === "text") return String(node.text || "");
  if (node?.type === "hardBreak") return "\n";
  return Array.isArray(node?.content) ? node.content.map(docxText).join("") : "";
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
    let document: any = null;
    try { document = JSON.parse(c.content_json || ""); } catch {}
    if (document?.type === "doc" && Array.isArray(document.content)) {
      for (const block of document.content) {
        if (block?.type === "image") {
          children.push(new Paragraph({ children: [makeDocxImage(block)] }));
          continue;
        }
        const runs = block?.type === "paragraph" && Array.isArray(block.content)
          ? docxInlineRuns(block.content)
          : [new TextRun({ text: docxText(block), font: "宋体", size: 24 })];
        if (runs.length)
          children.push(new Paragraph({
            indent: block?.type === "paragraph" ? { firstLine: 480 } : undefined,
            spacing: { line: 360, after: 120 },
            children: runs,
          }));
      }
    } else {
      for (const line of String(c.plain_text || "").split(/\n+/).filter(Boolean))
        children.push(new Paragraph({
          indent: { firstLine: 480 },
          spacing: { line: 360, after: 120 },
          children: [new TextRun({ text: line, font: "宋体", size: 24 })],
        }));
    }
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
