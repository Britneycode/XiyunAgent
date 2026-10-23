import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChatProvider } from "@xiyun/runtime";
import type { MemoryStore } from "./memory.ts";
import { extractMemoriesDetailed } from "./extract.ts";

// ---- L2:从导入历史批量提取记忆(D-026)----
// 一次只跑一个会话,会话之间留间隔;支持暂停 / 恢复 / 取消;服务重启后运行中的作业转为 paused。

export type JobStatus = "queued" | "running" | "paused" | "done" | "cancelled";

export interface MemoryJob {
  id: string;
  source: string;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  source: string;
  status: string;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  scope: string;
  created_at: string;
  updated_at: string;
}

const toJob = (r: JobRow): MemoryJob => ({
  id: r.id,
  source: r.source,
  status: r.status as JobStatus,
  total: r.total,
  done: r.done,
  failed: r.failed,
  error: r.error,
  scope: r.scope,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const now = () => new Date().toISOString();

export interface JobRunnerOptions {
  db: DatabaseSync;
  memory: MemoryStore;
  provider: () => ChatProvider | undefined;
  // 会话之间间隔,默认 2 秒
  gapMs?: number;
  // 取某个会话的消息(带 id,用于出处回链)
  historyFor: (sessionId: string) => Array<{ role: "user" | "assistant"; content: string; id?: number }>;
  // 会话是否值得提取(至少 2 轮)
  shouldProcess?: (sessionId: string) => boolean;
}

export class MemoryJobRunner {
  private opts: JobRunnerOptions;
  private running = new Set<string>(); // 正在执行的 jobId
  private cancelled = new Set<string>();
  private paused = new Set<string>();

  constructor(opts: JobRunnerOptions) {
    this.opts = opts;
    // 服务重启后,上次运行中的作业转为 paused
    this.opts.db.prepare("UPDATE memory_jobs SET status = 'paused', updated_at = ? WHERE status = 'running'").run(now());
  }

  // 创建作业:items 为要处理的会话 id
  create(o: { source: string; sessionIds: string[]; scope?: string }): MemoryJob {
    const id = randomUUID();
    const ts = now();
    const db = this.opts.db;
    db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO memory_jobs (id, source, status, total, done, failed, error, scope, created_at, updated_at) VALUES (?, ?, 'queued', ?, 0, 0, NULL, ?, ?, ?)",
      ).run(id, o.source, o.sessionIds.length, o.scope ?? "global", ts, ts);
      const ins = db.prepare("INSERT INTO memory_job_items (job_id, session_id, status, facts_added) VALUES (?, ?, 'pending', 0)");
      for (const sid of o.sessionIds) ins.run(id, sid);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return this.get(id)!;
  }

  get(id: string): MemoryJob | undefined {
    const r = this.opts.db.prepare("SELECT * FROM memory_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return r ? toJob(r) : undefined;
  }

  list(limit = 20): MemoryJob[] {
    const rows = this.opts.db.prepare("SELECT * FROM memory_jobs ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as JobRow[];
    return rows.map(toJob);
  }

  items(jobId: string): Array<{ sessionId: string; status: string; factsAdded: number; error: string | null }> {
    const rows = this.opts.db
      .prepare("SELECT session_id, status, facts_added, error FROM memory_job_items WHERE job_id = ? ORDER BY rowid")
      .all(jobId) as Array<{ session_id: string; status: string; facts_added: number; error: string | null }>;
    return rows.map((r) => ({ sessionId: r.session_id, status: r.status, factsAdded: r.facts_added, error: r.error }));
  }

  pause(id: string): boolean {
    const j = this.get(id);
    if (!j || (j.status !== "running" && j.status !== "queued")) return false;
    this.paused.add(id);
    this.setStatus(id, "paused");
    return true;
  }

  resume(id: string): boolean {
    const j = this.get(id);
    if (!j || j.status !== "paused") return false;
    this.paused.delete(id);
    this.setStatus(id, "queued");
    void this.run(id);
    return true;
  }

  cancel(id: string): boolean {
    const j = this.get(id);
    if (!j || j.status === "done" || j.status === "cancelled") return false;
    this.cancelled.add(id);
    this.setStatus(id, "cancelled");
    return true;
  }

  private setStatus(id: string, status: JobStatus) {
    this.opts.db.prepare("UPDATE memory_jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
  }

  // 启动执行(异步;调用方不必等待)
  async run(id: string): Promise<void> {
    if (this.running.has(id)) return;
    const job = this.get(id);
    if (!job || job.status === "done" || job.status === "cancelled" || job.status === "paused") return;
    this.running.add(id);
    this.setStatus(id, "running");
    const db = this.opts.db;
    try {
      const pending = db
        .prepare("SELECT session_id FROM memory_job_items WHERE job_id = ? AND status = 'pending' ORDER BY rowid")
        .all(id) as Array<{ session_id: string }>;
      let index = 0;
      for (const { session_id: sid } of pending) {
        if (this.cancelled.has(id)) break;
        while (this.paused.has(id)) {
          await new Promise((r) => setTimeout(r, 200));
          if (this.cancelled.has(id)) break;
        }
        if (this.cancelled.has(id)) break;
        if (this.opts.shouldProcess && !this.opts.shouldProcess(sid)) {
          db.prepare("UPDATE memory_job_items SET status = 'skipped' WHERE job_id = ? AND session_id = ?").run(id, sid);
          continue;
        }
        const provider = this.opts.provider();
        if (!provider) {
          db.prepare("UPDATE memory_jobs SET status = 'paused', error = ?, updated_at = ? WHERE id = ?").run("没有可用的记忆模型", now(), id);
          return;
        }
        try {
          const history = this.opts.historyFor(sid);
          const existing = this.opts.memory.list().map((f) => f.content);
          const r = await this.withRetry(() =>
            extractMemoriesDetailed({
              provider,
              memory: this.opts.memory,
              history,
              sessionId: sid,
              mode: "chat",
              workspace: "",
              existingFacts: existing,
              scope: job.scope,
              sourceKind: job.source,
            }),
          );
          db.prepare("UPDATE memory_job_items SET status = 'done', facts_added = ? WHERE job_id = ? AND session_id = ?").run(
            r.added, id, sid,
          );
          db.prepare("UPDATE memory_jobs SET done = done + 1, updated_at = ? WHERE id = ?").run(now(), id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          db.prepare("UPDATE memory_job_items SET status = 'failed', error = ? WHERE job_id = ? AND session_id = ?").run(msg.slice(0, 300), id, sid);
          db.prepare("UPDATE memory_jobs SET failed = failed + 1, updated_at = ? WHERE id = ?").run(now(), id);
        }
        index += 1;
        // 会话之间留间隔,避免触发限流
        if (index < pending.length && !this.cancelled.has(id) && (this.opts.gapMs ?? 2000) > 0) {
          await new Promise((r) => setTimeout(r, this.opts.gapMs ?? 2000));
        }
      }
      if (this.cancelled.has(id)) this.setStatus(id, "cancelled");
      else if (this.paused.has(id)) this.setStatus(id, "paused");
      else this.setStatus(id, "done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.prepare("UPDATE memory_jobs SET status = 'paused', error = ?, updated_at = ? WHERE id = ?").run(msg.slice(0, 300), now(), id);
    } finally {
      this.running.delete(id);
    }
  }

  // 429 时指数退避,最多 3 次
  private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!/429|rate.?limit|too many requests/i.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
    }
    throw lastErr;
  }
}
