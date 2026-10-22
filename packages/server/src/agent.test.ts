import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, ChatBlock } from "@xiyun/shared";
import type { ChatProvider, ProviderEvent } from "../../runtime/src/index.ts";
import { ALL_TOOLS, BlockBuilder, runAgent, toolByName, toolDigest, toolsForMode, truncateMiddle } from "./agent.ts";
import { loadPermissions } from "./permissions.ts";

const ws = () => mkdtempSync(join(tmpdir(), "xiyun-agent-"));

// 按脚本逐轮产出的假 Provider:每轮消费一组事件
function scripted(rounds: ProviderEvent[][]): ChatProvider & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return {
    seen,
    config: { id: "p", name: "p", baseUrl: "http://x", apiKey: "k", model: "m" },
    async *streamChat() {
      throw new Error("应走 streamEvents");
    },
    async *streamEvents(messages) {
      seen.push(messages.map((m) => ({ ...m })));
      const round = rounds[Math.min(i++, rounds.length - 1)] ?? [];
      for (const ev of round) yield ev;
    },
  };
}

const textRound = (t: string): ProviderEvent[] => [
  { type: "text", delta: t },
  { type: "finish", reason: "stop" },
];

// 一次工具调用轮:name + args,随后 finish
const toolRound = (name: string, args: unknown, id = "c1"): ProviderEvent[] => [
  { type: "tool_start", id, index: 0, name },
  { type: "tool_args", id, delta: JSON.stringify(args) },
  { type: "tool_end", id, args: JSON.stringify(args) },
  { type: "finish", reason: "tool_calls" },
];

function run(o: {
  workspace: string;
  provider: ChatProvider;
  tools?: typeof ALL_TOOLS;
  confirm?: Parameters<typeof runAgent>[0]["confirm"];
  maxSteps?: number;
  emit?: (obj: unknown) => void;
  signal?: AbortSignal;
}) {
  const events: unknown[] = [];
  const builder = new BlockBuilder((e) => {
    events.push(e);
    o.emit?.(e);
  });
  const result = runAgent({
    provider: o.provider,
    messages: [{ role: "user", content: "go" }],
    tools: o.tools ?? ALL_TOOLS,
    workspace: o.workspace,
    signal: o.signal ?? new AbortController().signal,
    builder,
    maxSteps: o.maxSteps,
    ...(o.confirm ? { confirm: o.confirm } : {}),
  });
  return { result, builder, events };
}

