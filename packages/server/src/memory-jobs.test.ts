import { describe, expect, it, vi } from "vitest";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { MemoryJobRunner } from "./memory-jobs.ts";
import type { ChatProvider } from "@xiyun/runtime";

// 假 provider:按脚本返回 JSON,或抛出指定错误
function fakeProvider(reply: (call: number) => string | Error): ChatProvider & { calls: number } {
  const p = {
    calls: 0,
    config: { id: "p1", name: "p1", kind: "openai", baseUrl: "http://x", model: "m", apiKey: "k" } as never,
    async *streamChat() {
      p.calls++;
      const r = reply(p.calls);
      if (r instanceof Error) throw r;
      yield r;
    },
  };
  return p as unknown as ChatProvider & { calls: number };
}

function setup(reply: (call: number) => string | Error, opts: { gapMs?: number } = {}) {
  const db = openDb(":memory:");
  const memory = new MemoryStore(db);
  const provider = fakeProvider(reply);
  const runner = new MemoryJobRunner({
    db,
    memory,
    provider: () => provider,
    gapMs: opts.gapMs ?? 0,
    historyFor: (sid) => [
      { role: "user" as const, content: `问题 ${sid}`, id: 1 },
      { role: "assistant" as const, content: `回答 ${sid}`, id: 2 },
    ],
  });
  return { db, memory, provider, runner };
}

const OK = `[{"content":"用户偏好中文","confidence":0.9,"reason":"多次要求","index":1}]`;

