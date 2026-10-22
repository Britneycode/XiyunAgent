import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, ProviderConfig } from "@xiyun/shared";
import type { ChatProvider, ProviderEvent } from "../../runtime/src/index.ts";
import { createApp } from "./app.ts";
import { openDb, SCHEMA_VERSION } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";

// 记录每次发给模型的消息;回复内容 = "A:" + 最后一条 user 原话的首行
function recorder(config: Partial<ProviderConfig> = {}) {
  const calls: ChatMessage[][] = [];
  const provider: ChatProvider = {
    config: { id: "t", name: "t", baseUrl: "http://x", apiKey: "k", model: "m", ...config },
    async *streamChat() {},
    async *streamEvents(messages) {
      calls.push(messages);
      const last = messages[messages.length - 1]!.content.split("\n")[0];
      yield { type: "text", delta: `A:${last}` } as ProviderEvent;
      yield { type: "finish", reason: "stop" } as ProviderEvent;
    },
  };
  return { provider, calls };
}

function setup(provider: ChatProvider, summaryProvider?: ChatProvider, db = openDb(":memory:")) {
  const app = createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-tree-"))), {
    chatProvider: () => provider,
    titleProvider: () => undefined,
    summaryProvider: () => summaryProvider,
  });
  return { app, db };
}

type App = ReturnType<typeof setup>["app"];
type Msg = { id: number; role: string; content: string; parentId?: number | null; siblings?: number[]; blocks?: unknown[]; trim?: unknown };
const json = { "Content-Type": "application/json" };
const chat = async (app: App, body: Record<string, unknown>) => {
  const text = await (await app.request("/chat", { method: "POST", headers: json, body: JSON.stringify(body) })).text();
  return text
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);
};
const newSession = async (app: App, body: Record<string, unknown> = {}) =>
  (await (await app.request("/sessions", { method: "POST", headers: json, body: JSON.stringify({ mode: "chat", ...body }) })).json()) as { id: string };
const list = async (app: App, sid: string) => (await (await app.request(`/sessions/${sid}/messages`)).json()) as Msg[];
const contents = (ms: Array<{ content: string }>) => ms.map((m) => m.content);
const turns = (ms: ChatMessage[]) => contents(ms.filter((m) => m.role !== "system"));

