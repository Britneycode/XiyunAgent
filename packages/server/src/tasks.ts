import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { pricingOf } from "@xiyun/shared";
import type {
  AgentRole, ChatMessage, ModelPricing, SubagentTask, TaskResult, TaskSchedule, TaskStatus, TokenUsage,
} from "@xiyun/shared";
import type { ChatProvider, ModelRegistry } from "@xiyun/runtime";
import type { MemoryStore } from "./memory.ts";
import { ALL_TOOLS, BlockBuilder, runAgent, toolsForMode, type AgentTool } from "./agent.ts";
import {
  commitAll, createWorktree, diffStat, hasChanges, isGitRepo, removeWorktree, type WorktreeInfo,
} from "./worktree.ts";

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

// B1:子智能体走原生工具调用(runAgent),不再用 ```tool 文本协议。
// 各角色可用工具:写角色有全部工具,只读角色去掉写类,辅导/记忆角色不给工具
const ROLE_TOOL_NAMES: Record<string, string[] | "all"> = {
  coder: "all",
  tester: ["read_file", "list_files", "grep", "bash", "git_status", "git_diff"],
  reviewer: ["read_file", "list_files", "grep", "bash", "git_status", "git_diff"],
  researcher: ["read_file", "list_files", "grep", "bash", "git_status", "git_diff"],
  tutor: [],
  memory: [],
};

const SUBTASK_MAX_STEPS = 12;

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
  worktree: string | null; branch: string | null; base_sha: string | null;
  steps: number | null; usage: string | null; diff_stat: string | null;
}

function toTask(r: TaskRow): SubagentTask {
  return {
    id: r.id, groupId: r.group_id, sessionId: r.session_id, role: r.role as AgentRole,
    title: r.title, prompt: r.prompt, schedule: r.schedule as TaskSchedule, status: r.status as TaskStatus,
    providerId: r.provider_id, model: r.model, mode: r.mode, workspace: r.workspace,
    dependsOn: r.depends_on, result: r.result ? (JSON.parse(r.result) as TaskResult) : null,
    error: r.error, question: r.question ?? null, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    worktree: r.worktree ?? null, branch: r.branch ?? null, baseSha: r.base_sha ?? null,
    steps: r.steps ?? null, usage: r.usage ? (JSON.parse(r.usage) as TokenUsage) : null,
    diffStat: r.diff_stat ?? null,
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

  // L4:补写隔离工作区与运行指标(只写传入的字段)
  patch(id: string, p: {
    worktree?: string | null; branch?: string | null; baseSha?: string | null;
    steps?: number | null; usage?: TokenUsage | null; diffStat?: string | null;
  }): void {
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    const put = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (p.worktree !== undefined) put("worktree", p.worktree);
    if (p.branch !== undefined) put("branch", p.branch);
    if (p.baseSha !== undefined) put("base_sha", p.baseSha);
    if (p.steps !== undefined) put("steps", p.steps);
    if (p.usage !== undefined) put("usage", p.usage ? JSON.stringify(p.usage) : null);
    if (p.diffStat !== undefined) put("diff_stat", p.diffStat);
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  // Server 重启恢复:queued/running 的任务重置为 queued,由 Scheduler 重新拉起。
  recoverInterrupted(): number {
    const r = this.db.prepare("UPDATE tasks SET status = 'queued' WHERE status IN ('queued', 'running')").run();
    return Number(r.changes);
  }
}

// L4:任务事件总线。前端订阅单个任务的实时进度(每步工具、状态变化、隔离分支就绪)。
export interface TaskEvent {
  id: number; // events 表自增 id(前端据此去重)
  type: string;
  payload: unknown;
  createdAt: string;
}

export class TaskEventBus {
  private listeners = new Map<string, Set<(e: TaskEvent) => void>>();

  // 发布任务事件
  publish(taskId: string, e: TaskEvent): void {
    const set = this.listeners.get(taskId);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(e);
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }
  }

  // 订阅某个任务的事件;返回取消订阅函数
  subscribe(taskId: string, fn: (e: TaskEvent) => void): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(taskId);
    };
  }
}

export interface SchedulerDeps {
  store: TaskStore;
  memory: MemoryStore;
  registry: () => ModelRegistry; // 每次执行时取最新注册表(配置可能已改)
  onEvent?: (type: string, payload: unknown) => void;
  skillsFor?: (mode: string, role: string, query?: string) => string; // 阶段 6:启用 Skill 注入;query 用于渐进注入选相关 Skill
  // L5:子任务用量记入成本账本(按 provider 配置里的价格计算)
  usage?: (entry: {
    sessionId?: string | null; taskId?: string | null; providerId?: string | null;
    model?: string | null; usage: TokenUsage | null; pricing?: ModelPricing;
  }) => void;
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

