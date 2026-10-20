import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";

function setup() {
  const db = openDb(":memory:");
  return { app: createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-data-")))), db };
}

const json = { "Content-Type": "application/json" };
const post = (app: ReturnType<typeof setup>["app"], path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: json, body: JSON.stringify(body) });

describe("数据导出", () => {
  it("导出包含会话/消息/资料/待办/记忆,不含 API Key 与审计", async () => {
    const { app, db } = setup();
    await post(app, "/sessions", { title: "学习", mode: "chat" });
    const sid = (db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string }).id;
    db.prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'user', '你好', '2026-01-01')").run(sid);
    db.prepare("INSERT INTO docs (id, title, kind, source, content, workspace, created_at) VALUES ('d1', '笔记', 'paste', '粘贴导入', '正文', '', '2026-01-01')").run();
    db.prepare("INSERT INTO todos (id, title, status, created_at) VALUES ('t1', '待办', 'open', '2026-01-01')").run();
    db.prepare("INSERT INTO facts (id, content, valid_from) VALUES ('f1', '偏好简洁', '2026-01-01')").run();
    // 写入一条含密钥字样的审计与 provider,确认不泄露
    db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('test', '{\"k\":\"sk-secret-abc\"}', '2026-01-01')").run();

    const res = await app.request("/admin/export");
    expect(res.status).toBe(200);
    const pack = (await res.json()) as { kind: string; version: number; data: Record<string, unknown[]> };
    expect(pack.kind).toBe("xiyun-export");
    expect(pack.version).toBe(1);
    expect(pack.data.sessions).toHaveLength(1);
    expect(pack.data.messages).toHaveLength(1);
    expect(pack.data.docs).toHaveLength(1);
    expect(pack.data.todos).toHaveLength(1);
    expect(pack.data.facts).toHaveLength(1);
    // 不导出审计 events,序列化里不出现密钥
    expect((pack.data as Record<string, unknown>).events).toBeUndefined();
    expect(JSON.stringify(pack)).not.toContain("sk-secret-abc");
  });
});

describe("消息块读取", () => {
  it("GET messages 解析 blocks,坏 JSON 不 500", async () => {
    const { app, db } = setup();
    const sres = await post(app, "/sessions", { title: "块" });
    const s = (await sres.json()) as { id: string };
    db.prepare("INSERT INTO messages (session_id, role, content, blocks, aborted, created_at) VALUES (?, 'assistant', 'a', ?, 1, 't')")
      .run(s.id, JSON.stringify([{ id: "t1", kind: "text", text: "a" }]));
    db.prepare("INSERT INTO messages (session_id, role, content, blocks, created_at) VALUES (?, 'assistant', 'b', '{bad', 't')").run(s.id);
    const res = await app.request(`/sessions/${s.id}/messages`);
    expect(res.status).toBe(200);
    const msgs = (await res.json()) as Array<{ blocks?: unknown; aborted?: boolean }>;
    expect(msgs[0].blocks).toEqual([{ id: "t1", kind: "text", text: "a" }]);
    expect(msgs[0].aborted).toBe(true);
    expect(msgs[1].blocks).toBeUndefined();
  });
});

describe("数据导入", () => {
  const packWith = (sid: string, extra: Record<string, unknown> = {}) => ({
    kind: "xiyun-export", version: 1, exportedAt: "2026-01-01",
    data: {
      sessions: [{ id: sid, title: "导入", mode: "chat", workspace: "", created_at: "2026-01-01", archived: 0 }],
      messages: [{ session_id: sid, role: "user", content: "hi", created_at: "2026-01-01" }],
      docs: [], todos: [], facts: [],
      ...extra,
    },
  });

  it("导入新数据成功,消息随会话落库", async () => {
    const { app, db } = setup();
    const res = await post(app, "/admin/import", packWith("s1"));
    expect(res.status).toBe(200);
    const r = (await res.json()) as { added: Record<string, number> };
    expect(r.added.sessions).toBe(1);
    expect(r.added.messages).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(1);
  });

  it("重复导入同 id 跳过不覆盖,不产生重复", async () => {
    const { app, db } = setup();
    await post(app, "/admin/import", packWith("s1"));
    const res = await post(app, "/admin/import", packWith("s1"));
    const r = (await res.json()) as { added: Record<string, number>; skipped: Record<string, number> };
    expect(r.added.sessions).toBe(0);
    expect(r.skipped.sessions).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c).toBe(1);
  });

  it("预览不写库且正确报新增/重复", async () => {
    const { app, db } = setup();
    await post(app, "/admin/import", packWith("s1"));
    const res = await post(app, "/admin/import/preview", packWith("s1"));
    const p = (await res.json()) as { sessions: { total: number; duplicate: number; added: number } };
    expect(p.sessions).toEqual({ total: 1, duplicate: 1, added: 0 });
    // 预览后库里仍只有 1 条(未写)
    expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(1);
  });

  it("损坏/不兼容包在写库前拒绝", async () => {
    const { app, db } = setup();
    expect((await post(app, "/admin/import", { hello: 1 })).status).toBe(400);
    expect((await post(app, "/admin/import", { kind: "xiyun-export", version: 99, data: {} })).status).toBe(400);
    expect((await post(app, "/admin/import", null)).status).toBe(400);
    expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(0);
  });

  it("导入中途失败整体回滚,不破坏已有数据", async () => {
    const { app, db } = setup();
    await post(app, "/admin/import", packWith("s1"));
    const before = (db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c;
    // 构造一个 sessions 含新 id、但 facts 含非法 confidence 类型(对象)的包:
    // facts insert 会在绑定时抛错,事务应回滚,sessions.s_new 不应落库
    const bad = packWith("s_new", {
      facts: [{ id: "f_bad", content: "x", source: "", confidence: { not: "a number" }, scope: "global", valid_from: "2026-01-01", valid_to: null, deleted_at: null }],
    });
    const res = await post(app, "/admin/import", bad);
    expect(res.status).toBe(400);
    // 新会话未落库(回滚),原有数据不受影响
    expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(before);
    expect(db.prepare("SELECT 1 FROM sessions WHERE id = 's_new'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM facts WHERE id = 'f_bad'").get()).toBeUndefined();
  });
});