describe("消息树(F6)", () => {
  it("v10 老库迁移:每个会话按 id 顺序串成单链,head 指向最后一条", () => {
    const dir = mkdtempSync(join(tmpdir(), "xiyun-v10-"));
    const file = join(dir, "app.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'chat', workspace TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO sessions VALUES ('a', 'A', 'chat', '', 't'), ('b', 'B', 'chat', '', 't'), ('c', 'C', 'chat', '', 't');
      INSERT INTO messages (session_id, role, content, created_at) VALUES
        ('a', 'user', 'a1', 't'), ('b', 'user', 'b1', 't'), ('a', 'assistant', 'a2', 't'), ('b', 'assistant', 'b2', 't'), ('a', 'user', 'a3', 't');
      PRAGMA user_version = 4;
    `);
    old.close();
    const db = openDb(file);
    expect(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(SCHEMA_VERSION);
    const rows = db.prepare("SELECT id, session_id, parent_id FROM messages ORDER BY id").all() as Array<{ id: number; session_id: string; parent_id: number | null }>;
    expect(rows.map((r) => [r.id, r.parent_id])).toEqual([[1, null], [2, null], [3, 1], [4, 2], [5, 3]]);
    const heads = db.prepare("SELECT id, head_id FROM sessions ORDER BY id").all() as Array<{ id: string; head_id: number | null }>;
    expect(heads.map((h) => [h.id, h.head_id])).toEqual([["a", 5], ["b", 4], ["c", null]]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("编辑 user 消息产生兄弟版本:原版本与其后的回复保留,模型只看到新分支的历史", async () => {
    const { provider, calls } = recorder();
    const { app } = setup(provider);
    const s = await newSession(app);
    await chat(app, { sessionId: s.id, message: "q1" });
    await chat(app, { sessionId: s.id, message: "q2" });
    const before = await list(app, s.id);
    expect(contents(before)).toEqual(["q1", "A:q1", "q2", "A:q2"]);
    const q2 = before[2]!;

    await chat(app, { sessionId: s.id, message: "q2b", editOf: q2.id });
    expect(turns(calls.at(-1)!)).toEqual(["q1", "A:q1", "q2b"]);
    const after = await list(app, s.id);
    expect(contents(after)).toEqual(["q1", "A:q1", "q2b", "A:q2b"]);
    expect(after[2]!.parentId).toBe(before[1]!.id);
    expect(after[2]!.siblings).toEqual([q2.id, after[2]!.id]);
    expect(after[3]!.siblings).toBeUndefined();

    // 编辑首条消息:兄弟是根消息
    await chat(app, { sessionId: s.id, message: "q1b", editOf: before[0]!.id });
    expect(turns(calls.at(-1)!)).toEqual(["q1b"]);
    const root = await list(app, s.id);
    expect(contents(root)).toEqual(["q1b", "A:q1b"]);
    expect(root[0]!.parentId).toBeNull();
    expect(root[0]!.siblings).toHaveLength(2);

    // 不存在 / 非 user 的消息不能编辑
    const bad = await app.request("/chat", { method: "POST", headers: json, body: JSON.stringify({ sessionId: s.id, message: "x", editOf: before[1]!.id }) });
    expect(bad.status).toBe(404);
  });

  it("切换分支:切到兄弟版本时落到它最新的后续;已在当前路径上不变", async () => {
    const { provider, calls } = recorder();
    const { app } = setup(provider);
    const s = await newSession(app);
    await chat(app, { sessionId: s.id, message: "q1" });
    await chat(app, { sessionId: s.id, message: "q2" });
    await chat(app, { sessionId: s.id, message: "q3" });
    const orig = await list(app, s.id);
    await chat(app, { sessionId: s.id, message: "q2b", editOf: orig[2]!.id });

    const head = async (messageId: unknown) =>
      app.request(`/sessions/${s.id}/head`, { method: "POST", headers: json, body: JSON.stringify({ messageId }) });
    const res = await head(orig[2]!.id);
    expect(res.status).toBe(200);
    const r = (await res.json()) as { headId: number; messages: Msg[] };
    expect(contents(r.messages)).toEqual(["q1", "A:q1", "q2", "A:q2", "q3", "A:q3"]);
    expect(r.headId).toBe(orig[5]!.id);
    expect(contents(await list(app, s.id))).toEqual(contents(r.messages));
    // 在当前路径上的消息:head 不变
    const same = (await (await head(orig[1]!.id)).json()) as { headId: number };
    expect(same.headId).toBe(orig[5]!.id);
    // 切回后继续对话,接在原分支末尾
    await chat(app, { sessionId: s.id, message: "q4" });
    expect(turns(calls.at(-1)!)).toEqual(["q1", "A:q1", "q2", "A:q2", "q3", "A:q3", "q4"]);

    expect((await head(999)).status).toBe(404);
    expect((await head("x")).status).toBe(400);
  });

  it("重新生成保留旧版本,可切回;旧版本下的后续对话不丢", async () => {
    const { provider } = recorder();
    const { app } = setup(provider);
    const s = await newSession(app);
    await chat(app, { sessionId: s.id, message: "q1" });
    await chat(app, { sessionId: s.id, message: "q2" });
    const orig = await list(app, s.id);
    await chat(app, { sessionId: s.id, regenerate: true });
    const now = await list(app, s.id);
    expect(now).toHaveLength(4);
    expect(now[3]!.siblings).toEqual([orig[3]!.id, now[3]!.id]);
    await app.request(`/sessions/${s.id}/head`, { method: "POST", headers: json, body: JSON.stringify({ messageId: orig[3]!.id }) });
    expect((await list(app, s.id)).map((m) => m.id)).toEqual(orig.map((m) => m.id));
    // 没有消息时不能重新生成
    const empty = await newSession(app);
    const r = await app.request("/chat", { method: "POST", headers: json, body: JSON.stringify({ sessionId: empty.id, regenerate: true }) });
    expect(r.status).toBe(400);
  });

  it("分支只复制当前路径,并保持为单链", async () => {
    const { provider } = recorder();
    const { app, db } = setup(provider);
    const s = await newSession(app);
    await chat(app, { sessionId: s.id, message: "q1" });
    await chat(app, { sessionId: s.id, message: "q2" });
    const orig = await list(app, s.id);
    await chat(app, { sessionId: s.id, message: "q2b", editOf: orig[2]!.id });
    const b = (await (await app.request(`/sessions/${s.id}/branch`, { method: "POST", headers: json, body: "{}" })).json()) as { id: string };
    const copied = await list(app, b.id);
    expect(contents(copied)).toEqual(["q1", "A:q1", "q2b", "A:q2b"]);
    expect(copied.every((m) => !m.siblings)).toBe(true);
    expect(copied.slice(1).every((m, i) => m.parentId === copied[i]!.id)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ?").get(b.id) as { c: number }).c).toBe(4);
    // 指定不在当前路径上的消息:复制它的祖先链
    const b2 = (await (await app.request(`/sessions/${s.id}/branch`, {
      method: "POST", headers: json, body: JSON.stringify({ messageId: orig[3]!.id }),
    })).json()) as { id: string };
    expect(contents(await list(app, b2.id))).toEqual(["q1", "A:q1", "q2", "A:q2"]);
  });

  it("导出 v2 / 导入保留消息树与当前分支", async () => {
    const { provider } = recorder();
    const { app } = setup(provider);
    const s = await newSession(app);
    await chat(app, { sessionId: s.id, message: "q1" });
    await chat(app, { sessionId: s.id, message: "q2" });
    const orig = await list(app, s.id);
    await chat(app, { sessionId: s.id, message: "q2b", editOf: orig[2]!.id });
    await chat(app, { sessionId: s.id, regenerate: true });
    const before = await list(app, s.id);

    const pack = (await (await app.request("/admin/export")).json()) as { version: number };
    expect(pack.version).toBe(2);
    const fresh = setup(recorder().provider);
    // 先在新库里放几条无关消息,让自增 id 错开,验证 parent / head 经过映射
    const other = await newSession(fresh.app);
    await chat(fresh.app, { sessionId: other.id, message: "x" });
    const res = await fresh.app.request("/admin/import", { method: "POST", headers: json, body: JSON.stringify(pack) });
    expect(res.status).toBe(200);
    const after = await list(fresh.app, s.id);
    expect(contents(after)).toEqual(contents(before));
    expect(after.map((m) => m.siblings?.length ?? 1)).toEqual(before.map((m) => m.siblings?.length ?? 1));
    expect((fresh.db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ?").get(s.id) as { c: number }).c).toBe(7);
    // 重复导入不产生重复
    await fresh.app.request("/admin/import", { method: "POST", headers: json, body: JSON.stringify(pack) });
    expect((fresh.db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ?").get(s.id) as { c: number }).c).toBe(7);
  });
});

describe("上下文管理(F4)", () => {
  const long = (tag: string) => `${tag}${"字".repeat(1000)}`;

  it("按 token 预算裁剪历史,标记裁剪数;摘要在后台生成并在之后的轮次带入", async () => {
    // 窗口 8000 × 0.8 − 回复预留 1000 = 5400:每条约 1000 tokens,装不下全部历史
    const { provider, calls } = recorder({ contextLength: 8000, params: { maxTokens: 1000 } });
    const summaryCalls: ChatMessage[][] = [];
    const summarizer: ChatProvider = {
      config: { id: "s", name: "s", baseUrl: "http://x", apiKey: "k", model: "s" },
      async *streamChat(messages) {
        summaryCalls.push(messages);
        yield "早先聊过 q1 到 q3 的话题";
      },
    };
    const { app, db } = setup(provider, summarizer);
    // 空工作区:避免仓库根目录的 AGENTS.md 被当作规则注入 system,挤占本轮预算(与本文件其他用例一致)
    const ws = mkdtempSync(join(tmpdir(), "xiyun-ctx-"));
    const s = await newSession(app, { workspace: ws });
    for (const q of ["q1", "q2", "q3"]) await chat(app, { sessionId: s.id, message: long(q) });
    expect(summaryCalls).toHaveLength(0);
    const evs = await chat(app, { sessionId: s.id, message: long("q4") });
    const meta = evs.find((e) => e.type === "meta") as { trim?: { dropped: number; summary: boolean } };
    expect(meta.trim?.dropped).toBeGreaterThan(0);
    expect(meta.trim?.summary).toBe(false);
    const sent = turns(calls.at(-1)!);
    // 只带入最近的历史,且从 user 开始
    expect(sent.length).toBeLessThan(7);
    expect(calls.at(-1)![1]!.role).toBe("user");
    expect(sent.at(-1)!.startsWith("q4")).toBe(true);
    const last = (await list(app, s.id)).at(-1)!;
    expect(last.trim).toEqual(meta.trim);

    // 摘要异步落库
    for (let i = 0; i < 50 && !(db.prepare("SELECT summary FROM sessions WHERE id = ?").get(s.id) as { summary: string | null }).summary; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0]![1]!.content).toContain("q1");

    const evs2 = await chat(app, { sessionId: s.id, message: "q5" });
    const meta2 = evs2.find((e) => e.type === "meta") as { trim?: { dropped: number; summary: boolean } };
    expect(meta2.trim?.summary).toBe(true);
    expect(calls.at(-1)![0]!.content).toContain("# 早先对话摘要");
    expect(calls.at(-1)![0]!.content).toContain("早先聊过 q1 到 q3 的话题");
    rmSync(ws, { recursive: true, force: true });
  });

  it("历史足够短时全部带入,不再限制为最近 20 条", async () => {
    const { provider, calls } = recorder({ contextLength: 128_000 });
    const { app } = setup(provider);
    const s = await newSession(app);
    for (let i = 1; i <= 12; i++) await chat(app, { sessionId: s.id, message: `q${i}` });
    expect(turns(calls.at(-1)!)).toHaveLength(23);
    expect((await list(app, s.id)).every((m) => !m.trim)).toBe(true);
  });

  it("引用上下文随消息落库并在之后的轮次带入;引用的文件变更后提示模型;重新生成与编辑沿用引用", async () => {
    const ws = mkdtempSync(join(tmpdir(), "xiyun-ws-"));
    writeFileSync(join(ws, "a.txt"), "v1");
    const { provider, calls } = recorder();
    const { app, db } = setup(provider);
    const s = await newSession(app, { workspace: ws });
    await chat(app, {
      sessionId: s.id, message: "看看 a.txt", context: "## a.txt\nv1",
      refs: [{ refType: "file", label: "a.txt", excerpt: "a.txt", path: "a.txt" }],
    });
    const user = db.prepare("SELECT blocks, ref_context FROM messages WHERE role = 'user'").get() as { blocks: string; ref_context: string };
    expect(user.ref_context).toBe("## a.txt\nv1");
    expect((JSON.parse(user.blocks) as Array<{ hash?: string }>)[0]!.hash).toMatch(/^[0-9a-f]{16}$/);

    // 重新生成:库里的引用上下文仍带给模型
    await chat(app, { sessionId: s.id, regenerate: true });
    expect(calls.at(-1)!.at(-1)!.content).toContain("# 引用上下文\n## a.txt\nv1");

    await chat(app, { sessionId: s.id, message: "继续" });
    expect(calls.at(-1)![1]!.content).toContain("# 引用上下文\n## a.txt\nv1");
    expect(calls.at(-1)![1]!.content).not.toContain("已修改");

    writeFileSync(join(ws, "a.txt"), "v2");
    await chat(app, { sessionId: s.id, message: "再继续" });
    expect(calls.at(-1)![1]!.content).toContain("a.txt 在引用之后已修改");

    // 编辑带引用的消息:只改文字,引用沿用
    const first = (await list(app, s.id))[0]!;
    await chat(app, { sessionId: s.id, message: "改成看 a.txt 的结构", editOf: first.id });
    const edited = (await list(app, s.id))[0]!;
    expect(edited.content).toBe("改成看 a.txt 的结构");
    expect(edited.blocks).toHaveLength(1);
    expect(calls.at(-1)!.at(-1)!.content).toContain("# 引用上下文\n## a.txt\nv1");
    rmSync(ws, { recursive: true, force: true });
  });
});
