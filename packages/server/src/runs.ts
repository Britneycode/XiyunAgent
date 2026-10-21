import { randomUUID } from "node:crypto";

// ---- 生成运行注册表(F1 / D-020)----
// 一次 /chat 生成 = 一个 Run,在服务端后台执行,与 HTTP 连接解耦:
// 客户端断开只移除订阅者,生成继续并照常落库;只有 POST /runs/:id/cancel 能中止。
// 事件按 seq 编号缓存在内存,重新订阅时按 after(或 Last-Event-ID)回放;结束后保留一段时间再回收。

export type RunStatus = "running" | "done" | "error" | "cancelled";
export type RunEvent = { seq: number; data: string };
type Sub = { onEvent: (e: RunEvent) => void; onEnd: () => void };

const KEEP_FINISHED_MS = 5 * 60_000;
const MAX_EVENTS = 50_000; // 超长输出的保护:超出后不再缓存(实时订阅者照常收到)

export class Run {
  readonly id = randomUUID();
  readonly ac = new AbortController();
  readonly startedAt = Date.now();
  status: RunStatus = "running";
  finishedAt: number | null = null;
  userMessageId: number | null = null;
  private events: RunEvent[] = [];
  private seq = 0;
  private subs = new Set<Sub>();

  readonly sessionId: string;
  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  emit(obj: unknown): void {
    if (this.status !== "running") return;
    const e = { seq: ++this.seq, data: JSON.stringify(obj) };
    if (this.events.length < MAX_EVENTS) this.events.push(e);
    for (const s of this.subs) s.onEvent(e);
  }

  // 先回放 seq > after 的事件,再接收实时事件;已结束的 Run 回放后立即 onEnd
  subscribe(onEvent: Sub["onEvent"], onEnd: Sub["onEnd"], after = 0): () => void {
    for (const e of this.events) if (e.seq > after) onEvent(e);
    if (this.status !== "running") {
      onEnd();
      return () => {};
    }
    const sub = { onEvent, onEnd };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  finish(status: Exclude<RunStatus, "running">): void {
    if (this.status !== "running") return;
    this.status = status;
    this.finishedAt = Date.now();
    for (const s of this.subs) s.onEnd();
    this.subs.clear();
  }

  info() {
    return {
      id: this.id, sessionId: this.sessionId, status: this.status, userMessageId: this.userMessageId,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: this.finishedAt ? new Date(this.finishedAt).toISOString() : null,
    };
  }
}

export class RunRegistry {
  private runs = new Map<string, Run>();
  private latest = new Map<string, string>(); // sessionId -> 最近一次 runId

  private keepMs: number;
  constructor(keepMs = KEEP_FINISHED_MS) {
    this.keepMs = keepMs;
  }

  // 同一会话同时只允许一个运行中的生成
  start(sessionId: string): Run | null {
    if (this.active(sessionId)?.status === "running") return null;
    const run = new Run(sessionId);
    this.runs.set(run.id, run);
    this.latest.set(sessionId, run.id);
    return run;
  }

  // 结束后延迟回收:期间仍可回放(切回会话 / 断线重连)
  finish(run: Run, status: Exclude<RunStatus, "running">): void {
    run.finish(status);
    const t = setTimeout(() => {
      this.runs.delete(run.id);
      if (this.latest.get(run.sessionId) === run.id) this.latest.delete(run.sessionId);
    }, this.keepMs);
    t.unref?.();
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  // 会话最近一次运行(运行中或刚结束、尚未回收)
  active(sessionId: string): Run | undefined {
    const id = this.latest.get(sessionId);
    return id ? this.runs.get(id) : undefined;
  }

  running(): Set<string> {
    const out = new Set<string>();
    for (const r of this.runs.values()) if (r.status === "running") out.add(r.sessionId);
    return out;
  }

  cancel(id: string): boolean {
    const r = this.runs.get(id);
    if (!r || r.status !== "running") return false;
    r.ac.abort();
    return true;
  }
}
