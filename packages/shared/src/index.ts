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

// 接口协议(M2 / D-021):openai = Chat Completions 兼容(含 Azure、各家网关);anthropic = Messages API;gemini = Gemini API
export type ProviderProtocol = "openai" | "anthropic" | "gemini";

// 同一个 Provider 下的一个可选模型;未填的上下文 / 能力沿用 Provider 级配置
export interface ModelInfo {
  id: string;
  contextLength?: number;
  capabilities?: string[];
}

export interface ModelParams {
  temperature?: number;
  maxTokens?: number; // 单次回复上限;anthropic 必填,缺省 8192
  reasoningEffort?: "low" | "medium" | "high"; // openai: reasoning_effort;anthropic / gemini 换算成思考预算
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol?: ProviderProtocol; // 缺省 openai(老配置)
  model: string; // 默认模型
  models?: ModelInfo[]; // 可选模型列表;默认模型不在其中时自动补到首位
  contextLength?: number;
  roles?: ModelRole[];
  // 能力标签(用户声明 + probe 验证):stream/tools/vision/json。空 = 未声明,按最低限度 stream 处理。
  capabilities?: string[];
  // 附加请求头 / 查询参数(如 Azure 的 api-key、api-version);值里的 {apiKey} 在请求时替换为 API Key
  headers?: Record<string, string>;
  query?: Record<string, string>;
  params?: ModelParams;
}

// Provider 的全部可选模型:默认模型在首位,继承 Provider 级上下文长度与能力
export function modelsOf(c: Pick<ProviderConfig, "model" | "models" | "contextLength" | "capabilities">): ModelInfo[] {
  const list: ModelInfo[] = [];
  const seen = new Set<string>();
  const push = (m: ModelInfo) => {
    const id = m.id.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    list.push({
      id,
      ...(m.contextLength ?? c.contextLength ? { contextLength: m.contextLength ?? c.contextLength } : {}),
      ...(m.capabilities?.length || c.capabilities?.length ? { capabilities: m.capabilities?.length ? m.capabilities : c.capabilities } : {}),
    });
  };
  // 默认模型若在列表里有单独的上下文 / 能力设置,以列表项为准
  if (c.model) push(c.models?.find((m) => m?.id === c.model) ?? { id: c.model });
  for (const m of c.models ?? []) if (m && typeof m.id === "string") push(m);
  return list;
}

// 指定模型后的配置副本;模型不在列表里时回退默认模型
export function withModel(c: ProviderConfig, model?: string | null): ProviderConfig {
  const all = modelsOf(c);
  const info = all.find((m) => m.id === model) ?? all[0];
  if (!info) return c;
  return { ...c, model: info.id, contextLength: info.contextLength, capabilities: info.capabilities };
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

// 模型返回的真实 token 用量(OpenAI 兼容 usage 字段归一化后的形态)。
// promptTokens 含系统提示、记忆、历史与引用上下文;completionTokens 含推理部分。
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number; // 输入中命中缓存的部分
  reasoningTokens?: number; // 输出中的推理部分(不会随历史带入下一轮)
}

export interface ChatMessage {
  // id 仅持久化消息有(数据库自增主键);流式中的临时气泡没有
  id?: number;
  role: "system" | "user" | "assistant";
  content: string;
  blocks?: ChatBlock[];
  aborted?: boolean;
  usage?: TokenUsage; // 仅 assistant;模型未返回 usage 时缺省
  error?: string; // 仅 assistant:生成出错时保留半截内容,附带错误信息
  model?: string; // 仅 assistant:生成这条回复的模型(M3)
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
  updatedAt?: string; // 最近活动时间(最后一条消息);老数据缺省时用 createdAt
  archived?: boolean;
  running?: boolean; // 服务端有运行中的生成(F1)
  // 会话级模型(M3):都为空 = 跟随全局默认;providerId 指向已删除的 Provider 时同样回退全局
  providerId?: string | null;
  model?: string | null;
}

// 消息全文搜索命中(M7);snippet 中命中词用 \u0001 / \u0002 包住,由前端转成高亮
export interface SearchHit {
  messageId: number;
  role: "user" | "assistant";
  snippet: string;
  createdAt: string;
  session: SessionMeta;
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