  // 子智能体走 runAgent:无确认通道,写操作由 policy 钩子按角色决定。
  // coder 的写操作直接放行(等价于原来的 files.write);其余角色的 bash 需要确认时一律拒绝。
  private async converse(
    provider: ChatProvider,
    messages: ChatMessage[],
    signal: AbortSignal,
    tools: AgentTool[],
    workspace: string,
    taskId: string,
  ): Promise<{ text: string; usage: TokenUsage | null; steps: number }> {
    if (!tools.length) {
      let full = "";
      for await (const delta of provider.streamChat(messages, { signal })) full += delta;
      return { text: full, usage: null, steps: 1 };
    }
    if (!provider.streamEvents) {
      // Provider 不支持原生工具调用时退回纯文本
      let full = "";
      for await (const delta of provider.streamChat(messages, { signal })) full += delta;
      return { text: full, usage: null, steps: 1 };
    }
    const builder = new BlockBuilder(() => {});
    const result = await runAgent({
      provider,
      messages,
      tools,
      workspace,
      signal,
      builder,
      maxSteps: SUBTASK_MAX_STEPS,
      policy: (req) => {
        // coder 的 Edit / Write 放行;bash 与只读角色的写操作一律拒绝
        if (req.name === "edit_file" || req.name === "write_file") return "allow";
        return "deny";
      },
      onToolEnd: (info) =>
        this.deps.onEvent?.("task.tool", { taskId, tool: info.name, workspace, status: info.status }),
    });
    return { text: result.finalText, usage: result.usage, steps: result.steps };
  }

  // L4:能否给这个任务开隔离 worktree。
  // 只对「并行组 + code 模式 + 写角色 + 工作区是 git 仓库」生效:
  // 这类任务原本要在同一工作区串行,隔离后可以真正并发,各改各的文件。
  private async canIsolate(task: SubagentTask): Promise<boolean> {
    if (task.schedule !== "parallel") return false;
    if (task.mode !== "code") return false;
    if (READONLY_ROLES.has(task.role)) return false;
    if (!task.workspace) return false;
    return isGitRepo(task.workspace);
  }

  // 复用任务已有的 worktree(waiting_for_user 恢复时继续用同一个),否则新建
  private async prepareWorktree(task: SubagentTask): Promise<WorktreeInfo> {
    if (task.worktree && task.branch && task.baseSha && existsSync(task.worktree))
      return { path: task.worktree, branch: task.branch, baseSha: task.baseSha, root: task.workspace };
    return createWorktree(task.workspace, task.id);
  }

