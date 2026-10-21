import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatProvider } from "../../runtime/src/index.ts";
import type { SessionMeta } from "@xiyun/shared";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";
import { cleanTitle, heuristicTitle } from "./title.ts";

const textProvider = (text: string, delayMs = 0): ChatProvider => ({
  config: { id: "fake", name: "fake", baseUrl: "http://x", apiKey: "k", model: "m", capabilities: ["stream"] },
  async *streamChat() {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    yield text;
  },
});

function setup(titleProvider?: ChatProvider) {
  const db = openDb(":memory:");
  const app = createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-act-"))), {
    chatProvider: () => textProvider("好的"),
    titleProvider: () => titleProvider,
  });
  return { app, db };
}

const json = { "Content-Type": "application/json" };
type App = ReturnType<typeof setup>["app"];

const newSession = async (app: App, title?: string) =>
  (await (await app.request("/sessions", { method: "POST", headers: json, body: JSON.stringify({ title }) })).json()) as SessionMeta;
const chat = async (app: App, sessionId: string, message: string) => {
  const res = await app.request("/chat", { method: "POST", headers: json, body: JSON.stringify({ sessionId, message }) });
  return (await res.text())
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);
};
const list = async (app: App) => (await (await app.request("/sessions")).json()) as SessionMeta[];

describe("标题工具函数", () => {
  it("heuristicTitle:首个非空行、去 Markdown、超长截断", () => {
    expect(heuristicTitle("\n## 解释一下 **闭包**\n第二行")).toBe("解释一下 闭包");
    expect(heuristicTitle("```ts\nconst a = 1\n```")).toBe("const a = 1");
    expect(heuristicTitle("看看 [文档](http://x) 里的 `foo`")).toBe("看看 文档 里的 foo");
    expect(heuristicTitle("一".repeat(40))).toBe(`${"一".repeat(30)}…`);
    expect(heuristicTitle("   ")).toBe("");
  });
  it("cleanTitle:去 think、引号、前缀与结尾标点", () => {
    expect(cleanTitle("<think>想一想</think>\n标题:「React 状态管理对比」。")).toBe("React 状态管理对比");
    expect(cleanTitle('"Fix login bug."\n解释')).toBe("Fix login bug");
  });
});

describe("会话最近活动与自动命名(D-019)", () => {
  it("发消息后会话浮到列表最前,并带 updatedAt", async () => {
    const { app } = setup();
    const a = await newSession(app, "甲");
    await new Promise((r) => setTimeout(r, 5));
    const b = await newSession(app, "乙");
    expect((await list(app)).map((s) => s.id)).toEqual([b.id, a.id]);
    await new Promise((r) => setTimeout(r, 5));
    await chat(app, a.id, "你好");
    const rows = await list(app);
    expect(rows.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(rows[0]!.updatedAt! > rows[0]!.createdAt).toBe(true);
    expect(rows[0]!.title).toBe("甲"); // 用户起过的标题不覆盖
  });

  it("默认标题:首条消息落启发式标题;无标题模型时不再请求", async () => {
    const { app } = setup();
    const s = await newSession(app);
    expect(s.title).toBe("新会话");
    const msg = "请详细解释一下 JavaScript 里的闭包和作用域链分别是什么,最好带几个例子";
    const events = await chat(app, s.id, msg);
    expect(events.some((e) => e.type === "title")).toBe(false);
    expect((await list(app))[0]!.title).toBe(`${msg.slice(0, 30)}…`);
    // 第二条消息不再改名
    await chat(app, s.id, "再举个例子");
    expect((await list(app))[0]!.title).toContain("请详细解释一下 JavaScript");
  });

  it("有标题模型时用模型标题覆盖启发式标题,并通过 title 事件推送", async () => {
    const { app } = setup(textProvider("「闭包与作用域链」"));
    const s = await newSession(app);
    const events = await chat(app, s.id, "解释一下 JavaScript 的闭包和作用域链,最好带例子");
    expect(events.find((e) => e.type === "title")).toEqual({ type: "title", title: "闭包与作用域链" });
    expect((await list(app))[0]!.title).toBe("闭包与作用域链");
  });

  it("短消息只用启发式标题,不调用模型", async () => {
    let called = false;
    const p = textProvider("不该出现");
    const spy: ChatProvider = { ...p, streamChat: (...args) => ((called = true), p.streamChat(...args)) };
    const { app } = setup(spy);
    const s = await newSession(app);
    await chat(app, s.id, "什么是闭包");
    expect(called).toBe(false);
    expect((await list(app))[0]!.title).toBe("什么是闭包");
  });

  it("v8 迁移:老库回填 updated_at 为最后一条消息时间", () => {
    const dir = mkdtempSync(join(tmpdir(), "xiyun-v8-"));
    const file = join(dir, "app.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'chat', workspace TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, blocks TEXT, aborted INTEGER NOT NULL DEFAULT 0, usage TEXT, error TEXT, created_at TEXT NOT NULL);
      INSERT INTO sessions (id, title, created_at) VALUES ('s1', '有消息', '2026-01-01T00:00:00.000Z'), ('s2', '无消息', '2026-01-02T00:00:00.000Z');
      INSERT INTO messages (session_id, role, content, created_at) VALUES ('s1', 'user', 'hi', '2026-03-01T00:00:00.000Z');
      PRAGMA user_version = 7;
    `);
    old.close();
    const db = openDb(file);
    const rows = db.prepare("SELECT id, updated_at FROM sessions ORDER BY id").all() as Array<{ id: string; updated_at: string }>;
    expect(rows).toEqual([
      { id: "s1", updated_at: "2026-03-01T00:00:00.000Z" },
      { id: "s2", updated_at: "2026-01-02T00:00:00.000Z" },
    ]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
