import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatProvider, ProviderEvent } from "../../runtime/src/index.ts";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";

function fakeProvider(events: ProviderEvent[], opts: { toolsCap?: boolean; onlyText?: boolean } = {}): ChatProvider {
  const provider: ChatProvider = {
    config: {
      id: "fake", name: "fake", baseUrl: "http://x", apiKey: "k", model: "m",
      capabilities: opts.toolsCap ? ["stream", "tools"] : ["stream"],
    },
    async *streamChat() {
      for (const ev of events) if (ev.type === "text") yield ev.delta;
    },
  };
  if (!opts.onlyText) {
    provider.streamEvents = async function* () {
      for (const ev of events) yield ev;
    };
  }
  return provider;
}

function setup(provider: ChatProvider) {
  const db = openDb(":memory:");
  const app = createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-chat-"))), {
    chatProvider: () => provider,
  });
  return { app, db };
}

const json = { "Content-Type": "application/json" };

async function post(app: ReturnType<typeof setup>["app"], body: unknown) {
  const res = await app.request("/chat", { method: "POST", headers: json, body: JSON.stringify(body) });
  return res;
}

function parseSSE(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);
}

async function session(app: ReturnType<typeof setup>["app"]) {
  const res = await app.request("/sessions", { method: "POST", headers: json, body: JSON.stringify({ mode: "chat" }) });
  return (await res.json()) as { id: string };
}

