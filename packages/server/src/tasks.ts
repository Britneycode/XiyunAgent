import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentRole, ChatMessage, SubagentTask, TaskResult, TaskSchedule, TaskStatus,
} from "@xiyun/shared";
import type { ChatProvider, ModelRegistry } from "@xiyun/runtime";
import type { MemoryStore } from "./memory.ts";
import { ROLE_TOOLS, runTool } from "./tools.ts";

const now = () => new Date().toISOString();

// 每个任务组最多 3 个子智能体(验收约束)。
export const MAX_GROUP_TASKS = 3;

// 只读角色可并行;写角色(coder/tester)对同一工作区必须串行,避免互相覆盖。
const READONLY_ROLES: ReadonlySet<AgentRole> = new Set(["reviewer", "researcher", "tutor", "memory"]);

const ROLE_PRESETS: Record<AgentRole, string> = {
  researcher: "你是资料检索子智能体。围绕任务主题整理要点、出处和不确定项,只读不改文件。",
  tutor: "你是讲解子智能体。把任务主题拆成可理解的步骤,给出例子和易错点,只读不改文件。",
  coder: "你是编码子智能体。根据任务描述给出实现方案与代码变更说明。",
  reviewer: "你是代码审查子智能体。找出任务输入中的缺陷、风险与改进建议,只读不改文件。",
  tester: "你是测试子智能体。为任务描述的功能设计测试用例与验证步骤。",
  memory: "你是记忆整理子智能体。归纳任务上下文中的稳定事实。",
};

const RESULT_INSTRUCTION = `完成后,在回复末尾输出一个 \`\`\`json 代码块,结构如下:
{"status":"ok|partial|error","summary":"结果摘要","artifacts":[],"changedFiles":[],"risks":[],"memoryCandidates":[{"content":"值得长期记住的事实","reason":"原因","confidence":0.0}]}
memoryCandidates 只写确有价值、跨会话稳定的事实;没有就留空数组。
若缺少完成任务所必需的信息,把 status 设为 "partial" 并加 "question":"需要用户补充的问题",任务会暂停等待用户回答。`;

// 阶段 4:code 模式子智能体的工具调用协议(无 function calling 依赖,JSON 块约定)。
const MAX_TOOL_CALLS = 5;

const TOOL_INSTRUCTION = `你可以调用工具完成工作。每次只调用一个,格式:
\`\`\`tool
{"tool":"<工具名>","args":{...}}
\`\`\`
工具结果会以用户消息返回,可继续调用下一个工具;全部完成后输出最终回复和 \`\`\`json 结果块。
- files.list {"path":"相对目录,默认 ."} 列出工作区文件
- files.read {"path":"相对路径"} 读取工作区文件
- files.write {"path":"相对路径","content":"完整内容"} 写文件(仅 coder)
- shell.exec {"command":"只读命令"} 执行命令(需要确认的命令会被拒绝)
- git.status / git.diff 查看仓库状态与未提交改动
工作区外的路径和危险命令会被直接拒绝。`;

