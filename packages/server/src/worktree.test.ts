import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, ProviderConfig } from "@xiyun/shared";
import type { ChatProvider, ModelRegistry } from "@xiyun/runtime";
import { MemoryStore } from "./memory.ts";
import { Scheduler, TaskStore } from "./tasks.ts";
import { gitExec } from "./tools.ts";
import { branchOf, createWorktree, diffStat, diffText, hasChanges, mergeBranch, removeWorktree } from "./worktree.ts";

// L4:后台写任务的 git worktree 隔离。
// 覆盖:两个并行 coder 任务各改各的文件、各自落在独立分支上,用户工作区不被改动;
// 合并后改动进入用户分支;丢弃会清掉 worktree 与分支。

const JSON_REPLY =
  '完成。\n```json\n{"status":"ok","summary":"已写入文件","artifacts":[],"changedFiles":[],"risks":[],"memoryCandidates":[]}\n```';

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

// coder 假模型:第一轮调用 write_file 写「提示里指定的文件名」,第二轮给出结果块。
// 用消息里有没有 tool 结果来判断是不是本轮第一次调用(同一 provider 被多个任务共用)。
function coderProvider(id: string): ChatProvider {
  const config: ProviderConfig = {
    id, name: id, baseUrl: "", apiKey: "", model: `${id}-model`, roles: ["coder"],
  };
  return {
    config,
    async *streamChat(): AsyncIterable<string> {
      throw new Error("应走 streamEvents");
    },
    async *streamEvents(messages: ChatMessage[]) {
      const hadTool = messages.some((m) => m.role === "tool");
      if (hadTool) {
        yield { type: "text", delta: JSON_REPLY } as const;
        yield { type: "finish", reason: "stop" } as const;
        return;
      }
      const prompt = messages.find((m) => m.role === "user")?.content ?? "";
      const file = /写入\s+(\S+)/.exec(prompt)?.[1] ?? "out.txt";
      const args = JSON.stringify({ path: file, content: `内容 ${file}\n` });
      yield { type: "tool_start", id: "c1", index: 0, name: "write_file" } as const;
      yield { type: "tool_args", id: "c1", delta: args } as const;
      yield { type: "tool_end", id: "c1", args } as const;
      yield { type: "finish", reason: "tool_calls" } as const;
    },
  };
}

function setup(providers: ChatProvider[]) {
  const events: Array<{ type: string; payload: unknown }> = [];
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'chat', workspace TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.5, scope TEXT NOT NULL DEFAULT 'global', valid_from TEXT NOT NULL, valid_to TEXT, deleted_at TEXT, source_message_id INTEGER, source_kind TEXT, source_session_id TEXT);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, content TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.5, scope TEXT NOT NULL DEFAULT 'global', session_id TEXT, mode TEXT NOT NULL DEFAULT 'chat', workspace TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT 'add', target_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, resolved_at TEXT, source_message_id INTEGER, source_kind TEXT, source_session_id TEXT);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, session_id TEXT, role TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL, schedule TEXT NOT NULL DEFAULT 'run', status TEXT NOT NULL DEFAULT 'queued', provider_id TEXT, model TEXT, mode TEXT NOT NULL DEFAULT 'chat', workspace TEXT NOT NULL DEFAULT '', depends_on TEXT, result TEXT, error TEXT, question TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, duration_ms INTEGER, worktree TEXT, branch TEXT, base_sha TEXT, steps INTEGER, usage TEXT, diff_stat TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(id UNINDEXED, content, tokenize='trigram');
  `);
  const memory = new MemoryStore(db);
  const store = new TaskStore(db);
  const scheduler = new Scheduler({
    store,
    memory,
    registry: () => fakeRegistry(providers),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  return { db, memory, store, scheduler, events };
}

async function waitStatus(store: TaskStore, id: string, want: string[], timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const s = store.get(id)?.status;
    if (s && want.includes(s)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting ${want.join("/")}, got ${s}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

// 建一个可提交的临时仓库
async function initRepo(): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), "xiyun-wt-"));
  const run = async (args: string[]) => {
    const r = await gitExec(ws, args);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败:${r.stderr.trim()}`);
  };
  await run(["init"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "test"]);
  writeFileSync(join(ws, "README.md"), "base\n", "utf8");
  await run(["add", "-A"]);
  await run(["commit", "-m", "init"]);
  return ws;
}

