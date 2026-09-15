import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

type Statement = ReturnType<DatabaseSync['prepare']>

class AppDatabase {
  private inner: DatabaseSync
  private statements = new Map<string, Statement>()
  constructor(path:string){ this.inner=new DatabaseSync(path) }
  pragma(value:string){ this.inner.exec(`PRAGMA ${value}`) }
  exec(sql:string){ return this.inner.exec(sql) }
  prepare(sql:string){
    let stmt = this.statements.get(sql)
    if (!stmt) {
      stmt = this.inner.prepare(sql)
      this.statements.set(sql, stmt)
    }
    return stmt
  }
  close(){ this.statements.clear(); return this.inner.close() }
  transaction<T>(fn:()=>T){ return ()=>{this.inner.exec('BEGIN IMMEDIATE');try{const value=fn();this.inner.exec('COMMIT');return value}catch(e){this.inner.exec('ROLLBACK');throw e}} }
}
export type Db = AppDatabase
const now = () => new Date().toISOString()

export function localDate(value = new Date()) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true })
  const db = new AppDatabase(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

export const builtinPrompts: [string, string][] = [
  ['讨论剧情','根据引用内容讨论剧情走向。先指出关键矛盾，再给出三种不改变既定事实的推进方案。'],
  ['保持文风润色','润色选中文字，保留事实、视角、人物关系和原有文风，不扩写新情节。只给出修改稿和必要说明。'],
  ['检查逻辑','检查逻辑问题。逐项引用对应原文，说明理由和影响，不直接改写全文。'],
  ['检查人物对白','检查人物对白是否符合人物身份、动机与语言习惯，引用原句并提出克制的修改建议。'],
  ['优化节奏','分析场景节奏，指出拖沓或跳跃处并给出局部调整建议。'],
  ['生成章节摘要','基于引用章节生成忠于原文的简洁摘要，不补充原文没有的事实。'],
  ['人物起名','根据背景、时代和人物特征提供候选姓名，并解释含义与辨识度。'],
  ['地点起名','根据世界观与地点特征提供候选名称，并说明命名逻辑。'],
  ['场景描写','根据给定事实提供场景描写建议，保持视角一致，不擅自推进剧情。'],
  ['续写建议','只提供后续情节方向和短小示例，由作者决定是否采用，不直接续写整章。']
]

function migrate(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const version = (db.prepare('SELECT COALESCE(MAX(version),0) v FROM schema_migrations').get() as {v:number}).v
  if (version < 1) db.transaction(() => {
    db.exec(`
      CREATE TABLE novels(id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '', genre TEXT NOT NULL DEFAULT '', cover_path TEXT, archived INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, last_chapter_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE volumes(id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE, title TEXT NOT NULL, sort_order INTEGER NOT NULL, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE chapters(id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE, volume_id TEXT REFERENCES volumes(id) ON DELETE SET NULL, title TEXT NOT NULL, content_json TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}', plain_text TEXT NOT NULL DEFAULT '', word_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', sort_order INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, cursor_pos INTEGER NOT NULL DEFAULT 0, scroll_pos REAL NOT NULL DEFAULT 0, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE library_items(id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL, content_json TEXT NOT NULL DEFAULT '{}', tags_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'idea', chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL, sort_order INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE chapter_revisions(id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE, content_json TEXT NOT NULL, plain_text TEXT NOT NULL, word_count INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE ai_conversations(id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE, chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL, title TEXT NOT NULL, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE ai_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, connection_id TEXT, chapter_id TEXT, source_revision INTEGER, selection_text TEXT, incomplete INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE message_context_snapshots(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE, label TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, source_id TEXT, created_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE api_connections(id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, temperature REAL NOT NULL DEFAULT 0.7, max_tokens INTEGER NOT NULL DEFAULT 2048, timeout_ms INTEGER NOT NULL DEFAULT 60000, streaming INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE prompt_templates(id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE writing_activity(id TEXT PRIMARY KEY, novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE, date TEXT NOT NULL, delta INTEGER NOT NULL, created_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE backup_records(id TEXT PRIMARY KEY, novel_id TEXT NOT NULL, file_path TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE preferences(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, data_version INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX idx_chapters_novel ON chapters(novel_id, deleted_at, sort_order);
      CREATE INDEX idx_library_novel ON library_items(novel_id, kind, deleted_at);
      CREATE INDEX idx_revisions_chapter ON chapter_revisions(chapter_id, created_at DESC);
      CREATE INDEX idx_activity_date ON writing_activity(novel_id, date);
    `)
    const ins = db.prepare('INSERT INTO prompt_templates VALUES(?,?,?,?,?,?,1)')
    for (const [name, content] of builtinPrompts) { const t=now(); ins.run(randomUUID(),name,content,1,t,t) }
    db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(now())
  })()
  if (version < 2) db.transaction(() => {
    db.exec(`
      ALTER TABLE chapters ADD COLUMN summary TEXT NOT NULL DEFAULT '';
      ALTER TABLE chapters ADD COLUMN summary_revision INTEGER NOT NULL DEFAULT -1;
      ALTER TABLE chapters ADD COLUMN summary_updated_at TEXT;
    `)
    db.prepare('INSERT INTO schema_migrations VALUES(2,?)').run(now())
  })()
  if (version < 3) db.transaction(() => {
    db.exec('CREATE INDEX IF NOT EXISTS idx_chapters_search_order ON chapters(novel_id, deleted_at, sort_order, id)')
    db.prepare('INSERT INTO schema_migrations VALUES(3,?)').run(now())
  })()
  if (version < 4) db.transaction(() => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_context_snapshots_message ON message_context_snapshots(message_id);
      CREATE INDEX IF NOT EXISTS idx_ai_conversations_novel ON ai_conversations(novel_id, updated_at DESC);
    `)
    db.prepare('INSERT INTO schema_migrations VALUES(4,?)').run(now())
  })()
  if (version < 5) db.transaction(() => {
    db.exec(`ALTER TABLE api_connections ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''`)
    db.prepare('INSERT INTO schema_migrations VALUES(5,?)').run(now())
  })()
  if (version < 6) db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS writing_focus_sessions(
        id TEXT PRIMARY KEY,
        novel_id TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
        chapter_id TEXT,
        date TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        committed_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        data_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_focus_novel_date ON writing_focus_sessions(novel_id, date);
      CREATE INDEX IF NOT EXISTS idx_focus_date ON writing_focus_sessions(date);
    `)
    db.prepare('INSERT INTO schema_migrations VALUES(6,?)').run(now())
  })()
  if (version < 7) db.transaction(() => {
    db.exec(`
      ALTER TABLE writing_focus_sessions ADD COLUMN logical_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_focus_logical ON writing_focus_sessions(logical_id);
    `)
    db.prepare('INSERT INTO schema_migrations VALUES(7,?)').run(now())
  })()
}

export function countText(text: string, punctuation = true) {
  const noSpace = text.replace(/\s/g, '')
  return punctuation ? Array.from(noSpace).length : Array.from(noSpace.replace(/[\p{P}\p{S}]/gu, '')).length
}

export const newId = () => randomUUID()
export const timestamp = now
