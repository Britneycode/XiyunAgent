import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderConfig, SessionMeta } from "@xiyun/shared";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";

const json = { "Content-Type": "application/json" };

// 记录发给模型服务的请求;按 OpenAI / Anthropic 协议各回一条最短的流
function stubModels() {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (!init?.body) return new Response(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }] }), { status: 200 });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body, headers: init.headers as Record<string, string> });
      const sse = url.endsWith("/messages")
        ? `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "嗨" } })}\n\ndata: {"type":"message_stop"}\n\n`
        : `data: ${JSON.stringify({ choices: [{ delta: { content: "嗨" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200 });
    }),
  );
  return calls;
}

const P1: ProviderConfig = {
  id: "p1", name: "OpenAI", baseUrl: "https://oa.test/v1", apiKey: "sk-1", model: "gpt-a", models: [{ id: "gpt-b", contextLength: 32000 }],
};
const P2: ProviderConfig = {
  id: "p2", name: "Claude", protocol: "anthropic", baseUrl: "https://an.test", apiKey: "sk-2", model: "claude-a", headers: { "x-secret": "raw" },
};

function setup() {
  const db = openDb(":memory:");
  const store = new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-models-")));
  store.upsert({ ...P1 });
  store.upsert({ ...P2 });
  const app = createApp(db, new MemoryStore(db), store, { titleProvider: () => undefined });
  return { app, db, store };
}
type App = ReturnType<typeof setup>["app"];

async function newSession(app: App) {
  return (await (await app.request("/sessions", { method: "POST", headers: json, body: JSON.stringify({ mode: "chat" }) })).json()) as SessionMeta;
}
const patch = (app: App, id: string, body: unknown) =>
  app.request(`/sessions/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
const chat = async (app: App, body: unknown) => (await app.request("/chat", { method: "POST", headers: json, body: JSON.stringify(body) })).text();
const messages = async (app: App, id: string) =>
  (await (await app.request(`/sessions/${id}/messages`)).json()) as Array<{ role: string; model?: string }>;

// 后台的记忆提取也会调用模型:按最后一条消息找出本次对话请求
type Calls = ReturnType<typeof stubModels>;
const sent = (calls: Calls, msg: string) =>
  calls.find((c) => {
    const ms = c.body.messages as Array<{ content: unknown }> | undefined;
    return ms?.[ms.length - 1]?.content === msg;
  });

afterEach(() => vi.unstubAllGlobals());

describe("会话级模型(M3)", () => {
  it("默认跟随全局激活 Provider,assistant 消息记录模型", async () => {
    const calls = stubModels();
    const { app } = setup();
    const s = await newSession(app);
    expect(s.providerId ?? null).toBeNull();
    const text = await chat(app, { sessionId: s.id, message: "m1" });
    expect(text).toContain('"model":"gpt-a"');
    expect(sent(calls, "m1")?.url).toBe("https://oa.test/v1/chat/completions");
    expect(sent(calls, "m1")?.body.model).toBe("gpt-a");
    expect((await messages(app, s.id)).find((m) => m.role === "assistant")?.model).toBe("gpt-a");
  });

  it("PATCH providerId/model 后按会话模型请求(含其它协议);null 恢复跟随全局", async () => {
    const calls = stubModels();
    const { app } = setup();
    const s = await newSession(app);
    expect((await patch(app, s.id, { providerId: "p1", model: "gpt-b" })).status).toBe(200);
    const list = (await (await app.request("/sessions")).json()) as SessionMeta[];
    expect(list[0]).toMatchObject({ providerId: "p1", model: "gpt-b" });
    await chat(app, { sessionId: s.id, message: "m1" });
    expect(sent(calls, "m1")?.body.model).toBe("gpt-b");

    await patch(app, s.id, { providerId: "p2" });
    await chat(app, { sessionId: s.id, message: "m2" });
    expect(sent(calls, "m2")?.url).toBe("https://an.test/v1/messages");
    expect(sent(calls, "m2")?.body.model).toBe("claude-a");
    expect(sent(calls, "m2")?.headers["x-api-key"]).toBe("sk-2");
    expect((await messages(app, s.id)).filter((m) => m.role === "assistant").map((m) => m.model)).toEqual(["gpt-b", "claude-a"]);

    await patch(app, s.id, { providerId: null, model: "ignored" });
    expect(((await (await app.request("/sessions")).json()) as SessionMeta[])[0]).toMatchObject({ providerId: null, model: null });
  });

  it("请求体 providerId/model 优先于会话设置;未知模型回退默认模型", async () => {
    const calls = stubModels();
    const { app } = setup();
    const s = await newSession(app);
    await patch(app, s.id, { providerId: "p2" });
    await chat(app, { sessionId: s.id, message: "m1", providerId: "p1", model: "gpt-b" });
    expect(sent(calls, "m1")?.body.model).toBe("gpt-b");
    await chat(app, { sessionId: s.id, message: "m2", providerId: "p1", model: "nope" });
    expect(sent(calls, "m2")?.body.model).toBe("gpt-a");
  });

  it("会话指向已删除的 Provider 时回退全局模型", async () => {
    const calls = stubModels();
    const { app, store } = setup();
    const s = await newSession(app);
    await patch(app, s.id, { providerId: "p2" });
    store.removeProvider("p2");
    await chat(app, { sessionId: s.id, message: "m1" });
    expect(sent(calls, "m1")?.body.model).toBe("gpt-a");
  });

  it("分支会话沿用模型选择", async () => {
    stubModels();
    const { app } = setup();
    const s = await newSession(app);
    await patch(app, s.id, { providerId: "p1", model: "gpt-b" });
    await chat(app, { sessionId: s.id, message: "hi" });
    const b = (await (await app.request(`/sessions/${s.id}/branch`, { method: "POST", headers: json, body: "{}" })).json()) as SessionMeta;
    expect(b).toMatchObject({ providerId: "p1", model: "gpt-b" });
    expect((await messages(app, b.id)).find((m) => m.role === "assistant")?.model).toBe("gpt-b");
  });
});

describe("Provider 配置(M2)", () => {
  it("附加头回显掩码,保存掩码时保留原值;{apiKey} 占位原样返回", async () => {
    const { app, store } = setup();
    const list = (await (await app.request("/providers")).json()) as ProviderConfig[];
    const p2 = list.find((p) => p.id === "p2")!;
    expect(p2.headers).toEqual({ "x-secret": "********" });
    expect(p2.protocol).toBe("anthropic");
    await app.request("/providers", { method: "POST", headers: json, body: JSON.stringify({ ...p2, headers: { ...p2.headers, "api-key": "{apiKey}" } }) });
    const again = ((await (await app.request("/providers")).json()) as ProviderConfig[]).find((p) => p.id === "p2")!;
    expect(again.headers).toEqual({ "x-secret": "********", "api-key": "{apiKey}" });
    // 内部仍是原值
    expect(store.probeProvider("p2")?.config.headers?.["x-secret"]).toBe("raw");
    expect(store.probeProvider("p2")?.config.apiKey).toBe("sk-2");
  });

  it("未知协议按 openai 保存;GET /providers/:id/models 返回排序后的模型 id", async () => {
    stubModels();
    const { app, store } = setup();
    await app.request("/providers", { method: "POST", headers: json, body: JSON.stringify({ ...P1, id: "p3", protocol: "weird" }) });
    expect(store.probeProvider("p3")?.config.protocol).toBe("openai");
    const r = (await (await app.request("/providers/p1/models")).json()) as { models: string[] };
    expect(r.models).toEqual(["a-model", "z-model"]);
    expect((await app.request("/providers/none/models")).status).toBe(404);
  });
});
