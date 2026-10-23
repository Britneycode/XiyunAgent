import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderConfig, SessionMeta } from "@xiyun/shared";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";

// L5:跨厂商回退的落库模型与超预算降级。app 级用例,校验的是 /chat 实际发出的请求与落库结果。

const json = { "Content-Type": "application/json" };

// 两家都绑定 main 角色,回退链才包含第二家
const P1: ProviderConfig = {
  id: "p1", name: "OpenAI", baseUrl: "https://oa.test/v1", apiKey: "sk-1", model: "gpt-a",
  roles: ["main"],
  models: [
    { id: "gpt-a", pricing: { input: 10, output: 30 } },
    { id: "gpt-cheap", pricing: { input: 0.1, output: 0.2 } },
  ],
};
const P2: ProviderConfig = {
  id: "p2", name: "Claude", protocol: "anthropic", baseUrl: "https://an.test", apiKey: "sk-2",
  model: "claude-a", roles: ["main"],
  models: [{ id: "claude-a", pricing: { input: 5, output: 15 } }],
};

function setup() {
  const db = openDb(":memory:");
  const store = new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-usage-")));
  store.upsert({ ...P1 });
  store.upsert({ ...P2 });
  const app = createApp(db, new MemoryStore(db), store, { titleProvider: () => undefined });
  return { app, db, store };
}
type App = ReturnType<typeof setup>["app"];

const text = (s: string) =>
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } })}\n\ndata: {"type":"message_stop"}\n\n`;
const openaiText = (s: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: s }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

async function newSession(app: App) {
  return (await (await app.request("/sessions", { method: "POST", headers: json, body: JSON.stringify({ mode: "chat" }) })).json()) as SessionMeta;
}
const chat = async (app: App, body: unknown) => (await app.request("/chat", { method: "POST", headers: json, body: JSON.stringify(body) })).text();
const messages = async (app: App, id: string) =>
  (await (await app.request(`/sessions/${id}/messages`)).json()) as Array<{ role: string; model?: string }>;

afterEach(() => vi.unstubAllGlobals());

describe("L5 回退与预算", () => {
  it("第一家 503、第二家成功:落库记录接手的模型", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        // retry-after-ms:0 让适配器自身的重试立即结束,不拖慢用例
        if (url.startsWith("https://oa.test")) return new Response("overloaded", { status: 503, headers: { "retry-after-ms": "0" } });
        return new Response(text("接手方答复"), { status: 200 });
      }),
    );
    const { app } = setup();
    const s = await newSession(app);
    const out = await chat(app, { sessionId: s.id, message: "m1" });
    expect(out).toContain("接手方答复");
    expect(out).toContain('"fallback"');
    // 接手方真的收到了请求,且用的是它的默认模型
    expect(calls.some((c) => c.url === "https://an.test/v1/messages" && c.body.model === "claude-a")).toBe(true);
    // 落库的是实际完成本次运行的模型,不是最初选的那家
    expect((await messages(app, s.id)).find((m) => m.role === "assistant")?.model).toBe("claude-a");
  });

  it("超预算后降级到最低价模型,并下发 downgraded", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
        return new Response(openaiText("好"), { status: 200 });
      }),
    );
    const { app, db, store } = setup();
    store.updateSettings({ dailyBudget: 1 });
    // 今天已经花掉 5,超过 1 的日预算
    db.prepare(
      `INSERT INTO usage_ledger (id, at, session_id, message_id, task_id, provider_id, model, prompt, completion, cached, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("seed", new Date().toISOString(), null, null, null, "p1", "gpt-a", 1000, 0, 0, 5);

    const s = await newSession(app);
    const out = await chat(app, { sessionId: s.id, message: "m1" });
    expect(out).toContain('"downgraded"');
    expect(out).toContain("gpt-cheap");
    // 请求真的发给了最低价模型,落库也记它
    expect(calls.some((c) => c.url === "https://oa.test/v1/chat/completions" && c.body.model === "gpt-cheap")).toBe(true);
    expect((await messages(app, s.id)).find((m) => m.role === "assistant")?.model).toBe("gpt-cheap");
  });

  it("用户显式指定模型时不降级,只提示", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
        return new Response(text("好"), { status: 200 });
      }),
    );
    const { app, db, store } = setup();
    store.updateSettings({ dailyBudget: 1 });
    db.prepare(
      `INSERT INTO usage_ledger (id, at, session_id, message_id, task_id, provider_id, model, prompt, completion, cached, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("seed", new Date().toISOString(), null, null, null, "p1", "gpt-a", 1000, 0, 0, 5);

    const s = await newSession(app);
    const out = await chat(app, { sessionId: s.id, message: "m1", providerId: "p2" });
    expect(out).toContain("按你指定的模型继续");
    expect(calls.some((c) => c.url === "https://an.test/v1/messages" && c.body.model === "claude-a")).toBe(true);
    expect((await messages(app, s.id)).find((m) => m.role === "assistant")?.model).toBe("claude-a");
  });
});
