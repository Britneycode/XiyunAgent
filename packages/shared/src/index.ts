// ModelRole:main/subagent/vision/memory/embedding 为模型能力标签;
// coder/reviewer/tester/researcher/tutor 为子智能体角色绑定标签(阶段 3)。
export type ModelRole =
  | "main"
  | "subagent"
  | "vision"
  | "memory"
  | "embedding"
  | "coder"
  | "reviewer"
  | "tester"
  | "researcher"
  | "tutor";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextLength?: number;
  roles?: ModelRole[];
  // 能力标签(用户声明 + probe 验证):stream/tools/vision/json。空 = 未声明,按最低限度 stream 处理。
  capabilities?: string[];
}

export type ChatBlock =
  | { id: string; kind: "thinking"; text: string; durationMs?: number }
  | {
      id: string;
      kind: "tool";
      name: string;
      rawArgs: string; // 拼接后的原始参数字符串,始终保留
      args?: unknown; // rawArgs 解析成功时存在
      argsError?: string; // 解析失败原因
      status: "pending" | "success" | "error"; // 本轮只会出现 pending / error
      note?: string; // 例如 "已中断"
      target?: { workspace?: string; path?: string }; // 服务端填写
    }
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "ref"; refType: "message" | "doc" | "file"; label: string; excerpt: string }; // 仅 user 消息

export interface ChatMessage {
  // id 仅持久化消息有(数据库自增主键);流式中的临时气泡没有
  id?: number;
  role: "system" | "user" | "assistant";
  content: string;
  blocks?: ChatBlock[];
  aborted?: boolean;
}

export interface Fact {
  id: string;
  content: string;
  source: string;
  confidence: number;
  scope: string;
  validFrom: string;
  validTo: string | null;
  deletedAt: string | null;
}

// 阶段 2:候选记忆。提取流水线产出,用户确认后才成为事实。
export interface MemoryCandidate {
  id: string;
  content: string;
  reason: string;
  source: string;
  confidence: number;
  scope: string;
  sessionId: string | null;
  mode: string;
  workspace: string;
  action: "add" | "supersede";
  targetId: string | null;
  status: "pending" | "confirmed" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
}

export interface SessionMeta {
  id: string;
  title: string;
  mode: string;
  workspace: string;
  createdAt: string;
  archived?: boolean;
}

// ---- 阶段 6:Skill 与插件 ----

// Skill 是声明式目录:skill.json(manifest)+ SKILL.md(提示词正文)。
// modes/roles 为空 = 不限制;memoryScopes 声明可访问的记忆层级(预留给插件工具,当前仅校验与展示)。
export interface SkillManifest {
  id: string;
  name: string;
  version: number;
  description?: string;
  modes?: string[];
  roles?: string[];
  memoryScopes?: string[];
}

export interface SkillInfo extends Omit<SkillManifest, "modes" | "roles" | "memoryScopes"> {
  modes: string[];
  roles: string[];
  memoryScopes: string[];
  enabled: boolean;
  path: string;
  warnings: string[]; // 导入时静态检查发现的异常(如包含可执行文件)
  createdAt: string;
}

// ---- 阶段 5:Work 模式 ----
export interface WorkDoc {
  id: string;
  title: string;
  kind: "file" | "url" | "paste";
  source: string; // 文件相对路径或 URL
  content: string;
  workspace: string;
  sessionId: string | null;
  createdAt: string;
}

export interface Todo {
  id: string;
  title: string;
  status: "open" | "done";
  due: string | null;
  source: string; // 来源(文档 id / 会话 / 手动)
  workspace: string;
  sessionId: string | null;
  createdAt: string;
  doneAt: string | null;
}

// ---- 阶段 4:工具层 ----

export interface ShellInfo {
  id: string;
  name: string;
}

export interface ShellResult {
  shell: string;
  cwd: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

// 阶段 2:Git 提交范围。x/y 为 porcelain 的 XY 两列状态码;
// untracked 条目按 git 语义同时满足 unstaged=true,前端应优先看 untracked。
export interface GitStatusEntry {
  path: string;
  x: string;
  y: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

// cachedStat 非空 = 工作区已有用户手动暂存的内容,提交时会一并带入,需在确认前展示。
export interface GitPreview {
  files: GitStatusEntry[];
  diffStat: string;
  cachedStat: string;
}

// ---- 阶段 3:子智能体任务 ----

export type AgentRole = "coder" | "reviewer" | "tester" | "researcher" | "tutor" | "memory";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "waiting_for_user";

export type TaskSchedule = "run" | "parallel" | "pipeline";

// 子智能体结构化结果;模型输出无法解析时以 rawText 作为 summary 兜底。
// question 非空时任务进入 waiting_for_user,等待用户补充信息后续跑。
export interface TaskResult {
  status: "ok" | "partial" | "error";
  summary: string;
  artifacts: string[];
  changedFiles: string[];
  risks: string[];
  memoryCandidates: Array<{ content: string; reason?: string; confidence?: number }>;
  question?: string;
}

export interface SubagentTask {
  id: string;
  groupId: string;
  sessionId: string | null;
  role: AgentRole;
  title: string;
  prompt: string;
  schedule: TaskSchedule;
  status: TaskStatus;
  providerId: string | null; // 临时覆盖模型;空 = 按角色绑定
  model: string | null; // 实际执行所用模型(执行时记录)
  mode: string;
  workspace: string;
  dependsOn: string | null; // pipeline 中前一个任务 id
  result: TaskResult | null;
  error: string | null;
  question: string | null; // waiting_for_user 时向用户提出的问题
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}
