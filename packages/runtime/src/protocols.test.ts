import { afterEach, describe, expect, it, vi } from "vitest";
import { modelsOf, withModel, type ProviderConfig } from "@xiyun/shared";
import { createProvider, ProviderError, type ProviderEvent } from "./index.ts";
import { geminiSchema } from "./gemini.ts";

function sse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const s of chunks) c.enqueue(enc.encode(s));
        c.close();
      },
    }),
    { status },
  );
}
const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const evt = (type: string, obj: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;

type Call = { url: string; init: RequestInit };
function mockFetch(res: () => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return res();
    }),
  );
  return calls;
}
const body = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, unknown>;
const hdr = (c: Call) => c.init.headers as Record<string, string>;

async function run(config: ProviderConfig, tools?: Array<{ name: string; description: string; parameters: object }>) {
  const out: ProviderEvent[] = [];
  const msgs = [
    { role: "system" as const, content: "你是助手" },
    { role: "user" as const, content: "你好" },
  ];
  for await (const ev of createProvider(config, { retries: 0 }).streamEvents!(msgs, tools ? { tools } : undefined)) out.push(ev);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

const base: ProviderConfig = { id: "p", name: "t", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-secret", model: "claude-x" };

describe("Anthropic 适配器", () => {
  it("请求格式:/v1/messages、x-api-key、system 顶层、max_tokens 缺省 8192", async () => {
    const calls = mockFetch(() => sse([evt("message_stop", {})]));
    await run({ ...base, protocol: "anthropic" });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(hdr(calls[0]!)["x-api-key"]).toBe("sk-ant-secret");
    expect(hdr(calls[0]!)["anthropic-version"]).toBe("2023-06-01");
    expect(hdr(calls[0]!).Authorization).toBeUndefined();
    const b = body(calls[0]!);
    expect(b).toMatchObject({ model: "claude-x", max_tokens: 8192, system: "你是助手", stream: true });
    expect(b.messages).toEqual([{ role: "user", content: "你好" }]);
  });

  it("baseUrl 已带 /v1 时不重复;reasoningEffort 开启 thinking 且不发 temperature", async () => {
    const calls = mockFetch(() => sse([evt("message_stop", {})]));
    await run({ ...base, protocol: "anthropic", baseUrl: "https://gw.test/v1/", params: { reasoningEffort: "low", temperature: 0.3, maxTokens: 1000 } });
    expect(calls[0]?.url).toBe("https://gw.test/v1/messages");
    const b = body(calls[0]!);
    expect(b.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(b.max_tokens).toBe(2048 + 4096);
    expect(b.temperature).toBeUndefined();
  });

  it("流式事件:文本、思考、工具调用、用量与结束原因", async () => {
    mockFetch(() =>
      sse([
        evt("message_start", { message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } } }),
        evt("content_block_start", { index: 0, content_block: { type: "thinking" } }),
        evt("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "想想" } }),
        evt("content_block_stop", { index: 0 }),
        evt("content_block_start", { index: 1, content_block: { type: "text" } }),
        evt("content_block_delta", { index: 1, delta: { type: "text_delta", text: "你" } }),
        evt("ping", {}),
        evt("content_block_delta", { index: 1, delta: { type: "text_delta", text: "好" } }),
        evt("content_block_stop", { index: 1 }),
        evt("content_block_start", { index: 2, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } }),
        evt("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } }),
        evt("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } }),
        evt("content_block_stop", { index: 2 }),
        evt("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }),
        evt("message_stop", {}),
      ]),
    );
    const out = await run({ ...base, protocol: "anthropic" }, [{ name: "read_file", description: "d", parameters: { type: "object" } }]);
    expect(out).toEqual([
      { type: "thinking", delta: "想想" },
      { type: "text", delta: "你" },
      { type: "text", delta: "好" },
      { type: "tool_start", id: "tu_1", index: 2, name: "read_file" },
      { type: "tool_args", id: "tu_1", delta: '{"path":' },
      { type: "tool_args", id: "tu_1", delta: '"a.ts"}' },
      { type: "tool_end", id: "tu_1", args: '{"path":"a.ts"}' },
      // 有工具调用时回传原样内容块;没有签名的 thinking 块去掉
      {
        type: "raw",
        protocol: "anthropic",
        content: [
          { type: "text", text: "你好" },
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      { type: "usage", usage: { promptTokens: 15, completionTokens: 42, totalTokens: 57, cachedTokens: 5 } },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("工具定义转成 input_schema;HTTP 错误归一化且不泄露 Key", async () => {
    const calls = mockFetch(() =>
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-ant-secret" } }), { status: 401 }),
    );
    const err = await run({ ...base, protocol: "anthropic" }, [{ name: "t", description: "d", parameters: { type: "object" } }]).catch((e) => e);
    expect(body(calls[0]!).tools).toEqual([{ name: "t", description: "d", input_schema: { type: "object" } }]);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(401);
    expect((err as Error).message).toContain("鉴权失败");
    expect((err as Error).message).not.toContain("sk-ant-secret");
  });

  it("流内 error 事件抛出可读错误;相邻同角色消息合并、首条补 user", async () => {
    const calls = mockFetch(() => sse([evt("content_block_delta", { index: 0, delta: { type: "text_delta", text: "半" } }), evt("error", { error: { type: "overloaded_error", message: "Overloaded" } })]));
    const out: ProviderEvent[] = [];
    const p = createProvider({ ...base, protocol: "anthropic" }, { retries: 0 });
    const err = await (async () => {
      for await (const ev of p.streamEvents!([
        { role: "assistant", content: "上次" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "" },
      ]))
        out.push(ev);
    })().catch((e) => e);
    expect(out).toEqual([{ type: "text", delta: "半" }]);
    expect((err as ProviderError).status).toBe(529);
    expect((err as Error).message).toContain("Overloaded");
    expect(body(calls[0]!).messages).toEqual([
      { role: "user", content: "(continue)" },
      { role: "assistant", content: "上次" },
      { role: "user", content: "a\n\nb" },
    ]);
  });
});

describe("Gemini 适配器", () => {
  const g: ProviderConfig = { ...base, protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "AIza-secret", model: "gemini-2.5-flash" };

  it("请求格式:补 /v1beta、alt=sse、x-goog-api-key、systemInstruction、model 角色、思考预算", async () => {
    const calls = mockFetch(() => sse([]));
    const p = createProvider({ ...g, params: { temperature: 0.2, maxTokens: 512, reasoningEffort: "medium" } }, { retries: 0 });
    for await (const _ of p.streamEvents!([
      { role: "system", content: "S" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
      { role: "user", content: "u2" },
    ]));
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(hdr(calls[0]!)["x-goog-api-key"]).toBe("AIza-secret");
    const b = body(calls[0]!);
    expect(b.systemInstruction).toEqual({ parts: [{ text: "S" }] });
    expect(b.contents).toEqual([
      { role: "user", parts: [{ text: "u" }] },
      { role: "model", parts: [{ text: "a" }] },
      { role: "user", parts: [{ text: "u2" }] },
    ]);
    expect(b.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } });
  });

  it("流式:思考 / 正文 / 函数调用 / 用量", async () => {
    mockFetch(() =>
      sse([
        data({ candidates: [{ content: { parts: [{ text: "推理", thought: true }] } }] }),
        data({ candidates: [{ content: { parts: [{ text: "好的" }] } }] }),
        data({
          candidates: [{ content: { parts: [{ functionCall: { name: "search", args: { q: "x" } } }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 12 },
        }),
      ]),
    );
    const out = await run(g);
    expect(out).toEqual([
      { type: "thinking", delta: "推理" },
      { type: "text", delta: "好的" },
      { type: "tool_start", id: "call_0", index: 0, name: "search" },
      { type: "tool_args", id: "call_0", delta: '{"q":"x"}' },
      { type: "tool_end", id: "call_0", args: '{"q":"x"}' },
      { type: "raw", protocol: "gemini", content: [{ text: "好的" }, { functionCall: { name: "search", args: { q: "x" } } }] },
      { type: "usage", usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12, reasoningTokens: 2 } },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("schema 去掉 Gemini 不认的关键字,但保留同名参数", () => {
    expect(
      geminiSchema({
        type: "object",
        additionalProperties: false,
        $schema: "x",
        properties: { default: { type: "string", default: "a" }, n: { type: "array", items: { type: "number", const: 1 } } },
      }),
    ).toEqual({ type: "object", properties: { default: { type: "string" }, n: { type: "array", items: { type: "number" } } } });
  });
});

describe("OpenAI 适配器的附加头 / 查询参数 / 生成参数", () => {
  it("Azure:api-key 头用 {apiKey} 占位时不再发 Bearer,带 api-version", async () => {
    const calls = mockFetch(() => sse(["data: [DONE]\n\n"]));
    await run({
      ...base,
      protocol: "openai",
      baseUrl: "https://r.openai.azure.com/openai/deployments/gpt4o/",
      headers: { "api-key": "{apiKey}" },
      query: { "api-version": "2024-10-21" },
      params: { temperature: 0.5, maxTokens: 100, reasoningEffort: "high" },
    });
    expect(calls[0]?.url).toBe("https://r.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21");
    expect(hdr(calls[0]!)["api-key"]).toBe("sk-ant-secret");
    expect(hdr(calls[0]!).Authorization).toBeUndefined();
    expect(body(calls[0]!)).toMatchObject({ temperature: 0.5, max_tokens: 100, reasoning_effort: "high" });
  });

  it("未设协议按 OpenAI 兼容;listModels 解析 data[].id", async () => {
    const calls = mockFetch(() => new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), { status: 200 }));
    const ids = await createProvider({ ...base, baseUrl: "https://x.test/v1" }).listModels!();
    expect(ids).toEqual(["a", "b"]);
    expect(calls[0]?.url).toBe("https://x.test/v1/models");
    expect(hdr(calls[0]!).Authorization).toBe("Bearer sk-ant-secret");
  });
});

describe("模型列表(modelsOf / withModel)", () => {
  const c: ProviderConfig = {
    ...base,
    model: "big",
    contextLength: 128000,
    capabilities: ["tools"],
    models: [{ id: "small", contextLength: 32000 }, { id: "big" }, { id: "vis", capabilities: ["vision"] }, { id: " " }],
  };
  it("默认模型在首位、去重、继承 Provider 级上下文与能力", () => {
    expect(modelsOf(c)).toEqual([
      { id: "big", contextLength: 128000, capabilities: ["tools"] },
      { id: "small", contextLength: 32000, capabilities: ["tools"] },
      { id: "vis", contextLength: 128000, capabilities: ["vision"] },
    ]);
  });
  it("withModel 切换模型;不在列表里的回退默认模型", () => {
    expect(withModel(c, "small")).toMatchObject({ model: "small", contextLength: 32000 });
    expect(withModel(c, "nope").model).toBe("big");
    expect(withModel(c, null).model).toBe("big");
  });
});

describe("图片输入(B2)", () => {
  const img = { mime: "image/png", data: "iVBORw0KGgo=" };
  const msgs = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "看图", images: [img] },
    { role: "assistant" as const, content: "好的" },
    { role: "user" as const, content: "", images: [img] },
  ];
  const drain = async (config: ProviderConfig) => {
    const p = createProvider(config);
    for await (const _ of p.streamEvents!(msgs)) void _;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("OpenAI:content 数组,图片为 data URL;无文字时只发图片", async () => {
    const calls = mockFetch(() => sse([data({ choices: [{ delta: { content: "x" } }] }), "data: [DONE]\n\n"]));
    await drain({ id: "o", name: "o", baseUrl: "http://x/v1", apiKey: "k", model: "m" });
    const m = body(calls[0]!).messages as Array<{ role: string; content: unknown }>;
    expect(m[1]!.content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]);
    expect(m[2]!.content).toBe("好的");
    expect(m[3]!.content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }]);
  });

  it("Anthropic:base64 图片块在文字前;只有图片的轮次不丢", async () => {
    const calls = mockFetch(() => sse([evt("message_stop", {})]));
    await drain({ id: "a", name: "a", protocol: "anthropic", baseUrl: "http://x", apiKey: "k", model: "m" });
    const m = body(calls[0]!).messages as Array<{ role: string; content: unknown }>;
    expect(m[0]!.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "text", text: "看图" },
    ]);
    expect(m[2]!.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]);
  });

  it("Gemini:inlineData", async () => {
    const calls = mockFetch(() => sse([data({ candidates: [{ content: { parts: [{ text: "x" }] } }] })]));
    await drain({ id: "g", name: "g", protocol: "gemini", baseUrl: "http://x", apiKey: "k", model: "m" });
    const c = body(calls[0]!).contents as Array<{ role: string; parts: unknown[] }>;
    expect(c[0]!.parts).toEqual([{ text: "看图" }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }]);
    expect(c[2]!.parts).toEqual([{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }]);
  });
});

describe("工具调用与结果回传(B1)", () => {
  const call = { id: "c1", name: "read_file", args: '{"path":"a.ts"}' };
  const loop = (raw?: { protocol: "openai" | "anthropic" | "gemini"; content: unknown }) => [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "读 a.ts" },
    { role: "assistant" as const, content: "我先看看", toolCalls: [call], ...(raw ? { raw } : {}) },
    { role: "tool" as const, content: "内容", toolCallId: "c1", toolName: "read_file" },
    { role: "tool" as const, content: "失败", toolCallId: "c2", toolName: "grep", toolError: true },
  ];
  const drain = async (config: ProviderConfig, msgs: ReturnType<typeof loop>) => {
    for await (const _ of createProvider(config).streamEvents!(msgs)) void _;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("OpenAI:assistant 带 tool_calls,结果为 role=tool;reasoning_content 按原样回传", async () => {
    const calls = mockFetch(() => sse(["data: [DONE]\n\n"]));
    await drain({ id: "o", name: "o", baseUrl: "http://x/v1", apiKey: "k", model: "m" }, loop({ protocol: "openai", content: { reasoning_content: "想" } }));
    const m = body(calls[0]!).messages as Array<Record<string, unknown>>;
    expect(m[2]).toEqual({
      role: "assistant",
      content: "我先看看",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
      reasoning_content: "想",
    });
    expect(m[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "内容" });
    expect(m[4]).toEqual({ role: "tool", tool_call_id: "c2", content: "失败" });
  });

  it("OpenAI:流里有 reasoning_content 且有工具调用时产出 raw", async () => {
    mockFetch(() =>
      sse([
        data({ choices: [{ delta: { reasoning_content: "推理" } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "bash", arguments: "{}" } }] } }] }),
        "data: [DONE]\n\n",
      ]),
    );
    const out: ProviderEvent[] = [];
    for await (const ev of createProvider({ id: "o", name: "o", baseUrl: "http://x/v1", apiKey: "k", model: "m" }).streamEvents!([{ role: "user", content: "x" }])) out.push(ev);
    expect(out).toContainEqual({ type: "raw", protocol: "openai", content: { reasoning_content: "推理" } });
  });

  it("Anthropic:tool_use 块 + 结果合并成一条 user 的 tool_result;有原样内容时直接回传", async () => {
    const calls = mockFetch(() => sse([evt("message_stop", {})]));
    const cfg: ProviderConfig = { id: "a", name: "a", protocol: "anthropic", baseUrl: "http://x", apiKey: "k", model: "m" };
    await drain(cfg, loop());
    let m = body(calls[0]!).messages as Array<{ role: string; content: unknown }>;
    expect(m[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "我先看看" },
        { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } },
      ],
    });
    expect(m[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "内容" },
        { type: "tool_result", tool_use_id: "c2", content: "失败", is_error: true },
      ],
    });
    const raw = [{ type: "thinking", thinking: "t", signature: "sig" }, { type: "tool_use", id: "c1", name: "read_file", input: {} }];
    await drain(cfg, loop({ protocol: "anthropic", content: raw }));
    m = body(calls[1]!).messages as Array<{ role: string; content: unknown }>;
    expect(m[1]!.content).toEqual(raw);
    // 其他协议的原样内容不采用
    await drain(cfg, loop({ protocol: "gemini", content: [{ text: "x" }] }));
    m = body(calls[2]!).messages as Array<{ role: string; content: unknown }>;
    expect((m[1]!.content as unknown[]).length).toBe(2);
  });

  it("Anthropic:thinking 签名经 signature_delta 收集进原样内容", async () => {
    mockFetch(() =>
      sse([
        evt("content_block_start", { index: 0, content_block: { type: "thinking" } }),
        evt("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "想" } }),
        evt("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "SIG" } }),
        evt("content_block_stop", { index: 0 }),
        evt("content_block_start", { index: 1, content_block: { type: "tool_use", id: "t1", name: "bash" } }),
        evt("content_block_stop", { index: 1 }),
        evt("message_stop", {}),
      ]),
    );
    const out = await run({ ...base, protocol: "anthropic" });
    expect(out).toContainEqual({
      type: "raw",
      protocol: "anthropic",
      content: [
        { type: "thinking", thinking: "想", signature: "SIG" },
        { type: "tool_use", id: "t1", name: "bash", input: {} },
      ],
    });
  });

  it("Gemini:functionCall / functionResponse;原样 parts(含 thoughtSignature)直接回传", async () => {
    const calls = mockFetch(() => sse([data({ candidates: [{ content: { parts: [{ text: "x" }] } }] })]));
    const cfg: ProviderConfig = { id: "g", name: "g", protocol: "gemini", baseUrl: "http://x", apiKey: "k", model: "m" };
    await drain(cfg, loop());
    let c = body(calls[0]!).contents as Array<{ role: string; parts: unknown[] }>;
    expect(c[1]).toEqual({ role: "model", parts: [{ text: "我先看看" }, { functionCall: { name: "read_file", args: { path: "a.ts" } } }] });
    expect(c[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "read_file", response: { result: "内容" } } },
        { functionResponse: { name: "grep", response: { error: "失败" } } },
      ],
    });
    const raw = [{ functionCall: { name: "read_file", args: {} }, thoughtSignature: "SIG" }];
    await drain(cfg, loop({ protocol: "gemini", content: raw }));
    c = body(calls[1]!).contents as Array<{ role: string; parts: unknown[] }>;
    expect(c[1]!.parts).toEqual(raw);
  });
});
