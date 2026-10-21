import type { AgentRole, ChatBlock, ChatMessage, Fact, GitPreview, MemoryCandidate, ProviderConfig, SessionMeta, ShellInfo, ShellResult, SkillInfo, SubagentTask, TaskSchedule, TaskStatus, Todo, TokenUsage, WorkDoc } from "@xiyun/shared";

// /chat SSE 事件:typed 块事件 + 旧版 plain delta/error/done
export type StreamEvent =
  | { type: "block"; id: string; block: { kind: "text" | "thinking" } | { kind: "tool"; name: string; status: string } }
  | { type: "block_delta"; id: string; delta: string }
  | { type: "block_end"; id: string; block: ChatBlock }
  | { type: "usage"; usage: TokenUsage } // 模型返回的真实用量,至多一次,在 done 之前
  | { type: "meta"; userMessageId: number | null } // 首个事件:本轮 user 消息的落库 id
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
  createSession: (body?: Partial<SessionMeta>) => req<SessionMeta>("/sessions", { method: "POST", body: JSON.stringify(body ?? {}) }),
  deleteSession: (id: string) => req(`/sessions/${id}`, { method: "DELETE" }),
  truncateFrom: (sessionId: string, messageId: number) =>
    req(`/sessions/${sessionId}/messages/${messageId}/truncate`, { method: "POST" }),
  branchSession: (sessionId: string, body: { messageId?: number; title?: string }) =>
    req<SessionMeta>(`/sessions/${sessionId}/branch`, { method: "POST", body: JSON.stringify(body) }),
  messages: (id: string) => req<ChatMessage[]>(`/sessions/${id}/messages`),
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
  probeProvider: (id: string) => req<{ ok: boolean; latencyMs: number; model: string; error?: string }>(`/providers/${id}/probe`, { method: "POST" }),
  // ---- 阶段 4:工具 ----
  updateSession: (id: string, b: { workspace?: string; title?: string; archived?: boolean }) =>
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
  importData: (pack: unknown) => req<{ ok: boolean; added: Record<string, number>; skipped: Record<string, number> }>("/admin/import", { method: "POST", body: JSON.stringify(pack) }),
};

export async function health(): Promise<boolean> {
  try {
    return (await fetch(`${base}/health`)).ok;
  } catch {
    return false;
  }
}

export async function streamChat(
  sessionId: string,
  message: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
  regenerate = false,
  // opts.onEvent 不为空时,所有事件原样透传(含块事件);否则退回旧 onDelta 行为
  opts?: { onEvent?: (ev: StreamEvent) => void; context?: string; refs?: RefPayload[] },
): Promise<void> {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // regenerate=true 时 server 不再落库 user 消息(该消息此前已入库),并覆盖上一条 assistant 回复
    body: JSON.stringify({
      sessionId, message, regenerate,
      context: opts?.context,
      refs: opts?.refs,
    }),
    signal: signal ?? null,
  });
  if (!res.ok || !res.body) throw new Error(await res.text());
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
      const line = b.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let ev: StreamEvent;
      try {
        ev = JSON.parse(line.slice(5).trim()) as StreamEvent;
      } catch {
        continue; // 坏 JSON 跳过
      }
      // error 事件也先透传:其中的落库 id 要回填到气泡,随后再抛出
      if (opts?.onEvent) opts.onEvent(ev);
      // 旧调用方只收未带 type 的 delta,块事件(type 字段)不下漏到消息文本
      else if (!("type" in ev) && "delta" in ev && ev.delta) onDelta(ev.delta);
      if ("error" in ev && ev.error) throw new Error(ev.error);
    }
  }
}
