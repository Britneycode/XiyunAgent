import { describe, expect, it } from "vitest";
import { contextBudget, DEFAULT_CONTEXT, DEFAULT_RESERVE, planHistory, REF_TURNS, summaryBatch, SUMMARY_INPUT_CHARS, type PathMessage } from "./context.ts";

const msg = (id: number, role: "user" | "assistant", content: string, extra: Partial<PathMessage> = {}): PathMessage => ({
  id, role, content, ...extra,
});

describe("上下文预算", () => {
  it("按窗口 80% 减去回复预留;未配置时用保守默认值", () => {
    expect(contextBudget({})).toBe(Math.floor(DEFAULT_CONTEXT * 0.8) - DEFAULT_RESERVE);
    expect(contextBudget({ contextLength: 128_000, maxTokens: 8000 })).toBe(102_400 - 8000);
    expect(contextBudget({ contextLength: 1000, maxTokens: 4000 })).toBe(0);
  });

  it("从新到旧装入,装不下的进入 dropped;开头不是 assistant", () => {
    const path = [msg(1, "user", "a".repeat(400)), msg(2, "assistant", "b".repeat(400)), msg(3, "user", "c"), msg(4, "assistant", "d")];
    const all = planHistory(path, 10_000);
    expect(all.dropped).toEqual([]);
    expect(all.history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // 预算只够最后两条 + assistant 2:assistant 2 不能打头,一并丢弃
    const part = planHistory(path, 120);
    expect(part.history.map((m) => m.content)).toEqual(["c", "d"]);
    expect(part.dropped.map((m) => m.id)).toEqual([1, 2]);
    expect(planHistory(path, 0).history).toEqual([]);
  });

  it("实测用量优先于估算;空消息跳过", () => {
    const path = [
      msg(1, "user", "q"),
      msg(2, "assistant", "short", { usage: { promptTokens: 1, completionTokens: 500, totalTokens: 501 } }),
      msg(3, "user", "   "),
      msg(4, "user", "q2"),
    ];
    const p = planHistory(path, 100);
    expect(p.history.map((m) => m.content)).toEqual(["q2"]);
    // 推理 tokens 不计入
    path[1] = msg(2, "assistant", "short", { usage: { promptTokens: 1, completionTokens: 500, totalTokens: 501, reasoningTokens: 490 } });
    expect(planHistory(path, 100).history.map((m) => m.content)).toEqual(["q", "short", "q2"]);
  });

  it("只有最近几条带引用的 user 消息重新带入引用上下文", () => {
    const path: PathMessage[] = [];
    for (let i = 1; i <= REF_TURNS + 1; i++) {
      path.push(msg(i * 2 - 1, "user", `q${i}`, { refContext: `ctx${i}` }));
      path.push(msg(i * 2, "assistant", `a${i}`));
    }
    const p = planHistory(path, 10_000, (m) => (m.id === path.at(-2)!.id ? ["x.ts"] : []));
    const users = p.history.filter((m) => m.role === "user").map((m) => m.content);
    expect(users[0]).toBe("q1");
    expect(users[1]).toContain("# 引用上下文\nctx2");
    expect(users.at(-1)).toContain("x.ts 在引用之后已修改");
  });

  it("摘要输入分批:超出上限时先处理最早的一段", () => {
    const many = Array.from({ length: 40 }, (_, i) => msg(i + 1, "user", "x".repeat(1500)));
    const batch = summaryBatch(many);
    expect(batch.length).toBeLessThan(many.length);
    expect(batch[0]!.id).toBe(1);
    expect(batch.length * 1508).toBeLessThanOrEqual(SUMMARY_INPUT_CHARS);
  });
});
