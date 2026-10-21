import type { AgentRole, AttachmentMeta, ChatBlock, ChatMessage, Fact, GitPreview, MemoryCandidate, ProviderConfig, SearchHit, SessionMeta, ShellInfo, ShellResult, SkillInfo, SubagentTask, TaskSchedule, TaskStatus, Todo, TokenUsage, WorkDoc } from "@xiyun/shared";

// /chat SSE 事件:typed 块事件 + 旧版 plain delta/error/done
export type StreamEvent =
  | { type: "block"; id: string; block: { kind: "text" | "thinking" } | { kind: "tool"; name: string; status: string } }
  | { type: "block_delta"; id: string; delta: string }
  | { type: "block_end"; id: string; block: ChatBlock }
  | { type: "usage"; usage: TokenUsage } // 模型返回的真实用量,至多一次,在 done 之前
  // 首个事件:本轮 user 消息的落库 id、后台运行 id、所用模型;trim = 历史超出上下文预算时的裁剪情况(F4)
  | { type: "meta"; userMessageId: number | null; runId?: string; model?: string | null; trim?: { dropped: number; summary: boolean } }
  | { type: "cancelled"; messageId: number | null; userMessageId: number | null } // 被停止:半截已落库(无内容时 messageId 为 null)
  | { type: "title"; title: string } // 新会话自动命名完成(模型起的标题)
  | { delta: string; id?: string }
  // 出错时 server 已落库的半截 assistant 带 messageId(未落库为 null)
  | { error: string; messageId?: number | null; userMessageId?: number | null }
  | { done: true; messageId?: number | null; userMessageId?: number | null };

export interface RefPayload {
  refType: "message" | "doc" | "file";
  label: string;
  excerpt: string;
  path?: string; // 文件引用的工作区相对路径
}

