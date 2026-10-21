import { beforeAll, describe, expect, it } from "vitest";
import type { StreamEvent } from "../api.ts";
import type { UIMessage } from "./useChatStream.ts";

// api.ts 顶层读取 location,node 环境下先补一个最小桩再动态导入
let applyQueue: (msg: UIMessage, queue: StreamEvent[]) => UIMessage;
beforeAll(async () => {
  (globalThis as { location?: unknown }).location ??= { protocol: "http:" };
  ({ applyQueue } = await import("./useChatStream.ts"));
});

const empty = (): UIMessage => ({ role: "assistant", content: "", blocks: [], streaming: true });

const STREAM: StreamEvent[] = [
  { type: "block", id: "k1", block: { kind: "thinking" } },
  { type: "block_delta", id: "k1", delta: "先想" },
  { type: "block_delta", id: "k1", delta: "一想" },
  { type: "block_end", id: "k1", block: { id: "k1", kind: "thinking", text: "先想一想", durationMs: 120 } },
  { type: "block", id: "t2", block: { kind: "text" } },
  { delta: "你好,", id: "t2" },
  { delta: "世界", id: "t2" },
  { type: "block", id: "call_1", block: { kind: "tool", name: "read_file", status: "pending" } },
  { type: "block_delta", id: "call_1", delta: '{"path":' },
  { type: "block_delta", id: "call_1", delta: '"a.ts"}' },
];

describe("applyQueue", () => {
  it("思考、正文、工具参数增量各自写入对应块", () => {
    const out = applyQueue(empty(), STREAM);
    expect(out.content).toBe("你好,世界");
    expect(out.blocks).toEqual([
      { id: "k1", kind: "thinking", text: "先想一想", durationMs: 120 },
      { id: "t2", kind: "text", text: "你好,世界" },
      { id: "call_1", kind: "tool", name: "read_file", rawArgs: '{"path":"a.ts"}', status: "pending" },
    ]);
  });

  it("思考块在 block_end 之前即可流式显示", () => {
    const out = applyQueue(empty(), STREAM.slice(0, 3));
    expect(out.blocks?.[0]).toMatchObject({ kind: "thinking", text: "先想一想" });
    expect(out.content).toBe("");
  });

  it("纯函数:同一输入重复执行不会让文本重复(StrictMode 双调用)", () => {
    const base = applyQueue(empty(), STREAM.slice(0, 6));
    const a = applyQueue(base, STREAM.slice(6));
    const b = applyQueue(base, STREAM.slice(6));
    expect(a).toEqual(b);
    expect(base.blocks?.[1]).toEqual({ id: "t2", kind: "text", text: "你好," });
    expect(a.blocks?.[1]).toMatchObject({ text: "你好,世界" });
  });

  it("记录实测用量,分批应用与一次应用结果一致", () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 } as never;
    const once = applyQueue(empty(), [...STREAM, { type: "usage", usage }]);
    let step = empty();
    for (const ev of [...STREAM, { type: "usage", usage } as StreamEvent]) step = applyQueue(step, [ev]);
    expect(step).toEqual(once);
    expect(once.usage).toBe(usage);
  });
});
