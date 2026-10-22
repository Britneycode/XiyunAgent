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
      // pending:未开放工具时模型仍请求调用(不执行);awaiting:等待用户确认;running:执行中;
      // success / error:执行结束;rejected:被权限规则或用户拒绝(B1 / D-024)
      status: ToolStatus;
      note?: string; // 例如 "已中断"
      target?: { workspace?: string; path?: string }; // 服务端填写
      result?: string; // 工具执行结果(展示用,已截断)
      output?: string; // 仅流式中:bash 输出尾部,结束后以 result 为准
      exitCode?: number; // bash 退出码
      durationMs?: number;
      runId?: string; // 仅 awaiting:确认请求发往该运行(POST /runs/:id/confirm)
      rule?: string; // 仅 awaiting:"本项目始终允许"将写入的规则,如 Bash(npm run *)
      reason?: string; // 仅 awaiting:为什么需要确认
      checkpoint?: string; // 执行前的快照 sha(L1),可用于回退
    }
  | { id: string; kind: "text"; text: string }
  // 仅 user 消息;文件引用带工作区相对路径与引用时内容的指纹(F4:之后文件变更时提示模型内容可能过时)
  | { id: string; kind: "ref"; refType: "message" | "doc" | "file"; label: string; excerpt: string; path?: string; hash?: string }
  // 仅 user 消息:上传的附件(B2)。type = image 时作为图片发给支持视觉的模型,text 时正文并入引用上下文
  | { id: string; kind: "attachment"; attachmentId: string; name: string; mime: string; size: number; type: AttachmentKind };

export type ToolStatus = "pending" | "awaiting" | "running" | "success" | "error" | "rejected";

// 工具确认的三种答复:允许一次 / 本项目始终允许(写入允许规则)/ 拒绝
export type ToolDecision = "allow" | "always" | "deny";

// 模型发起的一次工具调用(请求用,不落库):args 为原始 JSON 字符串
export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export type AttachmentKind = "image" | "text";

// 附件元信息:id = 内容 sha256(同内容只存一份),文件在数据目录 attachments/ 下
export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
}

// 模型返回的真实 token 用量(OpenAI 兼容 usage 字段归一化后的形态)。
// promptTokens 含系统提示、记忆、历史与引用上下文;completionTokens 含推理部分。
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number; // 输入中命中缓存的部分
  reasoningTokens?: number; // 输出中的推理部分(不会随历史带入下一轮)
  // agent 多步(B1):上面各项为所有步骤之和(计费口径);steps = 模型调用次数,
  // contextTokens = 最后一步的输入 + 输出(上下文实际占用)
  steps?: number;
  contextTokens?: number;
}

export interface ChatMessage {
  // id 仅持久化消息有(数据库自增主键);流式中的临时气泡没有
  id?: number;
  // 本轮开始前的工作区快照(L1);只有 user 消息有,用于"回退到这里"
  checkpointSha?: string;
  // tool 仅出现在发给模型的请求里(agent 循环中的工具结果)
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  blocks?: ChatBlock[];
  aborted?: boolean;
  usage?: TokenUsage; // 仅 assistant;模型未返回 usage 时缺省
  error?: string; // 仅 assistant:生成出错时保留半截内容,附带错误信息
  model?: string; // 仅 assistant:生成这条回复的模型(M3)
  // F6 消息树:父消息 id(首条为 null);同一父消息下有多个版本(编辑 / 重新生成)时给出全部版本 id(升序,含自身)
  parentId?: number | null;
  siblings?: number[];
  // F4 仅 assistant:生成时因超出上下文预算未逐字带入的早先消息数,summary = 是否以摘要代替
  trim?: { dropped: number; summary: boolean };
  // 只在发给模型的请求里出现(不落库、不下发前端):user 消息附带的图片,base64
  images?: Array<{ mime: string; data: string }>;
  // 以下只在 agent 循环的请求里出现(B1):assistant 发起的工具调用、tool 结果对应的调用
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  toolError?: boolean; // tool 结果是否为错误(anthropic is_error)
  // 协议原样回传的 assistant 内容(anthropic 的 thinking 签名、gemini 的 thoughtSignature 等),协议不符时忽略
  raw?: { protocol: ProviderProtocol; content: unknown };
}

// Token 估算(前后端共用):CJK 字符约 1 token/字,其余字符约 4 字符/token。
// 只用于预算与展示,模型返回的实测用量优先。
const CJK = /[\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/g;
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
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
  // L2:出处回链。sourceMessageId 指向产生这条记忆的原消息
  sourceMessageId?: number;
  sourceKind?: string; // import:chatgpt / import:claude / extract:<sessionId>
  sourceSessionId?: string; // 产生这条记忆的会话(定位「查看出处」)
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
  // L2:出处(确认成事实时传给 Fact)
  sourceMessageId?: number;
  sourceKind?: string;
  sourceSessionId?: string;
}

// L2:批量记忆提取作业(导入历史后初始化记忆)
export type MemoryJobStatus = "queued" | "running" | "paused" | "done" | "cancelled";

export interface MemoryJob {
  id: string;
  source: string;
  status: MemoryJobStatus;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryJobItem {
  sessionId: string;
  status: string;
  factsAdded: number;
  error: string | null;
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