describe("/chat 块协议", () => {
  it("thinking → text → tool → text:事件顺序与落库一致", async () => {
    const { app, db } = setup(fakeProvider([
      { type: "thinking", delta: "想" },
      { type: "text", delta: "答" },
      { type: "tool_start", id: "c1", index: 0, name: "read_file" },
      { type: "tool_args", id: "c1", delta: "{\"path\":\"a.ts\"}" },
      { type: "tool_end", id: "c1", args: "{\"path\":\"a.ts\"}" },
      { type: "finish", reason: "tool_calls" },
    ]));
    const s = await session(app);
    const evs = parseSSE(await (await post(app, { sessionId: s.id, message: "hi" })).text());
    const kinds = evs.filter((e) => e.type === "block").map((e) => (e.block as { kind: string }).kind);
    expect(kinds).toEqual(["thinking", "text", "tool"]);
    expect(evs.some((e) => typeof e.delta === "string" && e.delta === "答")).toBe(true);
    const end = evs.find((e) => e.type === "block_end" && (e.block as { kind: string }).kind === "tool") as {
      block: { status: string; args: unknown; rawArgs: string };
    };
    expect(end.block.status).toBe("pending");
    expect(end.block.args).toEqual({ path: "a.ts" });
    expect(end.block.rawArgs).toBe("{\"path\":\"a.ts\"}");

    const row = db.prepare("SELECT content, blocks, aborted FROM messages WHERE role = 'assistant'").get() as {
      content: string; blocks: string; aborted: number;
    };
    expect(row.content).toBe("答");
    const blocks = JSON.parse(row.blocks) as Array<{ kind: string }>;
    expect(blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool"]);
    expect(row.aborted).toBe(0);
  });

  it("只有 streamChat 的 Provider 回退为纯文本", async () => {
    const { app } = setup(fakeProvider([{ type: "text", delta: "回退" }], { onlyText: true }));
    const s = await session(app);
    const evs = parseSSE(await (await post(app, { sessionId: s.id, message: "hi" })).text());
    expect(evs.some((e) => e.delta === "回退")).toBe(true);
    expect(evs.some((e) => e.type === "block")).toBe(true);
    expect(evs.at(-1)?.done).toBe(true);
  });

  it("无 tools capability 时不产生工具块所需的下发(事件仍展示)", async () => {
    const { app } = setup(fakeProvider([
      { type: "tool_start", id: "c1", index: 0, name: "read_file" },
      { type: "tool_end", id: "c1", args: "{}" },
      { type: "finish", reason: "tool_calls" },
    ]));
    const s = await session(app);
    const evs = parseSSE(await (await post(app, { sessionId: s.id, message: "hi" })).text());
    // 仍然展示卡片
    expect(evs.some((e) => e.type === "block" && (e.block as { kind: string }).kind === "tool")).toBe(true);
    // 但空正文被兜底补上,content 非空
    const textEnd = evs.find((e) => e.type === "block_end" && (e.block as { kind: string }).kind === "text");
    expect(textEnd).toBeTruthy();
  });

  it("工具参数非法时 status=error 且保留 rawArgs", async () => {
    const { app } = setup(fakeProvider([
      { type: "tool_start", id: "c1", index: 0, name: "read_file" },
      { type: "tool_args", id: "c1", delta: "{bad" },
      { type: "tool_end", id: "c1", args: "{bad" },
      { type: "finish", reason: "tool_calls" },
    ]));
    const s = await session(app);
    const evs = parseSSE(await (await post(app, { sessionId: s.id, message: "hi" })).text());
    const end = evs.find((e) => e.type === "block_end" && (e.block as { kind: string }).kind === "tool") as {
      block: { status: string; rawArgs: string; argsError?: string };
    };
    expect(end.block.status).toBe("error");
    expect(end.block.rawArgs).toBe("{bad");
    expect(end.block.argsError).toBeTruthy();
  });

  it("并发工具调用按调用 id 归集参数与结果", async () => {
    const { app, db } = setup(fakeProvider([
      { type: "tool_start", id: "c1", index: 0, name: "read_file" },
      { type: "tool_start", id: "c2", index: 1, name: "list_files" },
      { type: "tool_args", id: "c2", delta: "{\"path\":\"src\"}" },
      { type: "tool_args", id: "c1", delta: "{\"path\":\"b.ts\"}" },
      { type: "tool_end", id: "c1", args: "{\"path\":\"b.ts\"}" },
      { type: "tool_end", id: "c2", args: "{\"path\":\"src\"}" },
      { type: "finish", reason: "tool_calls" },
    ]));
    const s = await session(app);
    const evs = parseSSE(await (await post(app, { sessionId: s.id, message: "hi" })).text());
    const toolEnds = evs.filter((e) => e.type === "block_end" && (e.block as { kind: string }).kind === "tool");
    expect(toolEnds.map((e) => e.id)).toEqual(["c1", "c2"]);
    expect((toolEnds[0].block as { name: string; rawArgs: string; status: string })).toMatchObject({
      name: "read_file", rawArgs: "{\"path\":\"b.ts\"}", status: "pending",
    });
    expect((toolEnds[1].block as { name: string; rawArgs: string; status: string })).toMatchObject({
      name: "list_files", rawArgs: "{\"path\":\"src\"}", status: "pending",
    });
    const row = db.prepare("SELECT blocks FROM messages WHERE role = 'assistant'").get() as { blocks: string };
    const tools = (JSON.parse(row.blocks) as Array<{ kind: string; id: string; rawArgs: string }>).filter((b) => b.kind === "tool");
    expect(tools.map((b) => [b.id, b.rawArgs])).toEqual([
      ["c1", "{\"path\":\"b.ts\"}"],
      ["c2", "{\"path\":\"src\"}"],
    ]);
  });

  it("context 不进入 content,refs 落为 ref 块", async () => {
    let seen: Array<{ role: string; content: string }> = [];
    const provider = fakeProvider([{ type: "text", delta: "ok" }, { type: "finish", reason: "stop" }]);
    const orig = provider.streamEvents!;
    provider.streamEvents = async function* (messages, opts) {
      seen = messages.map((m) => ({ role: m.role, content: m.content }));
      yield* orig(messages, opts);
    };
    const { app, db } = setup(provider);
    const s = await session(app);
    await post(app, {
      sessionId: s.id,
      message: "原话",
      context: "引用内容",
      refs: [{ refType: "doc", label: "文档A", excerpt: "片段" }],
    });
    const lastUser = seen.filter((m) => m.role === "user").at(-1)!;
    expect(lastUser.content).toContain("引用内容");
    const userRow = db.prepare("SELECT content, blocks FROM messages WHERE role = 'user'").get() as {
      content: string; blocks: string;
    };
    expect(userRow.content).toBe("原话");
    expect(JSON.parse(userRow.blocks)).toEqual([
      { id: expect.any(String), kind: "ref", refType: "doc", label: "文档A", excerpt: "片段" },
    ]);
  });

  it("出错时只发 error 尾行,不落 assistant", async () => {
    const failing: ChatProvider = {
      config: { id: "f2", name: "f2", baseUrl: "http://x", apiKey: "k", model: "m" },
      async *streamChat() { throw new Error("boom"); },
      async *streamEvents() {
        yield { type: "text", delta: "半" } as ProviderEvent;
        throw new Error("boom");
      },
    };
    const { app, db } = setup(failing);
    const s = await session(app);
    const evs = parseSSE(await (await post(app, { sessionId: s.id, message: "q" })).text());
    expect(evs.at(-1)?.error).toBe("boom");
    expect(evs.some((e) => e.done === true)).toBe(false);
    expect((db.prepare("SELECT COUNT(*) c FROM messages WHERE role = 'assistant'").get() as { c: number }).c).toBe(0);
  });

  it("regenerate 出错时不删除上一轮 assistant", async () => {
    const failing: ChatProvider = {
      config: { id: "f", name: "f", baseUrl: "http://x", apiKey: "k", model: "m" },
      async *streamChat() { throw new Error("boom"); },
      async *streamEvents() {
        yield { type: "text", delta: "半" } as ProviderEvent;
        throw new Error("boom");
      },
    };
    const { app, db } = setup(failing);
    const s = await session(app);
    await post(app, { sessionId: s.id, message: "q1" });
    // 失败后手动补一条上一轮 assistant,模拟 A1 已存在
    db.prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'assistant', 'A1', 't')").run(s.id);
    await post(app, { sessionId: s.id, message: "q2" });
    const rows = db.prepare("SELECT content FROM messages WHERE role = 'assistant'").all() as Array<{ content: string }>;
    expect(rows.map((r) => r.content)).toContain("A1");
  });

  it("regenerate 成功时替换末条 assistant;末条为 user 时不误删更早的 assistant", async () => {
    // reply 控制每次回复内容;fail 控制下一次流是否报错
    let reply = "A1";
    let fail = false;
    const provider: ChatProvider = {
      config: { id: "r", name: "r", baseUrl: "http://x", apiKey: "k", model: "m" },
      async *streamChat() {},
      async *streamEvents() {
        if (fail) {
          yield { type: "text", delta: "半" } as ProviderEvent;
          throw new Error("boom");
        }
        yield { type: "text", delta: reply } as ProviderEvent;
        yield { type: "finish", reason: "stop" } as ProviderEvent;
      },
    };
    const { app, db } = setup(provider);
    const s = await session(app);
    // 读掉响应体:不消费 SSE 会让服务端写阻塞,收尾落库晚于断言
    await (await post(app, { sessionId: s.id, message: "q1" })).text();
    // 末条是 assistant:regenerate 替换它
    reply = "A2";
    await (await post(app, { sessionId: s.id, message: "q1", regenerate: true })).text();
    expect((db.prepare("SELECT content FROM messages WHERE role = 'assistant' ORDER BY id").all() as Array<{ content: string }>).map((r) => r.content)).toEqual(["A2"]);

    // U1/A1(q1)/U2(q2):q2 失败后末条是 user,regenerate 成功时不得删除 A1
    fail = true;
    await (await post(app, { sessionId: s.id, message: "q2" })).text();
    fail = false;
    reply = "A3";
    await (await post(app, { sessionId: s.id, message: "q2", regenerate: true })).text();
    expect((db.prepare("SELECT content FROM messages WHERE role = 'assistant' ORDER BY id").all() as Array<{ content: string }>).map((r) => r.content)).toEqual(["A2", "A3"]);
    // user 消息不因 regenerate 重复写入
    expect((db.prepare("SELECT COUNT(*) c FROM messages WHERE role = 'user'").get() as { c: number }).c).toBe(2);
  });

  it("XIYUN_EXPOSE_TOOLS=1 且声明 tools 能力时才下发只读工具定义", async () => {
    let seenTools: string[] | undefined;
    const provider = fakeProvider([{ type: "text", delta: "ok" }, { type: "finish", reason: "stop" }], { toolsCap: true });
    const orig = provider.streamEvents!;
    provider.streamEvents = async function* (messages, opts) {
      seenTools = opts?.tools?.map((t) => t.name);
      yield* orig(messages, opts);
    };
    const { app } = setup(provider);
    const s = await session(app);
    await post(app, { sessionId: s.id, message: "a" });
    expect(seenTools).toBeUndefined();
    process.env.XIYUN_EXPOSE_TOOLS = "1";
    try {
      await post(app, { sessionId: s.id, message: "b" });
      expect(seenTools).toEqual(["list_files", "read_file"]);
    } finally {
      delete process.env.XIYUN_EXPOSE_TOOLS;
    }
  });

  it("中断时落半截并标记 aborted", async () => {
    // 用内部 AbortController 模拟 stream.onAbort:假 Provider 挂起,触发 abort 后抛 AbortError
    let internal!: AbortController;
    const provider: ChatProvider = {
      config: { id: "a", name: "a", baseUrl: "http://x", apiKey: "k", model: "m" },
      async *streamChat() {},
      async *streamEvents() {
        yield { type: "text", delta: "半截" };
        await new Promise((_, rej) => {
          internal.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      },
    };
    const { app, db } = setup(provider);
    const s = await session(app);
    internal = new AbortController();
    const p = app.request("/chat", {
      method: "POST", headers: json, body: JSON.stringify({ sessionId: s.id, message: "q" }), signal: internal.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    internal.abort();
    await p.catch(() => {});
    // 等服务端收尾落库
    await new Promise((r) => setTimeout(r, 50));
    const row = db.prepare("SELECT content, aborted FROM messages WHERE role = 'assistant'").get() as
      | { content: string; aborted: number }
      | undefined;
    expect(row?.aborted).toBe(1);
    expect(row?.content).toBe("半截");
  });

  it("Provider 不响应中断信号时也能落半截并收尾", async () => {
    // 这个 fake 忽略 signal,只靠服务端的中断竞速收尾
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider: ChatProvider = {
      config: { id: "s", name: "s", baseUrl: "http://x", apiKey: "k", model: "m" },
      async *streamChat() {},
      async *streamEvents() {
        yield { type: "text", delta: "半" };
        await gate;
        yield { type: "text", delta: "尾" };
      },
    };
    const { app, db } = setup(provider);
    const s = await session(app);
    const internal = new AbortController();
    const p = app.request("/chat", {
      method: "POST", headers: json, body: JSON.stringify({ sessionId: s.id, message: "q" }), signal: internal.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    internal.abort();
    await p.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const row = db.prepare("SELECT content, aborted FROM messages WHERE role = 'assistant'").get() as
      | { content: string; aborted: number }
      | undefined;
    expect(row?.aborted).toBe(1);
    expect(row?.content).toBe("半");
    release();
  });

  it("中断前没有任何内容时不落 assistant 行", async () => {
    let internal!: AbortController;
    const provider: ChatProvider = {
      config: { id: "e", name: "e", baseUrl: "http://x", apiKey: "k", model: "m" },
      async *streamChat() {},
      async *streamEvents() {
        await new Promise((_, rej) => {
          internal.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
        yield { type: "text", delta: "never" } as ProviderEvent;
      },
    };
    const { app, db } = setup(provider);
    const s = await session(app);
    internal = new AbortController();
    const p = app.request("/chat", {
      method: "POST", headers: json, body: JSON.stringify({ sessionId: s.id, message: "q" }), signal: internal.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    internal.abort();
    await p.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect((db.prepare("SELECT COUNT(*) c FROM messages WHERE role = 'assistant'").get() as { c: number }).c).toBe(0);
  });
});