  // L4:任务收尾。有改动就把改动提交到隔离分支并记下变更统计(等用户确认后再合并 / 推送);
  // 失败、取消或没有改动时把 worktree 与分支一并清理掉。
  private async finalizeWorktree(
    taskId: string,
    outcome: "ok" | "failed" | "waiting" | "cancelled",
    wt: WorktreeInfo | null,
  ): Promise<void> {
    if (!wt) return;
    const store = this.deps.store;
    const task = store.get(taskId);
    try {
      if (outcome === "ok") {
        if (await hasChanges(wt.path)) {
          await commitAll(wt.path, `子任务 ${task?.role ?? ""}:${task?.title ?? taskId}`);
          const stat = await diffStat(wt.root, wt.baseSha, wt.branch);
          store.patch(taskId, { diffStat: stat });
          this.deps.onEvent?.("task.changed", { taskId, branch: wt.branch, diffStat: stat });
          return;
        }
      }
      if (outcome !== "waiting") {
        await removeWorktree(wt.root, wt.path, wt.branch);
        store.patch(taskId, { worktree: null, branch: null, diffStat: null });
      }
    } catch (e) {
      // 清理失败不改变任务结果,只记事件
      this.deps.onEvent?.("task.worktree_cleanup_failed", {
        taskId, error: e instanceof Error ? e.message : String(e),
      });
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

    // L4:能隔离的任务先开 worktree,子智能体在隔离目录里改文件,改动落在分支上,不碰用户工作区
    let wt: WorktreeInfo | null = null;
    if (await this.canIsolate(task)) {
      try {
        wt = await this.prepareWorktree(task);
        store.patch(taskId, { worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha });
        this.deps.onEvent?.("task.worktree", { taskId, branch: wt.branch, worktree: wt.path });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        store.setStatus(taskId, "failed", { error: `创建隔离工作区失败:${msg}` });
        this.deps.onEvent?.("task.failed", { taskId, error: msg });
        return;
      }
    }
    const agentWorkspace = wt?.path ?? task.workspace;

    // 子智能体只读筛选后的模式/工作区记忆,不能直接写长期记忆。
    const memories = memory
      .search(task.prompt, 5, [task.mode, task.workspace])
      .map((f) => `- ${f.content}`);
    // code 模式且角色有工具时下发工具定义
    const wanted = task.mode === "code" ? (ROLE_TOOL_NAMES[task.role] ?? []) : [];
    const roleTools =
      wanted === "all" ? toolsForMode("code") : ALL_TOOLS.filter((t) => wanted.includes(t.def.name));
    const skillsText = this.deps.skillsFor?.(task.mode, task.role, task.prompt) ?? "";
    const system = [
      ROLE_PRESETS[task.role],
      skillsText && `# 已启用 Skill\n${skillsText}`,
      task.mode === "code" && `工作区:${agentWorkspace}(所有文件路径相对于该目录)`,
      roleTools.length > 0 &&
        "你可以使用工具读取代码、执行命令和修改文件;完成后输出最终回复和 ```json 结果块。写操作以外的命令可能需要确认,无法确认时会返回拒绝。",
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
    let outcome: "ok" | "failed" | "waiting" | "cancelled" = "failed";
    // 终态状态在收尾之后才写:隔离任务要先完成自动提交与变更统计,
    // 否则外部看到「已完成」时分支上还没有改动,合并会变成空合并。
    let finalResult: TaskResult | null = null;
    let finalQuestion: string | null = null;
    for (const provider of chain) {
      const controller = new AbortController();
      this.controllers.set(taskId, controller);
      store.setStatus(taskId, "running", { model: provider.config.model });
      try {
        const conv = await this.converse(
          provider, messages, controller.signal, roleTools, agentWorkspace, taskId,
        );
        store.patch(taskId, { steps: conv.steps, usage: conv.usage });
        this.deps.usage?.({
          sessionId: task.sessionId, taskId, providerId: provider.config.id,
          model: provider.config.model, usage: conv.usage, pricing: pricingOf(provider.config),
        });
        const result = parseResult(conv.text);
        // 子智能体的记忆产出只进候选区,等待用户确认。
        for (const c of result.memoryCandidates) {
          memory.addCandidate({
            content: c.content, reason: c.reason ?? `${task.role} 子任务产出`, confidence: c.confidence ?? 0.4,
            source: `task:${task.id}`, scope: task.mode, sessionId: task.sessionId ?? undefined,
            mode: task.mode, workspace: task.workspace,
          });
        }
        if (result.question) {
          finalResult = result;
          finalQuestion = result.question;
          outcome = "waiting";
        } else {
          finalResult = result;
          outcome = "ok";
        }
        break;
      } catch (e) {
        if (controller.signal.aborted) {
          outcome = "cancelled"; // cancel 已写状态
          break;
        }
        lastError = e instanceof Error ? e.message : String(e);
        this.deps.onEvent?.("task.provider_failed", { taskId, model: provider.config.model, error: lastError });
        // 链内还有已授权模型则继续回退
      } finally {
        this.controllers.delete(taskId);
      }
    }

    await this.finalizeWorktree(taskId, outcome, wt);

    if (outcome === "ok") {
      store.setStatus(taskId, "completed", { result: finalResult ?? undefined });
      this.deps.onEvent?.("task.completed", { taskId, status: finalResult?.status });
    } else if (outcome === "waiting") {
      store.setStatus(taskId, "waiting_for_user", {
        result: finalResult ?? undefined,
        question: finalQuestion,
      });
      this.deps.onEvent?.("task.waiting", { taskId, question: finalQuestion });
    }
    if (outcome === "failed") {
      store.setStatus(taskId, "failed", { error: lastError ?? "无可用模型" });
      this.deps.onEvent?.("task.failed", { taskId, error: lastError });
    }
  }

  // 单个任务
  run(taskId: string): void {
    void this.execute(taskId);
  }

  // 并行组:只读角色并行;写角色(coder/tester)同工作区串行接入既有链。
  // L4:能开隔离 worktree 的写任务改在各自 worktree 里跑,互不干扰,可真正并发。
  parallel(taskIds: string[]): void {
    void this.runParallel(taskIds);
  }

  private async runParallel(taskIds: string[]): Promise<void> {
    const tasks = taskIds
      .map((id) => this.deps.store.get(id))
      .filter((t): t is SubagentTask => !!t);
    // 先算清哪些任务能开隔离 worktree(要跑 git 命令),再决定并发策略
    const isolated = await Promise.all(tasks.map((t) => this.canIsolate(t)));
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      if (isolated[i]) {
        void this.execute(task.id); // 各自 worktree,互不干扰,直接并发
      } else if (READONLY_ROLES.has(task.role)) {
        void this.execute(task.id);
      } else {
        const prev = this.runningByWorkspace.get(task.workspace) ?? Promise.resolve();
        const next = prev.then(() => this.execute(task.id));
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
