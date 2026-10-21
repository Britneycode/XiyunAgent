import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";
import { HL_END, HL_START, searchMessages, type SearchHit } from "./search.ts";

const now = "2026-10-21T00:00:00.000Z";

function seed(db: DatabaseSync) {
  const ins = db.prepare("INSERT INTO sessions (id, title, mode, workspace, created_at, updated_at, archived) VALUES (?, ?, ?, '', ?, ?, ?)");
  ins.run("s1", "部署讨论", "chat", now, now, 0);
  ins.run("s2", "代码评审", "code", now, now, 0);
  ins.run("s3", "旧会话", "chat", now, now, 1);
  const msg = db.prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)");
  msg.run("s1", "user", "如何配置 Kubernetes 集群的滚动更新?", now);
  msg.run("s1", "assistant", "可以用 kubectl rollout 命令管理 Kubernetes 部署的滚动更新。", now);
  msg.run("s2", "user", "这段 TypeScript 代码有内存泄漏吗", now);
  msg.run("s3", "user", "Kubernetes 归档里的消息", now);
  msg.run("s1", "system", "Kubernetes 系统消息不应被搜到", now);
}

describe("消息全文搜索(M7)", () => {
  it("FTS 命中多条消息,片段带高亮标记,排除 system 与归档会话", () => {
    const db = openDb(":memory:");
    seed(db);
    const hits = searchMessages(db, "kubernetes");
    expect(hits.map((h) => h.session.id)).toEqual(["s1", "s1"]);
    expect(hits.every((h) => h.session.title === "部署讨论" && h.role !== "system")).toBe(true);
    expect(hits[0]?.snippet).toContain(`${HL_START}Kubernetes${HL_END}`);
    expect(searchMessages(db, "kubernetes", { includeArchived: true }).map((h) => h.session.id)).toContain("s3");
  });

  it("中文三字以上走 trigram,多个词之间为 AND", () => {
    const db = openDb(":memory:");
    seed(db);
    expect(searchMessages(db, "滚动更新").length).toBe(2);
    expect(searchMessages(db, "滚动更新 kubectl").map((h) => h.role)).toEqual(["assistant"]);
    expect(searchMessages(db, "内存泄漏")[0]?.session.id).toBe("s2");
  });

  it("短于 3 字的词退回 LIKE 子串匹配,仍有高亮", () => {
    const db = openDb(":memory:");
    seed(db);
    const hits = searchMessages(db, "泄漏");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain(`${HL_START}泄漏${HL_END}`);
    // LIKE 通配符被转义
    expect(searchMessages(db, "%")).toEqual([]);
  });

  it("mode 过滤只返回对应模式的会话", () => {
    const db = openDb(":memory:");
    seed(db);
    expect(searchMessages(db, "代码", { mode: "chat" })).toEqual([]);
    expect(searchMessages(db, "TypeScript", { mode: "code" })).toHaveLength(1);
  });

  it("引号/FTS 语法字符不会报错", () => {
    const db = openDb(":memory:");
    seed(db);
    expect(() => searchMessages(db, '"kub OR NEAR( *')).not.toThrow();
    expect(searchMessages(db, '"""')).toEqual([]);
    expect(searchMessages(db, "   ")).toEqual([]);
  });

  it("触发器同步:更新/删除消息后索引随之变化", () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare("UPDATE messages SET content = '改成了 PostgreSQL 的问题' WHERE session_id = 's2'").run();
    expect(searchMessages(db, "TypeScript")).toEqual([]);
    expect(searchMessages(db, "postgresql")).toHaveLength(1);
    db.prepare("DELETE FROM messages WHERE session_id = 's1'").run();
    expect(searchMessages(db, "kubectl")).toEqual([]);
  });

  it("老库升级到 v9 时回填已有消息", () => {
    const dir = mkdtempSync(join(tmpdir(), "xiyun-search-"));
    const file = join(dir, "app.db");
    const db0 = openDb(file);
    seed(db0);
    db0.exec("DROP TABLE messages_fts; DROP TRIGGER messages_fts_ai; DROP TRIGGER messages_fts_ad; DROP TRIGGER messages_fts_au; PRAGMA user_version = 8");
    db0.close();
    const db = openDb(file);
    expect(searchMessages(db, "kubectl")).toHaveLength(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /search 透传 q/mode/archived", async () => {
    const db = openDb(":memory:");
    seed(db);
    const app = createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-search-"))));
    const get = async (qs: string) => (await (await app.request(`/search?${qs}`)).json()) as SearchHit[];
    expect(await get("q=Kubernetes")).toHaveLength(2);
    expect(await get("q=Kubernetes&archived=all")).toHaveLength(3);
    expect(await get("q=Kubernetes&mode=code")).toEqual([]);
    expect(await get("q=")).toEqual([]);
  });
});
