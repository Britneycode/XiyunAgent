import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionMeta } from "@xiyun/shared";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";

function setup() {
  const db = openDb(":memory:");
  return createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-sessions-"))));
}

type App = ReturnType<typeof setup>;

const json = { "Content-Type": "application/json" };

async function newSession(app: App, body: Partial<SessionMeta> = {}): Promise<SessionMeta> {
  const res = await app.request("/sessions", { method: "POST", headers: json, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as SessionMeta;
}

async function patch(app: App, id: string, body: unknown) {
  return app.request(`/sessions/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
}

async function list(app: App, query = "") {
  const res = await app.request(`/sessions${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Array<SessionMeta & { archived: boolean }>;
}

describe("会话重命名/归档(PATCH /sessions/:id、GET /sessions)", () => {
  it("新建会话默认未归档,列表带 archived:false", async () => {
    const app = setup();
    await newSession(app, { title: "甲" });
    const rows = await list(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.archived).toBe(false);
  });

  it("PATCH title 重命名生效", async () => {
    const app = setup();
    const s = await newSession(app, { title: "旧标题" });
    const res = await patch(app, s.id, { title: "新标题" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await list(app))[0]?.title).toBe("新标题");
  });

  it("PATCH title 为空串视为未提供,返回 400", async () => {
    const app = setup();
    const s = await newSession(app, { title: "旧标题" });
    const res = await patch(app, s.id, { title: "   " });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "缺少 workspace/title/archived" });
    expect((await list(app))[0]?.title).toBe("旧标题");
  });

  it("PATCH 非法字段(archived 非布尔)返回 400", async () => {
    const app = setup();
    const s = await newSession(app);
    const res = await patch(app, s.id, { archived: "true" });
    expect(res.status).toBe(400);
  });

  it("PATCH 空对象/未知字段返回 400", async () => {
    const app = setup();
    const s = await newSession(app);
    expect((await patch(app, s.id, {})).status).toBe(400);
    expect((await patch(app, s.id, { foo: 1 })).status).toBe(400);
  });

  it("PATCH workspace 保持原有行为(空值 400,非空生效)", async () => {
    const app = setup();
    const s = await newSession(app);
    expect((await patch(app, s.id, { workspace: "" })).status).toBe(400);
    expect((await patch(app, s.id, { workspace: "D:/proj" })).status).toBe(200);
    expect((await list(app))[0]?.workspace).toBe("D:/proj");
  });

  it("PATCH 不存在的会话返回 404", async () => {
    const app = setup();
    expect((await patch(app, "nope", { archived: true })).status).toBe(404);
  });

  it("归档与恢复:archived 布尔切换生效", async () => {
    const app = setup();
    const s = await newSession(app);
    expect((await patch(app, s.id, { archived: true })).status).toBe(200);
    expect((await list(app, "?archived=1"))[0]?.archived).toBe(true);
    expect((await patch(app, s.id, { archived: false })).status).toBe(200);
    expect(await list(app, "?archived=1")).toHaveLength(0);
  });

  it("GET /sessions 三种 archived 参数过滤", async () => {
    const app = setup();
    const a = await newSession(app, { title: "活跃" });
    const b = await newSession(app, { title: "归档" });
    await patch(app, b.id, { archived: true });

    // 缺省 = 只看未归档
    const active = await list(app);
    expect(active.map((r) => r.id)).toEqual([a.id]);
    // 0 与缺省等价
    expect((await list(app, "?archived=0")).map((r) => r.id)).toEqual([a.id]);
    // 1 = 只看已归档
    expect((await list(app, "?archived=1")).map((r) => r.id)).toEqual([b.id]);
    // all = 全部,仍带 archived 布尔
    const all = await list(app, "?archived=all");
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.map((r) => r.archived).sort()).toEqual([false, true]);
  });
});