describe("MemoryJobRunner", () => {
  it("创建作业并跑完,进度与事实都落库", async () => {
    const { memory, runner } = setup(() => OK);
    const job = runner.create({ source: "import:chatgpt", sessionIds: ["s1", "s2"], scope: "global" });
    expect(job.total).toBe(2);
    expect(job.status).toBe("queued");
    await runner.run(job.id);
    const done = runner.get(job.id)!;
    expect(done.status).toBe("done");
    expect(done.done).toBe(2);
    expect(done.failed).toBe(0);
    // 提取产出候选记忆(需确认成事实)
    const cands = memory.listCandidates("pending");
    expect(cands.length).toBe(2);
    expect(cands[0].sourceKind).toBe("import:chatgpt");
    expect(cands[0].scope).toBe("global");
  });

  it("source 正确写入事实(确认候选后)", async () => {
    const { memory, runner } = setup(() => OK);
    const job = runner.create({ source: "import:claude", sessionIds: ["s1"] });
    await runner.run(job.id);
    const cand = memory.listCandidates("pending")[0]!;
    const fact = memory.confirmCandidate(cand.id);
    expect(fact.sourceKind).toBe("import:claude");
    expect(fact.sourceSessionId).toBe("s1");
    expect(fact.sourceMessageId).toBe(1);
  });

  it("出处回链:记忆指向原消息", async () => {
    const { memory, runner } = setup(() => OK);
    const job = runner.create({ source: "import:chatgpt", sessionIds: ["s1"] });
    await runner.run(job.id);
    const cand = memory.listCandidates("pending")[0]!;
    expect(cand.sourceMessageId).toBe(1);
    expect(cand.sourceSessionId).toBe("s1");
    expect(memory.list().length).toBe(0); // 候选还没进事实
  });

  it("单个会话失败计入 failed,不中断整批", async () => {
    let n = 0;
    const { runner } = setup(() => {
      n++;
      return n === 1 ? new Error("boom") : OK;
    });
    const job = runner.create({ source: "import:chatgpt", sessionIds: ["s1", "s2"] });
    await runner.run(job.id);
    const done = runner.get(job.id)!;
    expect(done.failed).toBe(1);
    expect(done.done).toBe(1);
    expect(done.status).toBe("done");
    const items = runner.items(job.id);
    expect(items.find((i) => i.sessionId === "s1")!.status).toBe("failed");
    expect(items.find((i) => i.sessionId === "s2")!.status).toBe("done");
  });

  it("暂停后可恢复,取消后不再继续", async () => {
    const { runner } = setup(() => OK, { gapMs: 50 });
    const job = runner.create({ source: "import:chatgpt", sessionIds: ["s1", "s2", "s3"] });
    expect(runner.pause(job.id)).toBe(true);
    expect(runner.get(job.id)!.status).toBe("paused");
    // 暂停状态下 run 直接返回
    await runner.run(job.id);
    expect(runner.get(job.id)!.status).toBe("paused");
    expect(runner.resume(job.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(runner.get(job.id)!.status).toBe("done");
    // 取消已结束的作业返回 false
    expect(runner.cancel(job.id)).toBe(false);
  });

  it("运行中的作业可取消", async () => {
    const { runner } = setup(() => OK, { gapMs: 100 });
    const job = runner.create({ source: "import:chatgpt", sessionIds: ["s1", "s2", "s3"] });
    void runner.run(job.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.cancel(job.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(runner.get(job.id)!.status).toBe("cancelled");
  });

  it("重启后运行中的作业转为 paused", async () => {
    const { db, memory, provider, runner } = setup(() => OK);
    const job = runner.create({ source: "import:chatgpt", sessionIds: ["s1"] });
    db.prepare("UPDATE memory_jobs SET status = 'running' WHERE id = ?").run(job.id);
    // 新建 runner(相当于服务重启)
    const runner2 = new MemoryJobRunner({ db, memory, provider: () => provider, gapMs: 0, historyFor: () => [] });
    expect(runner2.get(job.id)!.status).toBe("paused");
  });

  it("429 限速时指数退避后重试成功", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const { runner } = setup(() => {
        n++;
        return n === 1 ? new Error("429 rate limit exceeded") : OK;
      });
      const job = runner.create({ source: "import:chatgpt", sessionIds: ["s1"] });
      const p = runner.run(job.id);
      // 第一次失败后退避 1s,再试成功
      await vi.advanceTimersByTimeAsync(1200);
      await p;
      const done = runner.get(job.id)!;
      expect(done.failed).toBe(0);
      expect(done.done).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shouldProcess 为 false 的会话被跳过", async () => {
    const db = openDb(":memory:");
    const memory = new MemoryStore(db);
    const provider = fakeProvider(() => OK);
    const runner = new MemoryJobRunner({
      db, memory, provider: () => provider, gapMs: 0,
      historyFor: () => [{ role: "user", content: "q", id: 1 }],
      shouldProcess: () => false,
    });
    const job = runner.create({ source: "import:chatgpt", sessionIds: ["s1"] });
    await runner.run(job.id);
    expect(runner.items(job.id)[0]!.status).toBe("skipped");
    expect(runner.get(job.id)!.done).toBe(0);
  });
});

describe("MemoryStore.revokeBySource", () => {
  it("按来源批量撤销,返回撤销条数", () => {
    const db = openDb(":memory:");
    const memory = new MemoryStore(db);
    memory.addFact("来自 chatgpt 的记忆", { sourceKind: "import:chatgpt" });
    memory.addFact("另一条 chatgpt 记忆", { sourceKind: "import:chatgpt" });
    memory.addFact("来自 claude 的记忆", { sourceKind: "import:claude" });
    memory.addFact("手动加的记忆", {});
    expect(memory.revokeBySource("import:chatgpt")).toBe(2);
    const left = memory.list();
    expect(left.map((f) => f.content)).toContain("来自 claude 的记忆");
    expect(left.map((f) => f.content)).toContain("手动加的记忆");
    expect(left.map((f) => f.content)).not.toContain("来自 chatgpt 的记忆");
    // 已撤销的不在检索结果里
    expect(memory.search("chatgpt", 10).length).toBe(0);
  });

  it("来源不存在时返回 0", () => {
    const db = openDb(":memory:");
    const memory = new MemoryStore(db);
    expect(memory.revokeBySource("import:nobody")).toBe(0);
  });
});
