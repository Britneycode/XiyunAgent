import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider, normalizeUsage, type ProviderEvent } from "./index.ts";

const config = {
  id: "p1", name: "test", baseUrl: "https://example.test/v1", apiKey: "k", model: "m",
};

// 用 ReadableStream 模拟 SSE 分片:chunks 按原样写入,便于测试跨 chunk 边界。
function sse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const s of chunks) c.enqueue(enc.encode(s));
        c.close();
      },
    }),
    { status: 200 },
  );
}

const line = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

async function collect(parts: string[], opts?: { tools?: Array<{ name: string; description: string; parameters: object }> }) {
  vi.stubGlobal("fetch", vi.fn(async () => sse(parts)));
  const p = createOpenAIProvider(config);
  const out: ProviderEvent[] = [];
  for await (const ev of p.streamEvents!([{ role: "user", content: "hi" }], opts)) out.push(ev);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("createOpenAIProvider.streamEvents", () => {
  it("输出 text 与 thinking,忽略 reasoning 阶段的空 content", async () => {
    const out = await collect([
      line({ choices: [{ delta: { reasoning_content: "想" } }] }),
      line({ choices: [{ delta: { content: "" } }] }),
      line({ choices: [{ delta: { reasoning_content: "一下" } }] }),
      line({ choices: [{ delta: { content: "你好" } }] }),
      line({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    expect(out).toEqual([
      { type: "thinking", delta: "想" },
      { type: "thinking", delta: "一下" },
      { type: "text", delta: "你好" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("支持 delta.reasoning 作为兼容字段", async () => {
    const out = await collect([line({ choices: [{ delta: { reasoning: "r" } }] }), "data: [DONE]\n\n"]);
    expect(out[0]).toEqual({ type: "thinking", delta: "r" });
  });

  it("单工具:参数分片累积,后续分片无 id 时按 index 归属", async () => {
    const out = await collect([
      line({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: "" } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `{"path":` } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"a.ts"}` } }] } }] }),
      line({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ]);
    expect(out).toEqual([
      { type: "tool_start", id: "call_a", index: 0, name: "read_file" },
      { type: "tool_args", id: "call_a", delta: `{"path":` },
      { type: "tool_args", id: "call_a", delta: `"a.ts"}` },
      { type: "tool_end", id: "call_a", args: `{"path":"a.ts"}` },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("双工具交错分片各自归属", async () => {
    const out = await collect([
      line({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c0", function: { name: "list_files", arguments: "{}" } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 1, id: "c1", function: { name: "read_file", arguments: `{"path":"b` } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: `.ts"}` } }] } }] }),
      "data: [DONE]\n\n",
    ]);
    const ends = out.filter((e) => e.type === "tool_end");
    expect(ends).toEqual([
      { type: "tool_end", id: "c0", args: "{}" },
      { type: "tool_end", id: "c1", args: `{"path":"b.ts"}` },
    ]);
  });

  it("缺 index 与缺 id 时仍能产出调用", async () => {
    const out = await collect([
      line({ choices: [{ delta: { tool_calls: [{ function: { name: "list_files", arguments: "{}" } }] } }] }),
      "data: [DONE]\n\n",
    ]);
    expect(out).toEqual([
      { type: "tool_start", id: "call_0", index: 0, name: "list_files" },
      { type: "tool_args", id: "call_0", delta: "{}" },
      { type: "tool_end", id: "call_0", args: "{}" },
      { type: "finish", reason: null },
    ]);
  });

  it("连接关闭时 flush 残留行与未结束的工具", async () => {
    const out = await collect([
      // 最后一个事件没有换行结尾,模拟连接直接关闭
      `data: ${JSON.stringify({ choices: [{ delta: { content: "尾" } }] })}`,
    ]);
    expect(out).toEqual([{ type: "text", delta: "尾" }, { type: "finish", reason: null }]);
  });
});

describe("createOpenAIProvider.streamChat", () => {
  it("只输出正文,且请求体不含 tools", async () => {
    const fetchMock = vi.fn(async () => sse([
      line({ choices: [{ delta: { reasoning_content: "r" } }] }),
      line({ choices: [{ delta: { content: "正" } }] }),
      line({ choices: [{ delta: { content: "文" } }] }),
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const p = createOpenAIProvider(config);
    const out: string[] = [];
    for await (const d of p.streamChat([{ role: "user", content: "hi", id: 7, blocks: [] }], {
      tools: [{ name: "read_file", description: "d", parameters: {} }],
    })) out.push(d);
    expect(out.join("")).toBe("正文");
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.tools).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("token 用量(usage)", () => {
  const bodyOf = (m: ReturnType<typeof vi.fn>, i: number) =>
    JSON.parse((m.mock.calls[i] as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>;

  it("请求携带 stream_options.include_usage,末尾分片的 usage 在 finish 前产出一次", async () => {
    const fetchMock = vi.fn(async () => sse([
      line({ choices: [{ delta: { content: "好" } }], usage: null }),
      line({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null }),
      line({
        choices: [],
        usage: {
          prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      }),
      "data: [DONE]\n\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const p = createOpenAIProvider(config);
    const out: ProviderEvent[] = [];
    for await (const ev of p.streamEvents!([{ role: "user", content: "hi" }])) out.push(ev);
    expect(bodyOf(fetchMock, 0).stream_options).toEqual({ include_usage: true });
    expect(out).toEqual([
      { type: "text", delta: "好" },
      {
        type: "usage",
        usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150, cachedTokens: 64, reasoningTokens: 12 },
      },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("没有 usage 的流不产出 usage 事件", async () => {
    const out = await collect([line({ choices: [{ delta: { content: "a" } }] }), "data: [DONE]\n\n"]);
    expect(out.some((e) => e.type === "usage")).toBe(false);
  });

  it("兼容 choice 内的 usage(Moonshot)与 DeepSeek 缓存字段", async () => {
    const out = await collect([
      line({
        choices: [{
          delta: {}, finish_reason: "stop",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 8 },
        }],
      }),
      "data: [DONE]\n\n",
    ]);
    expect(out).toContainEqual({
      type: "usage", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 8 },
    });
  });

  it("网关拒绝 stream_options(400)时去掉重试,之后的请求(含新实例)不再携带", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string) as Record<string, unknown>;
      if (b.stream_options) return new Response("unknown field stream_options", { status: 400 });
      return sse([line({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"]);
    });
    vi.stubGlobal("fetch", fetchMock);
    // Server 每次请求都会新建 Provider 实例,缓存需跨实例生效
    const strict = { ...config, baseUrl: "https://strict.test/v1/" };
    const run = async () => {
      const out: string[] = [];
      for await (const d of createOpenAIProvider(strict).streamChat([{ role: "user", content: "hi" }])) out.push(d);
      return out.join("");
    };
    expect(await run()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 1).stream_options).toBeUndefined();
    expect(await run()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchMock, 2).stream_options).toBeUndefined();
  });

  it("重试后仍失败时抛出错误,且不误判为不支持 usage", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = createOpenAIProvider({ ...config, baseUrl: "https://down.test/v1" });
    const drain = async () => {
      for await (const _ of p.streamChat([{ role: "user", content: "hi" }])) void _;
    };
    await expect(drain()).rejects.toThrow("HTTP 400");
    await expect(drain()).rejects.toThrow("HTTP 400");
    // 两轮都会先带 stream_options 再重试
    expect(bodyOf(fetchMock, 2).stream_options).toEqual({ include_usage: true });
  });

  it("normalizeUsage:缺字段补齐、非法值忽略", () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage({ total_tokens: 3 })).toBeNull();
    expect(normalizeUsage({ input_tokens: 7, output_tokens: 2 })).toEqual({
      promptTokens: 7, completionTokens: 2, totalTokens: 9,
    });
    expect(normalizeUsage({ prompt_tokens: 5, completion_tokens: -1 })).toEqual({
      promptTokens: 5, completionTokens: 0, totalTokens: 5,
    });
  });
});