// 打包态 Electron 用 loadFile 加载 file:// 页面,没有 vite proxy,/api 会被当文件路径。
// file: 协议时直连 Server 127.0.0.1:3777(CORS 白名单已含 null origin,无 Origin 头放行)。
// dev 下保持 /api 走 vite proxy 到同一端口。
const base = location.protocol === "file:" ? "http://127.0.0.1:3777" : "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  sessions: (archived?: 0 | 1 | "all", limit?: number, offset?: number) => {
    const p = new URLSearchParams();
    if (archived !== undefined) p.set("archived", String(archived));
    if (limit !== undefined) p.set("limit", String(limit));
    if (offset !== undefined) p.set("offset", String(offset));
    const q = p.size ? `?${p}` : "";
    // 有 limit 时 server 返回 { list, total, hasMore },否则返回数组
    return req<SessionMeta[] | { list: SessionMeta[]; total: number; hasMore: boolean }>(`/sessions${q}`);
  },
  // 附件(B2):multipart 上传,不能带 JSON Content-Type
  uploadAttachment: async (file: File): Promise<AttachmentMeta> => {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch(`${base}/attachments`, { method: "POST", body: form });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `上传失败(${res.status})`);
    }
    return res.json() as Promise<AttachmentMeta>;
  },
  // 从 ChatGPT / Claude 导入(M1):body 为 conversations.json 原文
  externalPreview: (raw: string) =>
    req<ExternalPreview>("/admin/import/external/preview", { method: "POST", body: raw }),
  externalImport: (raw: string) =>
    req<{ ok: boolean; source: string; added: { sessions: number; messages: number }; skipped: { duplicate: number; empty: number } }>(
      "/admin/import/external", { method: "POST", body: raw },
    ),
  createSession: (body?: Partial<SessionMeta>) => req<SessionMeta>("/sessions", { method: "POST", body: JSON.stringify(body ?? {}) }),
  deleteSession: (id: string) => req(`/sessions/${id}`, { method: "DELETE" }),
  // F6:切换到包含 messageId 的分支(兄弟版本 / 搜索命中),返回切换后的消息列表
  setHead: (sessionId: string, messageId: number) =>
    req<{ headId: number; messages: ChatMessage[] }>(`/sessions/${sessionId}/head`, {
      method: "POST",
      body: JSON.stringify({ messageId }),
    }),
  branchSession: (sessionId: string, body: { messageId?: number; title?: string }) =>
    req<SessionMeta>(`/sessions/${sessionId}/branch`, { method: "POST", body: JSON.stringify(body) }),
  messages: (id: string) => req<ChatMessage[]>(`/sessions/${id}/messages`),
  // M7:消息全文搜索;archived=true 时连同已归档会话一起搜
  search: (q: string, opts: { mode?: string; archived?: boolean; limit?: number } = {}) => {
    const p = new URLSearchParams({ q });
    if (opts.mode) p.set("mode", opts.mode);
    if (opts.archived) p.set("archived", "all");
    if (opts.limit) p.set("limit", String(opts.limit));
    return req<SearchHit[]>(`/search?${p}`);
  },
  // F1:后台生成。回到会话时查运行中的生成并续订;停止走 cancel
  activeRun: (sessionId: string) => req<RunInfo | null>(`/sessions/${sessionId}/active-run`),
  cancelRun: (runId: string) => req<{ ok: boolean }>(`/runs/${runId}/cancel`, { method: "POST" }),
  runningSessions: () => req<{ running: string[] }>("/runs"),
  providers: () => req<Array<Omit<ProviderConfig, "apiKey"> & { apiKey: string; active: boolean }>>("/providers"),
  saveProvider: (p: ProviderConfig) => req("/providers", { method: "POST", body: JSON.stringify(p) }),
  deleteProvider: (id: string) => req(`/providers/${id}`, { method: "DELETE" }),
  activateProvider: (id: string) => req(`/providers/${id}/activate`, { method: "POST" }),
  facts: () => req<Fact[]>("/memory/facts"),
  addFact: (b: { content: string; source?: string; confidence?: number; scope?: string }) => req<Fact>("/memory/facts", { method: "POST", body: JSON.stringify(b) }),
  deleteFact: (id: string, hard?: boolean) => req(`/memory/facts/${id}${hard ? "?hard=true" : ""}`, { method: "DELETE" }),
  searchFacts: (q: string) => req<Fact[]>("/memory/query", { method: "POST", body: JSON.stringify({ q }) }),
  candidates: (status?: "pending" | "confirmed" | "rejected") =>
    req<MemoryCandidate[]>(`/memory/candidates${status ? `?status=${status}` : ""}`),
  confirmCandidate: (id: string) => req(`/memory/candidates/${id}/confirm`, { method: "POST" }),
  rejectCandidate: (id: string) => req(`/memory/candidates/${id}/reject`, { method: "POST" }),
  extract: (sessionId: string) => req<{ candidates: number }>("/memory/extract", { method: "POST", body: JSON.stringify({ sessionId }) }),
  tasks: (filter: { sessionId?: string; status?: TaskStatus; groupId?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]);
    return req<SubagentTask[]>(`/tasks${q.size ? `?${q}` : ""}`);
  },
  createTask: (b: { role: AgentRole; prompt: string; title?: string; sessionId?: string; providerId?: string; mode?: string; workspace?: string }) =>
    req<{ ids: string[] }>("/tasks", { method: "POST", body: JSON.stringify(b) }),
  createTaskGroup: (b: {
    schedule: Exclude<TaskSchedule, "run">;
    sessionId?: string; mode?: string; workspace?: string;
    tasks: Array<{ role: AgentRole; prompt: string; title?: string; providerId?: string }>;
  }) => req<{ ids: string[] }>("/tasks", { method: "POST", body: JSON.stringify(b) }),
  cancelTask: (id: string) => req(`/tasks/${id}/cancel`, { method: "POST" }),
  retryTask: (id: string) => req(`/tasks/${id}/retry`, { method: "POST" }),
  resumeTask: (id: string, answer: string) => req(`/tasks/${id}/resume`, { method: "POST", body: JSON.stringify({ answer }) }),
  providerModels: (id: string) => req<{ models: string[] }>(`/providers/${id}/models`),
  probeProvider: (id: string) => req<{ ok: boolean; latencyMs: number; model: string; error?: string }>(`/providers/${id}/probe`, { method: "POST" }),
  // ---- 阶段 4:工具 ----
  updateSession: (id: string, b: { workspace?: string; title?: string; archived?: boolean; providerId?: string | null; model?: string | null }) =>
    req(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  shells: () => req<ShellInfo[]>("/tools/shells"),
  toolShell: (b: { workspace: string; command: string; shell?: string; confirmed?: boolean }) =>
    req<ShellResult & { needsConfirm?: boolean }>("/tools/shell", { method: "POST", body: JSON.stringify(b) }),
  gitStatus: (workspace: string) =>
    req<ShellResult>("/tools/git/status", { method: "POST", body: JSON.stringify({ workspace }) }),
  gitDiff: (workspace: string) =>
    req<ShellResult>("/tools/git/diff", { method: "POST", body: JSON.stringify({ workspace }) }),
  gitCommit: (b: { workspace: string; message: string; files: string[]; confirmed?: boolean }) =>
    req<ShellResult & { needsConfirm?: boolean }>("/tools/git/commit", { method: "POST", body: JSON.stringify(b) }),
  // 提交范围预览:文件清单 + 差异摘要(含已有暂存内容)
  gitPreview: (workspace: string) =>
    req<GitPreview>("/tools/git/preview", { method: "POST", body: JSON.stringify({ workspace }) }),
  // ---- 阶段 5:Work ----
  listFiles: (workspace: string, path?: string) =>
    req<{ files: string[] }>("/tools/list", { method: "POST", body: JSON.stringify({ workspace, path }) }),
  readFile: (workspace: string, path: string) =>
    req<{ content: string }>("/tools/read", { method: "POST", body: JSON.stringify({ workspace, path }) }),
  workDocs: (workspace?: string) => req<WorkDoc[]>(`/work/docs${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`),
  workDoc: (id: string) => req<WorkDoc>(`/work/docs/${id}`),
  importDocFile: (b: { workspace: string; path: string; sessionId?: string }) =>
    req<WorkDoc>("/work/docs/import-file", { method: "POST", body: JSON.stringify(b) }),
  importDocUrl: (b: { url: string; workspace?: string; sessionId?: string }) =>
    req<WorkDoc>("/work/docs/import-url", { method: "POST", body: JSON.stringify(b) }),
  pasteDoc: (b: { title: string; content: string; workspace?: string; sessionId?: string }) =>
    req<WorkDoc>("/work/docs/paste", { method: "POST", body: JSON.stringify(b) }),
  deleteDoc: (id: string) => req(`/work/docs/${id}`, { method: "DELETE" }),
  todos: (workspace?: string) => req<Todo[]>(`/work/todos${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`),
  addTodo: (b: { title: string; due?: string; source?: string; workspace?: string; sessionId?: string }) =>
    req<Todo>("/work/todos", { method: "POST", body: JSON.stringify(b) }),
  setTodoStatus: (id: string, status: "open" | "done") =>
    req(`/work/todos/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),
  deleteTodo: (id: string) => req(`/work/todos/${id}`, { method: "DELETE" }),
  // ---- 阶段 6:Skill ----
  skills: () => req<SkillInfo[]>("/skills"),
  importSkill: (path: string) => req<SkillInfo>("/skills/import", { method: "POST", body: JSON.stringify({ path }) }),
  enableSkill: (id: string) => req(`/skills/${id}/enable`, { method: "POST" }),
  disableSkill: (id: string) => req(`/skills/${id}/disable`, { method: "POST" }),
  deleteSkill: (id: string) => req(`/skills/${id}`, { method: "DELETE" }),
  events: (limit = 50) => req<Array<{ type: string; payload: string; created_at: string }>>(`/events?limit=${limit}`),
  exportData: () => req<Record<string, unknown>>("/admin/export"),
  importPreview: (pack: unknown) => req<Record<string, { total: number; duplicate?: number; added?: number }>>("/admin/import/preview", { method: "POST", body: JSON.stringify(pack) }),
  importData: (pack: unknown) => req<{ ok: boolean; added: Record<string, number>; skipped: Record<string, number>; attachments?: { added: number; skipped: number; invalid: number } }>("/admin/import", { method: "POST", body: JSON.stringify(pack) }),
};

export async function health(): Promise<boolean> {
  try {
    return (await fetch(`${base}/health`)).ok;
  } catch {
    return false;
  }
}

export interface RunInfo {
  id: string;
  sessionId: string;
  status: "running" | "done" | "error" | "cancelled";
  userMessageId: number | null;
  startedAt: string;
  finishedAt: string | null;
}

type SSEHandler = (ev: StreamEvent, seq: number) => void;

// 读取一段 SSE 响应:逐个事件回调(带 id 行的 seq),error 事件透传后抛出
async function readSSE(res: Response, onEvent: SSEHandler): Promise<void> {
  if (!res.body) throw new Error("empty response");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const b of blocks) {
      const lines = b.split("\n");
      const line = lines.find((l) => l.startsWith("data:"));
      if (!line) continue;
      const idLine = lines.find((l) => l.startsWith("id:"));
      let ev: StreamEvent;
      try {
        ev = JSON.parse(line.slice(5).trim()) as StreamEvent;
      } catch {
        continue; // 坏 JSON 跳过
      }
      onEvent(ev, idLine ? Number(idLine.slice(3).trim()) || 0 : 0);
      if ("error" in ev && ev.error) throw new ServerError(ev.error);
    }
  }
}

// 服务端明确下发的错误(不是网络问题),不做断线续订
class ServerError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

// 非 2xx 响应:取 JSON 里的 error 字段,否则原文
async function errorOf(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (typeof j.error === "string") return new Error(j.error);
  } catch {
    // 非 JSON
  }
  return new Error(text || `HTTP ${res.status}`);
}

// 断线续订:读流时网络出错且已知 runId,就按最后的 seq 从 /runs/:id/events 接着读,最多重连 3 次(1s/2s/4s)
async function withResume(
  first: () => Promise<Response>,
  onEvent: SSEHandler,
  signal: AbortSignal | undefined,
  initialRunId?: string,
): Promise<void> {
  let runId = initialRunId;
  let seq = 0;
  const handle: SSEHandler = (ev, s) => {
    if (s) seq = s;
    if ("type" in ev && ev.type === "meta" && ev.runId) runId = ev.runId;
    onEvent(ev, s);
  };
  let res = await first();
  if (!res.ok) throw await errorOf(res);
  let attempt = 0;
  for (;;) {
    let lastErr: unknown;
    try {
      await readSSE(res, handle);
      return;
    } catch (e) {
      if (e instanceof ServerError || signal?.aborted || !runId) throw e;
      lastErr = e;
    }
    for (;;) {
      if (attempt >= 3) throw lastErr;
      await sleep(1000 * 2 ** attempt++, signal);
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      try {
        res = await fetch(`${base}/runs/${runId}/events?after=${seq}`, { signal: signal ?? null });
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.status === 404) throw new Error("连接中断,服务端已没有这次生成的记录,请刷新查看");
      if (res.ok) break;
      lastErr = await errorOf(res);
    }
  }
}

// 续订一次后台生成(切回会话 / 刷新后),从头回放到结束
export function subscribeRun(runId: string, onEvent: (ev: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  return withResume(() => fetch(`${base}/runs/${runId}/events`, { signal: signal ?? null }), onEvent, signal, runId);
}

export const attachmentUrl = (id: string) => `${base}/attachments/${id}`;

export type ExternalPreview = {
  source: "chatgpt" | "claude";
  conversations: number;
  messages: number;
  duplicate: number;
  empty: number;
  from: string | null;
  to: string | null;
};

export async function streamChat(
  sessionId: string,
  message: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
  regenerate = false,
  // opts.onEvent 不为空时,所有事件原样透传(含块事件);否则退回旧 onDelta 行为
  opts?: {
    onEvent?: (ev: StreamEvent) => void;
    context?: string;
    refs?: RefPayload[];
    providerId?: string;
    model?: string;
    editOf?: number; // 编辑该 user 消息:作为它的新版本发送(F6)
    attachments?: string[]; // 已上传附件 id(B2);编辑时缺省表示沿用原附件
  },
): Promise<void> {
  const post = () =>
    fetch(`${base}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // regenerate=true 时 server 不再落库 user 消息(该消息此前已入库),新回复作为上一条回复的兄弟版本
      body: JSON.stringify({
        sessionId, message, regenerate,
        context: opts?.context,
        refs: opts?.refs,
        providerId: opts?.providerId,
        model: opts?.model,
        editOf: opts?.editOf,
        attachments: opts?.attachments,
      }),
      signal: signal ?? null,
    });
  await withResume(
    post,
    (ev) => {
      // opts.onEvent 不为空时所有事件原样透传(含块事件);否则旧调用方只收未带 type 的 delta
      if (opts?.onEvent) opts.onEvent(ev);
      else if (!("type" in ev) && "delta" in ev && ev.delta) onDelta(ev.delta);
    },
    signal,
  );
}