describe("L4 worktree 隔离", () => {
  it("两个并行 coder 任务各改各的文件,改动落在各自分支,用户工作区不变", async () => {
    const ws = await initRepo();
    const { store, scheduler, events } = setup([coderProvider("p1")]);
    const a = store.create({ role: "coder", prompt: "写入 a.txt", schedule: "parallel", mode: "code", workspace: ws });
    const b = store.create({ role: "coder", prompt: "写入 b.txt", schedule: "parallel", mode: "code", workspace: ws });

    scheduler.parallel([a.id, b.id]);
    await waitStatus(store, a.id, ["completed", "failed"]);
    await waitStatus(store, b.id, ["completed", "failed"]);

    expect(store.get(a.id)!.status).toBe("completed");
    expect(store.get(b.id)!.status).toBe("completed");

    // 用户工作区没被动过
    expect(existsSync(join(ws, "a.txt"))).toBe(false);
    expect(existsSync(join(ws, "b.txt"))).toBe(false);

    const ta = store.get(a.id)!;
    const tb = store.get(b.id)!;
    expect(ta.branch).toBe(branchOf(a.id));
    expect(tb.branch).toBe(branchOf(b.id));
    expect(ta.worktree).not.toBe(tb.worktree);
    expect(existsSync(ta.worktree!)).toBe(true);
    expect(existsSync(tb.worktree!)).toBe(true);

    // 各自 worktree 里有自己的文件,没有对方的
    expect(existsSync(join(ta.worktree!, "a.txt"))).toBe(true);
    expect(existsSync(join(ta.worktree!, "b.txt"))).toBe(false);
    expect(existsSync(join(tb.worktree!, "b.txt"))).toBe(true);
    expect(existsSync(join(tb.worktree!, "a.txt"))).toBe(false);

    // 改动已提交到各自分支
    expect(ta.diffStat, JSON.stringify(events)).toContain("a.txt");
    expect(tb.diffStat).toContain("b.txt");
    const log = await gitExec(ws, ["log", "--oneline", ta.branch!]);
    expect(log.exitCode).toBe(0);

    rmSync(ws, { recursive: true, force: true });
  });

  it("合并隔离分支后改动进入用户工作区,worktree 与分支被清理", async () => {
    const ws = await initRepo();
    const { store, scheduler } = setup([coderProvider("p1")]);
    const a = store.create({ role: "coder", prompt: "写入 a.txt", schedule: "parallel", mode: "code", workspace: ws });
    scheduler.parallel([a.id]);
    await waitStatus(store, a.id, ["completed", "failed"]);
    expect(store.get(a.id)!.status).toBe("completed");

    const t = store.get(a.id)!;
    await mergeBranch(ws, t.branch!);
    expect(existsSync(join(ws, "a.txt"))).toBe(true); // 合并进了用户工作区
    const mergeMsg = await gitExec(ws, ["log", "-1", "--pretty=%s"]);
    expect(mergeMsg.stdout).toContain("xiyun/"); // 合并提交记了来源分支

    await removeWorktree(ws, t.worktree!, t.branch!);
    expect(existsSync(t.worktree!)).toBe(false);
    const br = await gitExec(ws, ["show-ref", "--verify", "--quiet", `refs/heads/${t.branch}`]);
    expect(br.exitCode).not.toBe(0); // 分支已删除

    rmSync(ws, { recursive: true, force: true });
  });

  it("失败任务不留下 worktree 与分支", async () => {
    const ws = await initRepo();
    const bad: ChatProvider = {
      config: { id: "bad", name: "bad", baseUrl: "", apiKey: "", model: "m", roles: ["coder"] },
      async *streamChat(): AsyncIterable<string> {
        throw new Error("模型不可用");
      },
    };
    const { store, scheduler } = setup([bad]);
    const t = store.create({ role: "coder", prompt: "写入 a.txt", schedule: "parallel", mode: "code", workspace: ws });
    scheduler.parallel([t.id]);
    await waitStatus(store, t.id, ["failed"]);

    const done = store.get(t.id)!;
    expect(done.worktree).toBeNull();
    expect(done.branch).toBeNull();
    const br = await gitExec(ws, ["show-ref", "--verify", "--quiet", `refs/heads/${branchOf(t.id)}`]);
    expect(br.exitCode).not.toBe(0); // 分支已清理
    expect(existsSync(join(ws, ".xiyun-wt", t.id))).toBe(false);

    rmSync(ws, { recursive: true, force: true });
  });

  it("worktree 模块:新建分支、提交改动、统计变更", async () => {
    const ws = await initRepo();
    const wt = await createWorktree(ws, "task-direct");
    expect(existsSync(wt.path)).toBe(true);
    writeFileSync(join(wt.path, "x.txt"), "hi\n", "utf8");
    expect(await hasChanges(wt.path)).toBe(true);
    const { commitAll } = await import("./worktree.ts");
    await commitAll(wt.path, "test");
    expect(await hasChanges(wt.path)).toBe(false);
    const stat = await diffStat(ws, wt.baseSha, wt.branch);
    expect(stat).toContain("x.txt");
    // 完整 diff:带 +/- 行,任务卡片展开时用
    const patch = await diffText(ws, wt.baseSha, wt.branch);
    expect(patch).toContain("+hi");
    // 用户工作区不受影响
    expect(existsSync(join(ws, "x.txt"))).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });
});
