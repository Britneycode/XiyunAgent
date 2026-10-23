import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";
import { gitExec } from "./tools.ts";
import { commitAll, createWorktree } from "./worktree.ts";

// L4:任务卡片展开时的详情接口 —— 完整 diff 与每步工具。

async function initRepo(): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), "xiyun-detail-"));
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

function setup() {
  const db = openDb(":memory:");
  const store = new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-detail-cfg-")));
  const app = createApp(db, new MemoryStore(db), store, { titleProvider: () => undefined });
  return { app, db };
}

describe("L4 任务详情", () => {
  it("返回完整 diff 与按顺序排列的每步工具", async () => {
    const ws = await initRepo();
    const wt = await createWorktree(ws, "task-detail");
    writeFileSync(join(wt.path, "x.txt"), "hi\n", "utf8");
    await commitAll(wt.path, "测试提交");

    const { app, db } = setup();
    db.prepare(
      `INSERT INTO tasks (id, group_id, role, prompt, workspace, status, created_at, worktree, branch, base_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("task-detail", "g1", "coder", "写文件", ws, "completed", new Date().toISOString(), wt.path, wt.branch, wt.baseSha);
    for (const [tool, status] of [["write_file", "success"], ["shell", "error"]] as const) {
      db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('task.tool', ?, ?)").run(
        JSON.stringify({ taskId: "task-detail", tool, workspace: ws, status }), new Date().toISOString(),
      );
    }
    // 其它任务的事件不能混进来
    db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('task.tool', ?, ?)").run(
      JSON.stringify({ taskId: "task-other", tool: "read_file", workspace: ws, status: "success" }), new Date().toISOString(),
    );

    const r = (await (await app.request("/tasks/task-detail/detail")).json()) as {
      branch: string; baseSha: string; patch: string; tools: Array<{ tool: string; status: string }>;
    };
    expect(r.branch).toBe(wt.branch);
    expect(r.baseSha).toBe(wt.baseSha);
    expect(r.patch).toContain("+hi");
    expect(r.tools.map((t) => [t.tool, t.status])).toEqual([["write_file", "success"], ["shell", "error"]]);

    expect((await app.request("/tasks/nope/detail")).status).toBe(404);
    rmSync(ws, { recursive: true, force: true });
  });
});
