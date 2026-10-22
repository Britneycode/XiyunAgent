import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, ProviderConfig } from "@xiyun/shared";
import type { ChatProvider, ModelRegistry } from "@xiyun/runtime";
import { MemoryStore } from "./memory.ts";
import { MAX_GROUP_TASKS, Scheduler, TaskStore } from "./tasks.ts";

function fakeProvider(id: string, roles: string[], reply: string, delayMs = 0): ChatProvider {
  const config: ProviderConfig = { id, name: id, baseUrl: "", apiKey: "", model: `${id}-model`, roles: roles as ProviderConfig["roles"] };
  return {
    config,
    async *streamChat(_messages: ChatMessage[], opts?: { signal?: AbortSignal }) {
      if (delayMs) {
        await new Promise((res, rej) => {
          const t = setTimeout(res, delayMs);
          opts?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); });
        });
      }
      yield reply;
    },
  };
}

function fakeRegistry(providers: ChatProvider[]): ModelRegistry {
  const map = new Map(providers.map((p) => [p.config.id, p]));
  return {
    register: () => {},
    get: (id: string) => map.get(id),
    byRole: (role: string) => providers.find((p) => p.config.roles?.includes(role as never)),
    byRoleAll: (role: string) => providers.filter((p) => p.config.roles?.includes(role as never)),
    first: () => providers[0],
  } as unknown as ModelRegistry;
}

const JSON_REPLY = '结论如下。\n```json\n{"status":"ok","summary":"完成了分析","artifacts":["a.md"],"changedFiles":[],"risks":["无"],"memoryCandidates":[{"content":"用户偏好中文回复","reason":"稳定偏好","confidence":0.6}]}\n```';

