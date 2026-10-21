import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const DATA_DIR = process.env.XIYUN_DATA_DIR ?? join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

// 迁移清单:版本号 = PRAGMA user_version。新增表优先改下面 CREATE IF NOT EXISTS(全新库直接建好);
// 已有库的列/索引变更按序追加一条迁移。
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  // v1:基线(sessions/messages/facts/events/candidates/tasks/facts_fts)
  () => {},
  // v2:tasks.question(waiting_for_user 提问)
  (db) => {
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("question")) db.exec("ALTER TABLE tasks ADD COLUMN question TEXT");
  },
  // v3:docs/todos/skills(阶段 5/6)
  () => {},
  // v4:sessions.archived(会话归档,0=活跃 1=已归档)
  (db) => {
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("archived")) db.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  },
  // v5:messages.blocks(结构化块 JSON)+ messages.aborted(用户中断标记)
  (db) => {
    const cols = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("blocks")) db.exec("ALTER TABLE messages ADD COLUMN blocks TEXT");
    if (!cols.includes("aborted")) db.exec("ALTER TABLE messages ADD COLUMN aborted INTEGER NOT NULL DEFAULT 0");
  },
  // v6:messages.usage(模型返回的 token 用量 JSON,仅 assistant;未返回时为 NULL)
  (db) => {
    const cols = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("usage")) db.exec("ALTER TABLE messages ADD COLUMN usage TEXT");
  },
  // v7:messages.error(生成出错时保留的半截回复所带的错误信息;正常消息为 NULL)
  (db) => {
    const cols = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("error")) db.exec("ALTER TABLE messages ADD COLUMN error TEXT");
  },
  // v8:sessions.updated_at(最近活动时间,会话列表按它排序);老会话回填为最后一条消息的时间
  (db) => {
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("updated_at")) db.exec("ALTER TABLE sessions ADD COLUMN updated_at TEXT");
    db.exec(
      `UPDATE sessions SET updated_at = COALESCE((SELECT MAX(created_at) FROM messages WHERE messages.session_id = sessions.id), created_at)
       WHERE updated_at IS NULL`,
    );
  },
  // v9:messages_fts(消息全文索引,trigram 分词,中英文子串都能搜);触发器同步,建表时回填已有消息
  (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, session_id UNINDEXED, tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, session_id) VALUES (new.id, new.content, new.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
        UPDATE messages_fts SET content = new.content WHERE rowid = old.id;
      END;
      DELETE FROM messages_fts;
      INSERT INTO messages_fts(rowid, content, session_id) SELECT id, content, session_id FROM messages;
    `);
  },
  // v10:会话级模型 sessions.provider_id / model(NULL = 跟随全局);messages.model(生成该回复的模型)
  (db) => {
    const sc = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!sc.includes("provider_id")) db.exec("ALTER TABLE sessions ADD COLUMN provider_id TEXT");
    if (!sc.includes("model")) db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
    const mc = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!mc.includes("model")) db.exec("ALTER TABLE messages ADD COLUMN model TEXT");
  },
  // v11:消息树(F6)与上下文管理(F4)。
  // messages.parent_id(父消息,首条 NULL)/ sessions.head_id(当前分支末条);老会话按 id 顺序回填成单链。
  // messages.ref_context(user 消息的引用上下文原文,之后几轮继续带入)/ messages.ctx_trim(assistant 生成时的历史裁剪 JSON);
  // sessions.summary / summary_upto_id(超出预算的早先消息的滚动摘要,覆盖到哪条消息)
  (db) => {
    const mc = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!mc.includes("parent_id")) db.exec("ALTER TABLE messages ADD COLUMN parent_id INTEGER");
    if (!mc.includes("ref_context")) db.exec("ALTER TABLE messages ADD COLUMN ref_context TEXT");
    if (!mc.includes("ctx_trim")) db.exec("ALTER TABLE messages ADD COLUMN ctx_trim TEXT");
    const sc = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!sc.includes("head_id")) db.exec("ALTER TABLE sessions ADD COLUMN head_id INTEGER");
    if (!sc.includes("summary")) db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT");
    if (!sc.includes("summary_upto_id")) db.exec("ALTER TABLE sessions ADD COLUMN summary_upto_id INTEGER");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      UPDATE messages SET parent_id = (
        SELECT MAX(m2.id) FROM messages m2 WHERE m2.session_id = messages.session_id AND m2.id < messages.id
      ) WHERE parent_id IS NULL;
      UPDATE sessions SET head_id = (SELECT MAX(id) FROM messages WHERE messages.session_id = sessions.id)
      WHERE head_id IS NULL;
    `);
  },
];
export const SCHEMA_VERSION = MIGRATIONS.length;

// 升级前自动备份:老库版本落后时先复制一份到库旁的 backups/,迁移失败可手动回滚(改名恢复)。
export function backupDb(file: string): string | null {
  if (!existsSync(file) || statSync(file).size === 0) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(dirname(file), "backups", `app-${ts}.db`);
  mkdirSync(join(dirname(file), "backups"), { recursive: true });
  copyFileSync(file, dest);
  return dest;
}

export function openDb(file = join(DATA_DIR, "app.db")): DatabaseSync {
  const probe = new DatabaseSync(file);
  const version = Number((probe.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version < SCHEMA_VERSION) {
    probe.close();
    backupDb(file); // 只在需要迁移时备份
  } else {
    probe.close();
  }

  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'chat',
      workspace TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      blocks TEXT,
      aborted INTEGER NOT NULL DEFAULT 0,
      usage TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.5,
      scope TEXT NOT NULL DEFAULT 'global',
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.5,
      scope TEXT NOT NULL DEFAULT 'global',
      session_id TEXT,
      mode TEXT NOT NULL DEFAULT 'chat',
      workspace TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT 'add',
      target_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      session_id TEXT,
      role TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL DEFAULT 'run',
      status TEXT NOT NULL DEFAULT 'queued',
      provider_id TEXT,
      model TEXT,
      mode TEXT NOT NULL DEFAULT 'chat',
      workspace TEXT NOT NULL DEFAULT '',
      depends_on TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'file',
      source TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT '',
      session_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      due TEXT,
      source TEXT NOT NULL DEFAULT '',
      workspace TEXT NOT NULL DEFAULT '',
      session_id TEXT,
      created_at TEXT NOT NULL,
      done_at TEXT
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL DEFAULT '',
      modes TEXT NOT NULL DEFAULT '[]',
      roles TEXT NOT NULL DEFAULT '[]',
      memory_scopes TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 0,
      path TEXT NOT NULL,
      warnings TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(id UNINDEXED, content, tokenize='trigram');
  `);
  for (let v = version; v < SCHEMA_VERSION; v++) MIGRATIONS[v](db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}
