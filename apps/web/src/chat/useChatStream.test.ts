import { beforeAll, describe, expect, it } from "vitest";
import type { StreamEvent } from "../api.ts";
import type { UIMessage } from "./useChatStream.ts";

// api.ts 顶层读取 location,node 环境下先补一个最小桩再动态导入
let applyQueue: (msg: UIMessage, queue: StreamEvent[]) => UIMessage;
let applyStream: (ms: UIMessage[], queue: StreamEvent[]) => UIMessage[];
let attachBase: (ms: UIMessage[], userMessageId: number | null) => UIMessage[];
let finalizeLast: (ms: UIMessage[], o: { cancelled: boolean; error?: string }) => UIMessage[];
let mergeTree: (ms: UIMessage[], server: UIMessage[]) => UIMessage[];
beforeAll(async () => {
  (globalThis as { location?: unknown }).location ??= { protocol: "http:" };
  ({ applyQueue, applyStream, attachBase, finalizeLast, mergeTree } = await import("./useChatStream.ts"));
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

describe("applyStream:落库 id 回填", () => {
  // 已持久化的上一轮 + 本轮刚发出的 user / assistant(都还没有 id)
  const base = (): UIMessage[] => [
    { id: 1, role: "user", content: "旧问" },
    { id: 2, role: "assistant", content: "旧答" },
    { role: "user", content: "新问", localKey: "local-1" },
    { role: "assistant", content: "", blocks: [], streaming: true, localKey: "local-2" },
  ];

  it("meta 事件在生成中就给本轮 user 消息回填 id", () => {
    const out = applyStream(base(), [{ type: "meta", userMessageId: 3 }, { delta: "答", id: "t1" }]);
    expect(out[2]).toMatchObject({ id: 3, content: "新问", localKey: "local-1" });
    expect(out[3]?.id).toBeUndefined();
    expect(out[3]?.content).toBe("答");
  });

  it("done 事件回填 assistant id,不改动更早的消息", () => {
    const out = applyStream(base(), [{ delta: "答" }, { done: true, messageId: 4, userMessageId: 3 }]);
    expect(out.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(out[3]).toMatchObject({ content: "答", localKey: "local-2" });
  });

  it("error 事件带回半截的落库 id;未落库(null)时保持无 id", () => {
    const saved = applyStream(base(), [{ delta: "半" }, { error: "boom", messageId: 4, userMessageId: 3 }]);
    expect(saved.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    const unsaved = applyStream(base(), [{ error: "boom", messageId: null, userMessageId: 3 }]);
    expect(unsaved.map((m) => m.id)).toEqual([1, 2, 3, undefined]);
  });

  it("regenerate:user 已有 id 时不被覆盖", () => {
    const ms: UIMessage[] = [
      { id: 1, role: "user", content: "问" },
      { role: "assistant", content: "", blocks: [], streaming: true },
    ];
    const out = applyStream(ms, [{ type: "meta", userMessageId: 99 }, { done: true, messageId: 5, userMessageId: 99 }]);
    expect(out.map((m) => m.id)).toEqual([1, 5]);
  });

  it("纯函数:不修改输入;末条不是 assistant 时原样返回", () => {
    const ms = base();
    const snapshot = structuredClone(ms);
    applyStream(ms, [{ type: "meta", userMessageId: 3 }, { done: true, messageId: 4 }]);
    expect(ms).toEqual(snapshot);
    const userLast: UIMessage[] = [{ role: "user", content: "q" }];
    expect(applyStream(userLast, [{ done: true, messageId: 1 }])).toBe(userLast);
  });
});

describe("F1 后台生成:续订与收尾", () => {
  it("attachBase 去掉该轮 user 之后已落库的消息,并追加生成中的占位", () => {
    const ms = [
      { id: 1, role: "user" as const, content: "q1" },
      { id: 2, role: "assistant" as const, content: "a1" },
      { id: 3, role: "user" as const, content: "q2" },
      { id: 4, role: "assistant" as const, content: "刚落库" },
    ];
    const out = attachBase(ms, 3);
    expect(out.map((m) => m.id)).toEqual([1, 2, 3, undefined]);
    expect(out.at(-1)).toMatchObject({ role: "assistant", streaming: true, content: "" });
    // regenerate:userMessageId 指向上一条 user,旧回答被去掉
    expect(attachBase(ms.slice(0, 2), 1).map((m) => m.id)).toEqual([1, undefined]);
  });

  it("cancelled 事件回填落库 id,finalizeLast 标记 aborted;全空时移除占位", () => {
    const base = [
      { role: "user" as const, content: "q", localKey: "u" },
      { role: "assistant" as const, content: "", blocks: [], streaming: true, localKey: "a" },
    ];
    const streamed = applyStream(base, [
      { type: "meta", userMessageId: 7, runId: "r" },
      { delta: "半" },
      { type: "cancelled", messageId: 8, userMessageId: 7 },
    ]);
    expect(streamed.map((m) => m.id)).toEqual([7, 8]);
    expect(finalizeLast(streamed, { cancelled: true }).at(-1)).toMatchObject({ aborted: true, streaming: false, content: "半" });
    expect(finalizeLast(base, { cancelled: true })).toHaveLength(1);
    expect(finalizeLast(streamed, { cancelled: false, error: "boom" }).at(-1)).toMatchObject({ error: "boom", streaming: false });
  });
});

describe("mergeTree(F6)", () => {
  it("只补版本信息,保留 localKey 与其余字段;无变化时返回原数组", () => {
    const ms: UIMessage[] = [
      { id: 1, role: "user", content: "q", localKey: "local-1" },
      { id: 3, role: "assistant", content: "新回答", localKey: "local-2", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
      { role: "assistant", content: "", error: "boom" },
    ];
    const server: UIMessage[] = [
      { id: 1, role: "user", content: "q", parentId: null },
      { id: 3, role: "assistant", content: "新回答", parentId: 1, siblings: [2, 3] },
    ];
    const out = mergeTree(ms, server);
    expect(out[0]).toBe(ms[0]);
    expect(out[1]).toMatchObject({ localKey: "local-2", siblings: [2, 3], parentId: 1, usage: ms[1]!.usage });
    expect(out[2]).toBe(ms[2]);
    expect(mergeTree(out, server)).toBe(out);
  });
});

describe("meta.trim", () => {
  it("历史裁剪信息写到正在生成的回复上", () => {
    const ms: UIMessage[] = [{ role: "user", content: "q" }, empty()];
    const out = applyStream(ms, [{ type: "meta", userMessageId: 5, trim: { dropped: 6, summary: true } }]);
    expect(out[1]!.trim).toEqual({ dropped: 6, summary: true });
    expect(out[0]!.id).toBe(5);
  });
});

describe("tool_output 与块覆盖(B1)", () => {
  it("tool_output 追加到对应工具的 output", () => {
    const ms: UIMessage[] = [{ role: "user", content: "q" }, empty()];
    const out = applyStream(ms, [
      { type: "block", id: "tc1", block: { kind: "tool", name: "bash", status: "running" } },
      { type: "tool_output", id: "tc1", delta: "line1\n" },
      { type: "tool_output", id: "tc1", delta: "line2\n" },
    ]);
    const tool = out[1]!.blocks?.find((b) => b.kind === "tool") as { output?: string } | undefined;
    expect(tool?.output).toBe("line1\nline2\n");
  });

  it("output 只保留尾部 64KB", () => {
    const ms: UIMessage[] = [{ role: "user", content: "q" }, empty()];
    const big = "x".repeat(70 * 1024);
    const out = applyStream(ms, [
      { type: "block", id: "tc1", block: { kind: "tool", name: "bash", status: "running" } },
      { type: "tool_output", id: "tc1", delta: big },
    ]);
    const tool = out[1]!.blocks?.find((b) => b.kind === "tool") as { output?: string } | undefined;
    expect(tool?.output?.length).toBe(64 * 1024);
  });

  it("block_end 按 id 覆盖同一块(状态可从 awaiting 变 success)", () => {
    const ms: UIMessage[] = [{ role: "user", content: "q" }, empty()];
    const out = applyStream(ms, [
      { type: "block", id: "tc1", block: { kind: "tool", name: "write_file", status: "pending" } },
      {
        type: "block_end", id: "tc1",
        block: { id: "tc1", kind: "tool", name: "write_file", rawArgs: "", status: "awaiting", runId: "r1", rule: "Edit(a.txt)" },
      },
      {
        type: "block_end", id: "tc1",
        block: { id: "tc1", kind: "tool", name: "write_file", rawArgs: "", status: "success", result: "已新建 a.txt" },
      },
    ]);
    const tools = out[1]!.blocks?.filter((b) => b.kind === "tool") ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ status: "success", result: "已新建 a.txt" });
  });
});
