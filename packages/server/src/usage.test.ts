import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, ProviderConfig } from "@xiyun/shared";
import type { ChatProvider } from "@xiyun/runtime";
import { BlockBuilder, isRetryableModelError, runAgent } from "./agent.ts";
import { costOf, UsageLedger } from "./usage.ts";

// L5:跨厂商回退链与成本账本。

function provider(id: string, opts: { fail?: string; text?: string } = {}): ChatProvider {
  const config: ProviderConfig = { id, name: id, baseUrl: "", apiKey: "", model: `${id}-model`, roles: ["main"] };
  return {
    config,
    async *streamChat() {
      if (opts.fail) throw new Error(opts.fail);
      yield opts.text ?? `${id} 的回复`;
    },
  };
}

function run(primary: ChatProvider, fallbacks: ChatProvider[]) {
  const events: unknown[] = [];
  const seen: Array<{ from: string; to: string; reason: string }> = [];
  const builder = new BlockBuilder((e) => events.push(e));
  const result = runAgent({
    provider: primary,
    messages: [{ role: "user", content: "go" }] as ChatMessage[],
    tools: [],
    workspace: process.cwd(),
    signal: new AbortController().signal,
    builder,
    fallbacks,
    onFallback: (info) => seen.push(info),
  });
  return { result, events, seen };
}

describe("L5 回退链", () => {
  it("可重试错误在首步换到下一个模型,结果与模型名都来自接手方", async () => {
    const { result, seen } = await run(provider("a", { fail: "429 rate limit exceeded" }), [provider("b", { text: "B 的答复" })]);
    const r = await result;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ from: "a-model", to: "b-model" });
    expect(r.finalText).toBe("B 的答复");
    expect(r.provider.config.id).toBe("b");
  });

  it("400 与上下文超长不换模型,直接抛出", async () => {
    for (const msg of ["400 invalid request", "This model's maximum context length is 8192 tokens"]) {
      const { result, seen } = await run(provider("a", { fail: msg }), [provider("b")]);
      await expect(result).rejects.toThrow();
      expect(seen).toHaveLength(0);
    }
  });

  it("回退链耗尽后抛出最后一个错误", async () => {
    const { result, seen } = await run(provider("a", { fail: "503 overloaded" }), [provider("b", { fail: "502 bad gateway" })]);
    await expect(result).rejects.toThrow(/502/);
    expect(seen).toHaveLength(1);
  });

  it("错误分类:网络与限流可重试,鉴权与参数错误不可重试", () => {
    expect(isRetryableModelError("fetch failed")).toBe(true);
    expect(isRetryableModelError("socket hang up")).toBe(true);
    expect(isRetryableModelError("quota exceeded")).toBe(true);
    expect(isRetryableModelError("401 unauthorized")).toBe(false);
    expect(isRetryableModelError("400 bad request")).toBe(false);
  });
});

describe("L5 成本账本", () => {
  const setup = () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, session_id TEXT, message_id INTEGER, task_id TEXT,
        provider_id TEXT, model TEXT,
        prompt INTEGER NOT NULL DEFAULT 0, completion INTEGER NOT NULL DEFAULT 0,
        cached INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0
      );
    `);
    db.prepare("INSERT INTO sessions (id, title, created_at) VALUES ('s1', '会话一', '2026-01-01T00:00:00Z')").run();
    return { db, ledger: new UsageLedger(db) };
  };

  it("成本 = 未缓存输入 + 缓存输入 + 输出,按每百万 tokens 计价", () => {
    const pricing = { input: 3, output: 15, cachedInput: 0.3 };
    const cost = costOf({ promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000, cachedTokens: 400_000 }, pricing);
    // 600k * 3 + 400k * 0.3 + 1000k * 15 = 1.8 + 0.12 + 15
    expect(cost).toBeCloseTo(16.92, 6);
  });

  it("未定价模型记 0 成本但仍计 token", () => {
    expect(costOf({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, undefined)).toBe(0);
  });

  it("按模型聚合与合计,未定价模型成本为 0", () => {
    const { ledger } = setup();
    ledger.record({ sessionId: "s1", providerId: "p1", model: "m1", usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, pricing: { input: 3, output: 15 } });
    ledger.record({ sessionId: "s1", providerId: "p2", model: "m2", usage: { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 } });
    const s = ledger.summary("model");
    expect(s.rows).toHaveLength(2);
    const m1 = s.rows.find((r) => r.key === "m1")!;
    expect(m1.totalTokens).toBe(1500);
    expect(m1.cost).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000, 9);
    expect(s.rows.find((r) => r.key === "m2")!.cost).toBe(0);
    expect(s.total.totalTokens).toBe(4500);
  });

  it("按天聚合按日期正序,今日花费可查", () => {
    const { db, ledger } = setup();
    ledger.record({ model: "m1", usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 }, pricing: { input: 1_000_000, output: 0 } });
    db.prepare("INSERT INTO usage_ledger (id, at, prompt, completion, cached, cost) VALUES ('old', '2020-01-01T00:00:00Z', 5, 0, 0, 0.5)").run();
    const s = ledger.summary("day");
    expect(s.rows.map((r) => r.key)).toEqual(["2020-01-01", new Date().toISOString().slice(0, 10)]);
    expect(ledger.spentToday()).toBeCloseTo(10, 6);
  });

  it("按会话聚合显示会话标题", () => {
    const { ledger } = setup();
    ledger.record({ sessionId: "s1", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    expect(ledger.summary("session").rows[0].label).toBe("会话一");
  });
});