function parseToolCall(text: string): { tool: string; args: Record<string, unknown> } | null {
  const m = text.match(/```tool\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]) as { tool?: unknown; args?: unknown };
    if (typeof o.tool !== "string" || !o.tool) return null;
    return { tool: o.tool, args: typeof o.args === "object" && o.args !== null ? (o.args as Record<string, unknown>) : {} };
  } catch {
    return null;
  }
}

function parseResult(raw: string): TaskResult {
  const m = raw.match(/```json\s*([\s\S]*?)```/);
  if (m) {
    try {
      const p = JSON.parse(m[1]) as Partial<TaskResult>;
      return {
        status: p.status === "partial" || p.status === "error" ? p.status : "ok",
        summary: typeof p.summary === "string" ? p.summary : raw.slice(0, 500),
        artifacts: Array.isArray(p.artifacts) ? p.artifacts.map(String) : [],
        changedFiles: Array.isArray(p.changedFiles) ? p.changedFiles.map(String) : [],
        risks: Array.isArray(p.risks) ? p.risks.map(String) : [],
        memoryCandidates: Array.isArray(p.memoryCandidates)
          ? p.memoryCandidates.filter((c) => c && typeof c.content === "string").map((c) => ({
              content: String(c.content),
              reason: typeof c.reason === "string" ? c.reason : undefined,
              confidence: typeof c.confidence === "number" ? c.confidence : undefined,
            }))
          : [],
        question: typeof p.question === "string" && p.question.trim() ? p.question.trim() : undefined,
      };
    } catch {
      // fallthrough:无法解析时按纯文本兜底
    }
  }
  return { status: "ok", summary: raw.trim().slice(0, 2000), artifacts: [], changedFiles: [], risks: [], memoryCandidates: [] };
}

interface TaskRow {
  id: string; group_id: string; session_id: string | null; role: string; title: string;
  prompt: string; schedule: string; status: string; provider_id: string | null; model: string | null;
  mode: string; workspace: string; depends_on: string | null; result: string | null; error: string | null;
  question: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; duration_ms: number | null;
}

function toTask(r: TaskRow): SubagentTask {
  return {
    id: r.id, groupId: r.group_id, sessionId: r.session_id, role: r.role as AgentRole,
    title: r.title, prompt: r.prompt, schedule: r.schedule as TaskSchedule, status: r.status as TaskStatus,
    providerId: r.provider_id, model: r.model, mode: r.mode, workspace: r.workspace,
    dependsOn: r.depends_on, result: r.result ? (JSON.parse(r.result) as TaskResult) : null,
    error: r.error, question: r.question ?? null, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    durationMs: r.duration_ms,
  };
}

export class TaskStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(t: {
    role: AgentRole; prompt: string; title?: string; schedule?: TaskSchedule;
    groupId?: string; sessionId?: string; providerId?: string; mode?: string;
    workspace?: string; dependsOn?: string;
  }): SubagentTask {
    const task: SubagentTask = {
      id: randomUUID(), groupId: t.groupId ?? randomUUID(), sessionId: t.sessionId ?? null,
      role: t.role, title: t.title ?? t.prompt.slice(0, 40), prompt: t.prompt,
      schedule: t.schedule ?? "run", status: "queued", providerId: t.providerId ?? null,
      model: null, mode: t.mode ?? "chat", workspace: t.workspace ?? "", dependsOn: t.dependsOn ?? null,
      result: null, error: null, question: null, createdAt: now(), startedAt: null, finishedAt: null, durationMs: null,
    };
    this.db.prepare(
      `INSERT INTO tasks (id, group_id, session_id, role, title, prompt, schedule, status, provider_id, model, mode, workspace, depends_on, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, ?, ?, ?)`,
    ).run(
      task.id, task.groupId, task.sessionId, task.role, task.title, task.prompt,
      task.schedule, task.providerId, task.mode, task.workspace, task.dependsOn, task.createdAt,
    );
    return task;
  }

  get(id: string): SubagentTask | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return r ? toTask(r) : undefined;
  }

  list(filter: { sessionId?: string; status?: TaskStatus; groupId?: string } = {}): SubagentTask[] {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const args: string[] = [];
    if (filter.sessionId) { sql += " AND session_id = ?"; args.push(filter.sessionId); }
    if (filter.status) { sql += " AND status = ?"; args.push(filter.status); }
    if (filter.groupId) { sql += " AND group_id = ?"; args.push(filter.groupId); }
    return ((this.db.prepare(`${sql} ORDER BY created_at DESC`).all(...args) as unknown) as TaskRow[]).map(toTask);
  }

  setStatus(id: string, status: TaskStatus, extra: { model?: string; error?: string; result?: TaskResult; question?: string | null } = {}): void {
    const t = this.get(id);
    if (!t) return;
    const startedAt = status === "running" ? now() : t.startedAt;
    const finished = ["completed", "failed", "cancelled"].includes(status);
    const finishedAt = finished ? now() : t.finishedAt;
    const durationMs =
      finished && startedAt ? Date.parse(finishedAt!) - Date.parse(startedAt) : t.durationMs;
    const question = extra.question !== undefined ? extra.question : status === "queued" || status === "running" ? null : t.question;
    this.db.prepare(
      "UPDATE tasks SET status = ?, model = COALESCE(?, model), error = ?, result = ?, question = ?, started_at = ?, finished_at = ?, duration_ms = ? WHERE id = ?",
    ).run(
      status, extra.model ?? null, extra.error ?? null,
      extra.result ? JSON.stringify(extra.result) : t.result ? JSON.stringify(t.result) : null,
      question, startedAt, finishedAt, durationMs, id,
    );
  }

  // Server 重启恢复:queued/running 的任务重置为 queued,由 Scheduler 重新拉起。
  recoverInterrupted(): number {
    const r = this.db.prepare("UPDATE tasks SET status = 'queued' WHERE status IN ('queued', 'running')").run();
    return Number(r.changes);
  }
}

export interface SchedulerDeps {
  store: TaskStore;
  memory: MemoryStore;
  registry: () => ModelRegistry; // 每次执行时取最新注册表(配置可能已改)
  onEvent?: (type: string, payload: unknown) => void;
  skillsFor?: (mode: string, role: string) => string; // 阶段 6:启用 Skill 注入
}

export class Scheduler {
  private controllers = new Map<string, AbortController>();
  private runningByWorkspace = new Map<string, Promise<void>>();
  private deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  // 授权回退链:临时覆盖只用指定 provider;按角色解析时返回全部绑定该角色的模型,
  // 只允许在同角色绑定模型间回退,绝不落到未授权模型。
  private resolveChain(task: SubagentTask): { chain: ChatProvider[]; error?: string } {
    const reg = this.deps.registry();
    if (task.providerId) {
      const p = reg.get(task.providerId);
      return p ? { chain: [p] } : { chain: [], error: `覆盖模型 ${task.providerId} 不存在` };
    }
    const chain = reg.byRoleAll(task.role);
    return chain.length > 0 ? { chain } : { chain: [], error: `角色 ${task.role} 未绑定模型,且不允许自动回退` };
  }

  // 工具循环:模型输出 ```tool 块则执行并把结果喂回,最多 MAX_TOOL_CALLS 轮。
  // 子智能体没有确认通道,需要确认/危险命令会被工具层拒绝并以错误文本返回给模型。
  private async converse(
    provider: ChatProvider,
    messages: ChatMessage[],
    signal: AbortSignal,
    tools: string[],
    workspace: string,
  ): Promise<string> {
    for (let i = 0; ; i++) {
      let full = "";
      for await (const delta of provider.streamChat(messages, { signal })) full += delta;
      const call = i < MAX_TOOL_CALLS && tools.length > 0 ? parseToolCall(full) : null;
      if (!call || !tools.includes(call.tool)) return full;
      let out: string;
      try {
        out = await runTool(call.tool, call.args, { workspace });
      } catch (e) {
        out = `工具调用失败:${e instanceof Error ? e.message : String(e)}`;
      }
      this.deps.onEvent?.("task.tool", { tool: call.tool, workspace });
      messages.push({ role: "assistant", content: full });
      messages.push({ role: "user", content: `[工具 ${call.tool} 结果]\n${out.slice(0, 8000)}` });
    }
  }

  private async execute(taskId: string, priorSummary?: string, extraContext?: string): Promise<void> {
    const { store, memory } = this.deps;
    const task = store.get(taskId);
    if (!task || task.status === "cancelled") return;

    const { chain, error } = this.resolveChain(task);
    if (chain.length === 0) {
      store.setStatus(taskId, "failed", { error });
      this.deps.onEvent?.("task.failed", { taskId, error });
      return;
    }

    // 子智能体只读筛选后的模式/工作区记忆,不能直接写长期记忆。
    const memories = memory
      .search(task.prompt, 5, [task.mode, task.workspace])
      .map((f) => `- ${f.content}`);
    // code 模式且角色有工具时,注入工具协议(阶段 4)。
    const roleTools = task.mode === "code" ? (ROLE_TOOLS[task.role] ?? []) : [];
    const skillsText = this.deps.skillsFor?.(task.mode, task.role) ?? "";
    const system = [
      ROLE_PRESETS[task.role],
      skillsText && `# 已启用 Skill\n${skillsText}`,
      task.mode === "code" && `工作区:${task.workspace}(所有文件路径相对于该目录)`,
      roleTools.length > 0 && TOOL_INSTRUCTION,
      memories.length && `# 相关记忆\n${memories.join("\n")}`,
      priorSummary && `# 上游任务结果摘要\n${priorSummary}`,
      extraContext && `# 用户补充\n${extraContext}`,
      RESULT_INSTRUCTION,
    ].filter(Boolean).join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: task.prompt },
    ];

    let lastError: string | null = null;
    for (const provider of chain) {
      const controller = new AbortController();
      this.controllers.set(taskId, controller);
      store.setStatus(taskId, "running", { model: provider.config.model });
      try {
        const full = await this.converse(provider, messages, controller.signal, roleTools, task.workspace);
        const result = parseResult(full);
        // 子智能体的记忆产出只进候选区,等待用户确认。
        for (const c of result.memoryCandidates) {
          memory.addCandidate({
            content: c.content, reason: c.reason ?? `${task.role} 子任务产出`, confidence: c.confidence ?? 0.4,
            source: `task:${task.id}`, scope: task.mode, sessionId: task.sessionId ?? undefined,
            mode: task.mode, workspace: task.workspace,
          });
        }
        if (result.question) {
          store.setStatus(taskId, "waiting_for_user", { result, question: result.question });
          this.deps.onEvent?.("task.waiting", { taskId, question: result.question });
        } else {
          store.setStatus(taskId, "completed", { result });
          this.deps.onEvent?.("task.completed", { taskId, status: result.status });
        }
        return;
      } catch (e) {
        if (controller.signal.aborted) return; // cancel 已写状态
        lastError = e instanceof Error ? e.message : String(e);
        this.deps.onEvent?.("task.provider_failed", { taskId, model: provider.config.model, error: lastError });
        // 链内还有已授权模型则继续回退
      } finally {
        this.controllers.delete(taskId);
      }
    }
    store.setStatus(taskId, "failed", { error: lastError ?? "无可用模型" });
    this.deps.onEvent?.("task.failed", { taskId, error: lastError });
  }

  // 单个任务
  run(taskId: string): void {
    void this.execute(taskId);
  }

  // 并行组:只读角色并行;写角色(coder/tester)同工作区串行接入既有链。
  parallel(taskIds: string[]): void {
    for (const id of taskIds) {
      const task = this.deps.store.get(id);
      if (!task) continue;
      if (READONLY_ROLES.has(task.role)) {
        void this.execute(id);
      } else {
        const prev = this.runningByWorkspace.get(task.workspace) ?? Promise.resolve();
        const next = prev.then(() => this.execute(id));
        this.runningByWorkspace.set(task.workspace, next.catch(() => {}));
        void next;
      }
    }
  }

  // 流水线:按 dependsOn 链串行,前一个任务的结果摘要注入后一个任务。
  async pipeline(taskIds: string[]): Promise<void> {
    let priorSummary: string | undefined;
    for (const id of taskIds) {
      const task = this.deps.store.get(id);
      if (!task || task.status === "cancelled") continue;
      await this.execute(id, priorSummary);
      const done = this.deps.store.get(id);
      if (done?.status === "failed") break; // 上游失败即终止流水线
      if (done?.status === "waiting_for_user") break; // 上游等待用户回答,暂停流水线
      priorSummary = done?.result?.summary;
    }
  }

  dispatch(taskIds: string[]): void {
    const first = taskIds.length > 0 ? this.deps.store.get(taskIds[0]) : undefined;
    const schedule = first?.schedule ?? "run";
    if (schedule === "pipeline") void this.pipeline(taskIds);
    else if (schedule === "parallel") this.parallel(taskIds);
    else for (const id of taskIds) this.run(id);
  }

  cancel(taskId: string): boolean {
    const task = this.deps.store.get(taskId);
    if (!task) return false;
    if (task.status === "queued") {
      this.deps.store.setStatus(taskId, "cancelled");
      return true;
    }
    const c = this.controllers.get(taskId);
    if (c) {
      c.abort();
      this.controllers.delete(taskId);
      this.deps.store.setStatus(taskId, "cancelled");
      return true;
    }
    return false;
  }

  retry(taskId: string): boolean {
    const task = this.deps.store.get(taskId);
    if (!task || task.status === "running") return false;
    this.deps.store.setStatus(taskId, "queued");
    this.run(taskId);
    return true;
  }

  // waiting_for_user 任务:用户回答后把补充信息注入上下文,重新执行;组内后续任务重新调度。
  resume(taskId: string, answer: string): boolean {
    const task = this.deps.store.get(taskId);
    if (!task || task.status !== "waiting_for_user") return false;
    this.deps.store.setStatus(taskId, "queued", { question: null });
    const extra = `问题:${task.question ?? ""}\n回答:${answer}`;
    if (task.schedule === "pipeline") {
      // 恢复的任务保留自己上游的摘要;自己完成后继续跑下游 queued 任务
      const prior = task.dependsOn ? this.deps.store.get(task.dependsOn)?.result?.summary : undefined;
      const downstream = this.deps.store
        .list({ groupId: task.groupId })
        .filter((t) => t.status === "queued" && t.id !== taskId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((t) => t.id);
      void this.execute(taskId, prior, extra).then(() => {
        if (downstream.length > 0) void this.pipeline(downstream);
      });
    } else {
      void this.execute(taskId, undefined, extra);
    }
    return true;
  }

  // Server 启动时恢复未完成任务。
  recover(): number {
    const n = this.deps.store.recoverInterrupted();
    if (n > 0) {
      for (const t of this.deps.store.list({ status: "queued" })) this.run(t.id);
    }
    return n;
  }
}