function setup(providers: ChatProvider[]) {
  // 内存库 + 与 db.ts 一致的建表语句
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'chat', workspace TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.5, scope TEXT NOT NULL DEFAULT 'global', valid_from TEXT NOT NULL, valid_to TEXT, deleted_at TEXT);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, content TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.5, scope TEXT NOT NULL DEFAULT 'global', session_id TEXT, mode TEXT NOT NULL DEFAULT 'chat', workspace TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT 'add', target_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, resolved_at TEXT);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, session_id TEXT, role TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL, schedule TEXT NOT NULL DEFAULT 'run', status TEXT NOT NULL DEFAULT 'queued', provider_id TEXT, model TEXT, mode TEXT NOT NULL DEFAULT 'chat', workspace TEXT NOT NULL DEFAULT '', depends_on TEXT, result TEXT, error TEXT, question TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, duration_ms INTEGER);
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(id UNINDEXED, content, tokenize='trigram');
  `);
  const memory = new MemoryStore(db);
  const store = new TaskStore(db);
  const scheduler = new Scheduler({ store, memory, registry: () => fakeRegistry(providers) });
  return { db, memory, store, scheduler };
}

async function waitStatus(store: TaskStore, id: string, want: string[], timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    const s = store.get(id)?.status;
    if (s && want.includes(s)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting ${want}, got ${s}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("TaskStore/Scheduler", () => {
  it("run:执行单任务并解析结构化结果,记忆产出进候选区", async () => {
    const { store, scheduler, memory } = setup([fakeProvider("p1", ["researcher"], JSON_REPLY)]);
    const t = store.create({ role: "researcher", prompt: "调研贝叶斯定理的应用" });
    scheduler.run(t.id);
    await waitStatus(store, t.id, ["completed"]);
    const done = store.get(t.id)!;
    expect(done.result?.status).toBe("ok");
    expect(done.result?.summary).toBe("完成了分析");
    expect(done.model).toBe("p1-model");
    expect(done.durationMs).not.toBeNull();
    expect(memory.listCandidates("pending").some((c) => c.content === "用户偏好中文回复")).toBe(true);
  });

  it("未绑定角色的模型不允许自动回退,任务直接失败", async () => {
    const { store, scheduler } = setup([fakeProvider("p1", ["main"], "hello")]);
    const t = store.create({ role: "coder", prompt: "写代码" });
    scheduler.run(t.id);
    await waitStatus(store, t.id, ["failed"]);
    expect(store.get(t.id)!.error).toContain("未绑定模型");
  });

  it("parallel:只读角色并行完成;超过 3 个任务的组由 API 层限制", async () => {
    const { store, scheduler } = setup([
      fakeProvider("p1", ["researcher"], JSON_REPLY),
      fakeProvider("p2", ["reviewer"], JSON_REPLY),
    ]);
    const a = store.create({ role: "researcher", prompt: "任务A", schedule: "parallel" });
    const b = store.create({ role: "reviewer", prompt: "任务B", schedule: "parallel" });
    scheduler.parallel([a.id, b.id]);
    await waitStatus(store, a.id, ["completed"]);
    await waitStatus(store, b.id, ["completed"]);
    expect(MAX_GROUP_TASKS).toBe(3);
  });

  it("pipeline:上游摘要注入下游,上游失败即终止", async () => {
    const seen: string[] = [];
    const p1: ChatProvider = {
      config: { id: "p1", name: "p1", baseUrl: "", apiKey: "", model: "m1", roles: ["researcher"] },
      async *streamChat() { yield JSON_REPLY; },
    };
    const p2: ChatProvider = {
      config: { id: "p2", name: "p2", baseUrl: "", apiKey: "", model: "m2", roles: ["tutor"] },
      async *streamChat(messages: ChatMessage[]) {
        seen.push(messages[0].content);
        yield JSON_REPLY;
      },
    };
    const { store, scheduler } = setup([p1, p2]);
    const a = store.create({ role: "researcher", prompt: "第一步", schedule: "pipeline" });
    const b = store.create({ role: "tutor", prompt: "第二步", schedule: "pipeline", dependsOn: a.id });
    await scheduler.pipeline([a.id, b.id]);
    expect(store.get(a.id)!.status).toBe("completed");
    expect(store.get(b.id)!.status).toBe("completed");
    expect(seen[0]).toContain("完成了分析"); // 上游摘要注入下游 system
  });

  it("cancel:排队中取消与运行中取消", async () => {
    const { store, scheduler } = setup([fakeProvider("p1", ["researcher"], JSON_REPLY, 500)]);
    const t = store.create({ role: "researcher", prompt: "慢任务" });
    scheduler.run(t.id);
    await waitStatus(store, t.id, ["running"]);
    expect(scheduler.cancel(t.id)).toBe(true);
    await waitStatus(store, t.id, ["cancelled"]);
    expect(store.get(t.id)!.status).toBe("cancelled");
  });

  it("recover:queued/running 重置并可重新执行", async () => {
    const { store, scheduler } = setup([fakeProvider("p1", ["researcher"], JSON_REPLY)]);
    const t = store.create({ role: "researcher", prompt: "恢复任务" });
    store.setStatus(t.id, "running"); // 模拟中断残留
    const n = store.recoverInterrupted();
    expect(n).toBe(1);
    expect(store.get(t.id)!.status).toBe("queued");
    scheduler.recover();
    await waitStatus(store, t.id, ["completed"]);
  });

  it("retry:失败任务可重试", async () => {
    const { store, scheduler } = setup([fakeProvider("p1", ["main"], "x")]); // coder 未绑定 → 失败
    const t = store.create({ role: "coder", prompt: "任务" });
    scheduler.run(t.id);
    await waitStatus(store, t.id, ["failed"]);
    expect(scheduler.retry(t.id)).toBe(true);
    await waitStatus(store, t.id, ["failed"]); // 仍失败但状态流转正确
  });

  it("回退链:同角色首个模型失败后回退到下一个已授权模型", async () => {
    const failing: ChatProvider = {
      config: { id: "bad", name: "bad", baseUrl: "", apiKey: "", model: "bad-model", roles: ["researcher"] },
      async *streamChat(): AsyncIterable<string> { throw new Error("connection refused"); },
    };
    const good = fakeProvider("good", ["researcher"], JSON_REPLY);
    const { store, scheduler } = setup([failing, good]);
    const t = store.create({ role: "researcher", prompt: "任务" });
    scheduler.run(t.id);
    await waitStatus(store, t.id, ["completed"]);
    expect(store.get(t.id)!.model).toBe("good-model"); // 回退到链内下一个授权模型
  });

  it("waiting_for_user:模型提问后暂停,resume 注入回答继续执行", async () => {
    const ASK = '我需要更多信息。\n```json\n{"status":"partial","summary":"缺少年级信息","artifacts":[],"changedFiles":[],"risks":[],"memoryCandidates":[],"question":"用户是几年级?"}\n```';
    const systems: string[] = [];
    let call = 0;
    const p: ChatProvider = {
      config: { id: "p1", name: "p1", baseUrl: "", apiKey: "", model: "m1", roles: ["tutor"] },
      async *streamChat(messages: ChatMessage[]) {
        systems.push(messages[0].content);
        yield call++ === 0 ? ASK : JSON_REPLY;
      },
    };
    const { store, scheduler } = setup([p]);
    const t = store.create({ role: "tutor", prompt: "讲讲贝叶斯定理" });
    scheduler.run(t.id);
    await waitStatus(store, t.id, ["waiting_for_user"]);
    expect(store.get(t.id)!.question).toBe("用户是几年级?");
    expect(scheduler.resume(t.id, "大二")).toBe(true);
    await waitStatus(store, t.id, ["completed"]);
    expect(systems[1]).toContain("大二"); // 用户回答注入第二次执行
    expect(store.get(t.id)!.question).toBeNull();
  });

  it("code 模式:coder 用原生工具调用 read_file,结果喂回后继续", async () => {
    const ws = mkdtempSync(join(tmpdir(), "xiyun-task-"));
    writeFileSync(join(ws, "x.txt"), "file-content-42");
    let calls = 0;
    const seen: string[][] = [];
    const p: ChatProvider = {
      config: { id: "p1", name: "p1", baseUrl: "", apiKey: "", model: "m1", roles: ["coder"] },
      async *streamChat(_messages: ChatMessage[]) {
        throw new Error("应走 streamEvents");
      },
      async *streamEvents(messages: ChatMessage[]) {
        calls++;
        seen.push(messages.map((m) => m.content));
        if (calls === 1) {
          yield { type: "text", delta: "先读文件" } as const;
          yield { type: "tool_start", id: "c1", index: 0, name: "read_file" } as const;
          yield { type: "tool_args", id: "c1", delta: "{\"path\":\"x.txt\"}" } as const;
          yield { type: "tool_end", id: "c1", args: "{\"path\":\"x.txt\"}" } as const;
          yield { type: "finish", reason: "tool_calls" } as const;
        } else {
          yield { type: "text", delta: JSON_REPLY } as const;
          yield { type: "finish", reason: "stop" } as const;
        }
      },
    };
    const { store, scheduler } = setup([p]);
    const t = store.create({ role: "coder", prompt: "读取 x.txt 的内容", mode: "code", workspace: ws });
    scheduler.run(t.id);
    await waitStatus(store, t.id, ["completed"]);
    expect(calls).toBe(2);
    expect(seen[1].some((m) => m.includes("file-content-42"))).toBe(true); // 工具结果喂回
    expect(seen[0][0]).toContain("你可以使用工具"); // system 含工具使用说明
    rmSync(ws, { recursive: true, force: true });
  });

  it("chat 模式不注入工具协议", async () => {
    const systems: string[] = [];
    const p: ChatProvider = {
      config: { id: "p1", name: "p1", baseUrl: "", apiKey: "", model: "m1", roles: ["coder"] },
      async *streamChat(messages: ChatMessage[]) {
        systems.push(messages[0].content);
        yield JSON_REPLY;
      },
    };
    const { store, scheduler } = setup([p]);
    const t = store.create({ role: "coder", prompt: "任务", mode: "chat" });
    scheduler.run(t.id);
    await waitStatus(store, t.id, ["completed"]);
    expect(systems[0]).not.toContain("你可以使用工具");
  });
});