describe("read_file", () => {
  it("输出带行号,支持 offset / limit", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.txt"), "l1\nl2\nl3\nl4\nl5");
    const tool = toolByName("read_file")!;
    const out = await tool.run({ path: "a.txt", offset: 2, limit: 2 }, { workspace: dir, signal: new AbortController().signal });
    expect(out.text).toContain("     2\tl2");
    expect(out.text).toContain("     3\tl3");
    expect(out.text).not.toContain("l4");
    expect(out.text).toContain("共 5 行");
    rmSync(dir, { recursive: true, force: true });
  });

  it("拒绝目录与越界路径", async () => {
    const dir = ws();
    mkdirSync(join(dir, "sub"));
    const tool = toolByName("read_file")!;
    await expect(tool.run({ path: "sub" }, { workspace: dir, signal: new AbortController().signal })).rejects.toThrow(/目录/);
    await expect(tool.run({ path: "../x" }, { workspace: dir, signal: new AbortController().signal })).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("edit_file", () => {
  const ctx = (dir: string) => ({ workspace: dir, signal: new AbortController().signal });

  it("唯一匹配时替换", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "const a = 1;\nconst b = 2;\n");
    const out = await toolByName("edit_file")!.run({ path: "a.ts", old_string: "const a = 1;", new_string: "const a = 10;" }, ctx(dir));
    expect(out.text).toContain("已修改");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toContain("const a = 10;");
    rmSync(dir, { recursive: true, force: true });
  });

  it("多处匹配且未设 replace_all 时报错并给出次数", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "x\nx\nx\n");
    await expect(
      toolByName("edit_file")!.run({ path: "a.ts", old_string: "x", new_string: "y" }, ctx(dir)),
    ).rejects.toThrow(/出现 3 次/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("replace_all 替换所有匹配", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "x\nx\nx\n");
    await toolByName("edit_file")!.run({ path: "a.ts", old_string: "x", new_string: "y", replace_all: true }, ctx(dir));
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("y\ny\ny\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("找不到时报错并提示不要带行号前缀", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "abc");
    await expect(
      toolByName("edit_file")!.run({ path: "a.ts", old_string: "     1\tabc", new_string: "x" }, ctx(dir)),
    ).rejects.toThrow(/行号前缀/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("CRLF 文件也能匹配,写回保持 CRLF", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "a\r\nb\r\nc\r\n");
    await toolByName("edit_file")!.run({ path: "a.ts", old_string: "b", new_string: "B" }, ctx(dir));
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("a\r\nB\r\nc\r\n");
    rmSync(dir, { recursive: true, force: true });
  });

  it("old_string 为空且文件不存在时新建", async () => {
    const dir = ws();
    await toolByName("edit_file")!.run({ path: "new.ts", old_string: "", new_string: "hi" }, ctx(dir));
    expect(readFileSync(join(dir, "new.ts"), "utf8")).toBe("hi");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("grep", () => {
  it("按正则搜索并跳过 node_modules 与二进制", async () => {
    const dir = ws();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "src", "a.ts"), "const needle = 1;\n");
    writeFileSync(join(dir, "node_modules", "b.ts"), "needle\n");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0x6e, 0x00, 0x6e]));
    const out = await toolByName("grep")!.run({ pattern: "needle" }, { workspace: dir, signal: new AbortController().signal });
    expect(out.text).toContain("src/a.ts:1:");
    expect(out.text).not.toContain("node_modules");
    expect(out.text).not.toContain("bin.dat");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runAgent", () => {
  it("两步:先调工具再输出正文,工具结果回传给模型", async () => {
    const dir = ws();
    writeFileSync(join(dir, "x.txt"), "content-42");
    const provider = scripted([toolRound("read_file", { path: "x.txt" }), textRound("完成")]);
    const { result, builder } = run({ workspace: dir, provider });
    const r = await result;
    expect(r.steps).toBe(2);
    expect(r.finalText).toBe("完成");
    expect(provider.seen[1]!.some((m) => m.role === "tool" && m.content.includes("content-42"))).toBe(true);
    const tool = builder.blocks.find((b): b is Extract<ChatBlock, { kind: "tool" }> => b.kind === "tool")!;
    expect(tool.status).toBe("success");
    expect(tool.result).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("awaiting 后选 allow 执行", async () => {
    const dir = ws();
    writeFileSync(join(dir, "x.txt"), "v");
    const decisions: string[] = [];
    const provider = scripted([toolRound("write_file", { path: "y.txt", content: "new" }), textRound("ok")]);
    const { result, builder } = run({
      workspace: dir,
      provider,
      confirm: async (req) => {
        decisions.push(req.rule);
        return "allow";
      },
    });
    await result;
    expect(decisions).toHaveLength(1);
    expect(readFileSync(join(dir, "y.txt"), "utf8")).toBe("new");
    const tool = builder.blocks.find((b): b is Extract<ChatBlock, { kind: "tool" }> => b.kind === "tool")!;
    expect(tool.status).toBe("success");
    rmSync(dir, { recursive: true, force: true });
  });

  it("awaiting 后选 deny 标记 rejected", async () => {
    const dir = ws();
    const provider = scripted([toolRound("write_file", { path: "y.txt", content: "new" }), textRound("ok")]);
    const { result, builder } = run({ workspace: dir, provider, confirm: async () => "deny" });
    await result;
    const tool = builder.blocks.find((b): b is Extract<ChatBlock, { kind: "tool" }> => b.kind === "tool")!;
    expect(tool.status).toBe("rejected");
    expect(tool.result).toContain("不要重复尝试");
    rmSync(dir, { recursive: true, force: true });
  });

  it("awaiting 后选 always 写入允许规则", async () => {
    const dir = ws();
    const provider = scripted([toolRound("write_file", { path: "y.txt", content: "new" }), textRound("ok")]);
    const { result } = run({ workspace: dir, provider, confirm: async () => "always" });
    await result;
    expect(loadPermissions(dir).allow).toContain("Edit(y.txt)");
    rmSync(dir, { recursive: true, force: true });
  });

  it("deny 规则直接拒绝,不询问", async () => {
    const dir = ws();
    mkdirSync(join(dir, ".xiyun"));
    writeFileSync(join(dir, ".xiyun", "settings.json"), JSON.stringify({ permissions: { deny: ["Write(y.txt)"] } }));
    let asked = false;
    const provider = scripted([toolRound("write_file", { path: "y.txt", content: "new" }), textRound("ok")]);
    const { result, builder } = run({
      workspace: dir,
      provider,
      confirm: async () => {
        asked = true;
        return "allow";
      },
    });
    await result;
    expect(asked).toBe(false);
    const tool = builder.blocks.find((b): b is Extract<ChatBlock, { kind: "tool" }> => b.kind === "tool")!;
    expect(tool.status).toBe("rejected");
    rmSync(dir, { recursive: true, force: true });
  });

  it("中断时 awaiting 被收尾", async () => {
    const dir = ws();
    const ac = new AbortController();
    const provider = scripted([toolRound("write_file", { path: "y.txt", content: "new" }), textRound("ok")]);
    const { result, builder } = run({
      workspace: dir,
      provider,
      signal: ac.signal,
      // 模拟 Run.awaitConfirm:中断时按 deny 收尾
      confirm: () =>
        new Promise((resolve) => {
          ac.signal.addEventListener("abort", () => resolve("deny"), { once: true });
          setTimeout(() => ac.abort(), 0);
        }),
    });
    await expect(result).rejects.toThrow(/aborted/);
    builder.closeUnfinished();
    const tool = builder.blocks.find((b): b is Extract<ChatBlock, { kind: "tool" }> => b.kind === "tool");
    // 中断时 Run.awaitConfirm 按 deny 收尾,卡片显示"已拒绝";循环随即抛 aborted 结束
    expect(tool?.status).toBe("rejected");
    expect(tool?.result).toContain("不要重复尝试");
    rmSync(dir, { recursive: true, force: true });
  });

  it("多步用量求和并记录 steps / contextTokens", async () => {
    const dir = ws();
    writeFileSync(join(dir, "x.txt"), "v");
    const provider = scripted([
      [...toolRound("read_file", { path: "x.txt" }), { type: "usage", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }],
      [...textRound("done"), { type: "usage", usage: { promptTokens: 20, completionTokens: 7, totalTokens: 27 } }],
    ]);
    const { result } = run({ workspace: dir, provider });
    const r = await result;
    expect(r.usage).toMatchObject({ promptTokens: 30, completionTokens: 12, totalTokens: 42, steps: 2, contextTokens: 27 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("达到步数上限时给出继续提示", async () => {
    const dir = ws();
    writeFileSync(join(dir, "x.txt"), "v");
    // 每轮都请求工具,永远不结束
    const rounds: ProviderEvent[][] = Array.from({ length: 5 }, (_, i) => toolRound("read_file", { path: "x.txt" }, `c${i}`));
    const provider = scripted(rounds);
    const { result } = run({ workspace: dir, provider, maxSteps: 2 });
    const r = await result;
    expect(r.steps).toBe(2);
    expect(r.finalText).toContain("上限 2 步");
    rmSync(dir, { recursive: true, force: true });
  });

  it("首步带工具报 400 时去掉工具重试一次", async () => {
    const dir = ws();
    let calls = 0;
    let sawTools: boolean[] = [];
    const provider: ChatProvider = {
      config: { id: "p", name: "p", baseUrl: "http://x", apiKey: "k", model: "m" },
      async *streamChat() {
        throw new Error("应走 streamEvents");
      },
      async *streamEvents(_m, opts) {
        calls++;
        sawTools.push(!!opts?.tools?.length);
        if (calls === 1) throw new Error("400 Bad Request: tools not supported");
        yield { type: "text", delta: "ok" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const { result } = run({ workspace: dir, provider });
    const r = await result;
    expect(calls).toBe(2);
    expect(sawTools).toEqual([true, false]);
    expect(r.finalText).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  it("块 id 跨步去重:两轮同名调用 id 相同也各自成块", async () => {
    const dir = ws();
    writeFileSync(join(dir, "x.txt"), "v");
    const provider = scripted([
      toolRound("read_file", { path: "x.txt" }, "call_0"),
      toolRound("read_file", { path: "x.txt" }, "call_0"), // Gemini 每步都是 call_0
      textRound("done"),
    ]);
    const { result, builder } = run({ workspace: dir, provider, maxSteps: 5 });
    await result;
    const tools = builder.blocks.filter((b): b is Extract<ChatBlock, { kind: "tool" }> => b.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.id).not.toBe(tools[1]!.id);
    rmSync(dir, { recursive: true, force: true });
  });

  it("未知工具与非法参数返回错误结果,不中断循环", async () => {
    const dir = ws();
    const badArgs: ProviderEvent[] = [
      { type: "tool_start", id: "c1", index: 0, name: "read_file" },
      { type: "tool_args", id: "c1", delta: "{bad" },
      { type: "tool_end", id: "c1", args: "{bad" },
      { type: "finish", reason: "tool_calls" },
    ];
    const unknown: ProviderEvent[] = toolRound("nope", {});
    const provider = scripted([badArgs, unknown, textRound("done")]);
    const { result, builder } = run({ workspace: dir, provider, maxSteps: 5 });
    const r = await result;
    expect(r.finalText).toBe("done");
    const tools = builder.blocks.filter((b): b is Extract<ChatBlock, { kind: "tool" }> => b.kind === "tool");
    expect(tools.map((t) => t.status)).toEqual(["error", "error"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("工具集与摘要", () => {
  it("按模式下发:code 全部,work 只读,chat 无", () => {
    expect(toolsForMode("code")).toHaveLength(8);
    expect(toolsForMode("work").map((t) => t.def.name)).toEqual(["read_file", "list_files", "grep", "git_status", "git_diff"]);
    expect(toolsForMode("chat")).toHaveLength(0);
  });

  it("toolDigest 生成单行摘要", () => {
    const blocks: ChatBlock[] = [
      { id: "1", kind: "tool", name: "edit_file", rawArgs: "", status: "success", args: { path: "src/a.ts" } },
      { id: "2", kind: "tool", name: "bash", rawArgs: "", status: "error", args: { command: "npm test" } },
    ];
    expect(toolDigest(blocks)).toBe("edit_file src/a.ts; bash npm test [error]");
  });

  it("truncateMiddle 保留开头与结尾", () => {
    const s = `HEAD${"x".repeat(1000)}TAIL`;
    const out = truncateMiddle(s, 100);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("已截断");
  });
});
