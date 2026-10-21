import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider, type ProviderEvent } from "./index.ts";

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
