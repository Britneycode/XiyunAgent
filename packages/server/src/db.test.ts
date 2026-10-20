import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, SCHEMA_VERSION } from "./db.ts";
import type { ChatBlock, ChatMessage } from "@xiyun/shared";

const tmp = () => mkdtempSync(join(tmpdir(), "xiyun-db-"));

describe("db 迁移与备份(阶段 7)", () => {
  it("全新库直接建到最新版本,不产生备份", () => {
    const dir = tmp();
    const db = openDb(join(dir, "app.db"));
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBe(SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of ["sessions", "messages", "facts", "events", "candidates", "tasks", "docs", "todos", "skills"])
      expect(tables).toContain(t);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("老库(user_version=0,无 question 列)迁移时先备份再加列", () => {
    const dir = tmp();
    const file = join(dir, "app.db");
    // 构造 v0 老库:有 tasks 但无 question 列
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL DEFAULT '')");
    old.exec("PRAGMA user_version = 0");
    old.prepare("INSERT INTO tasks (id, prompt) VALUES ('t1', 'keep')").run();
    old.close();

    const db = openDb(file);
    expect(readdirSync(join(dir, "backups")).length).toBe(1); // 迁移前自动备份
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("question"); // v2 迁移生效
    expect((db.prepare("SELECT prompt FROM tasks WHERE id = 't1'").get() as { prompt: string }).prompt).toBe("keep"); // 数据未丢
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("老库(无 archived 列)迁移后默认 archived=0", () => {
    const dir = tmp();
    const file = join(dir, "app.db");
    // 构造 v3 老库:sessions 表无 archived 列
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'chat', workspace TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    old.exec("PRAGMA user_version = 3");
    old.prepare("INSERT INTO sessions (id, title, created_at) VALUES ('s1', '旧会话', '2026-01-01T00:00:00.000Z')").run();
    old.close();

    const db = openDb(file);
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("archived"); // v4 迁移生效
    const row = db.prepare("SELECT title, archived FROM sessions WHERE id = 's1'").get() as { title: string; archived: number };
    expect(row.title).toBe("旧会话"); // 数据未丢
    expect(row.archived).toBe(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("全新库 sessions 自带 archived 列", () => {
    const dir = tmp();
    const db = openDb(join(dir, "app.db"));
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("archived");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("v4 老库升级到 v5 后 messages 具备 blocks/aborted", () => {
    const dir = tmp();
    const file = join(dir, "old.db");
    // 模拟 v4 库:只建旧结构并写 user_version=4
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'chat', workspace TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      PRAGMA user_version = 4;
    `);
    old.close();
    const db = openDb(file);
    const cols = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("blocks");
    expect(cols).toContain("aborted");
    expect(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(5);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("已是最新版本的库不重复备份", () => {
    const dir = tmp();
    const file = join(dir, "app.db");
    openDb(file).close();
    openDb(file).close();
    expect(readdirSync(dir)).not.toContain("backups");
    rmSync(dir, { recursive: true, force: true });
  });
});

it("ChatMessage 支持 blocks 与 aborted", () => {
  const b: ChatBlock = { id: "t1", kind: "text", text: "hi" };
  const m: ChatMessage = { id: 1, role: "assistant", content: "hi", blocks: [b], aborted: true };
  expect(m.blocks?.[0].kind).toBe("text");
  expect(m.aborted).toBe(true);
});
