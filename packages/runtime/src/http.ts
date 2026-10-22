// 各协议适配器共用的 HTTP 层:错误归一化、首 token 前重试、SSE 逐行读取、URL / 请求头拼装。
import type { ChatMessage, ProviderConfig, ProviderProtocol, ToolCall } from "@xiyun/shared";
import type { ChatProvider, ChatStreamOptions, ProviderEvent } from "./index.ts";

// Provider 调用失败的统一错误:message 面向用户(含状态码、原因提示与脱敏后的服务端原文),
// status=0 表示网络层(连不上 / 读流超时 / 流内错误)。
export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(message: string, o: { status: number; retryable?: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = "ProviderError";
    this.status = o.status;
    this.retryable = o.retryable ?? false;
    if (o.retryAfterMs !== undefined) this.retryAfterMs = o.retryAfterMs;
  }
}

export interface ProviderOptions {
  retries?: number; // 首 token 前的自动重试次数,默认 2(共 3 次请求)
  retryBaseMs?: number; // 指数退避基数,默认 500ms
  maxRetryAfterMs?: number; // 服务端要求等待超过该值时不再重试,直接报错,默认 20s
  idleTimeoutMs?: number; // 流式读取空闲超时,默认 5 分钟;0 关闭
}

// 限流 / 过载 / 网关类错误可重试;额度耗尽(429 insufficient_quota)重试无意义
export const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const QUOTA_RE = /insufficient_quota|exceeded your current quota|余额不足|欠费|quota exceeded/i;
const CONTEXT_RE = /context[_ ]length|context window|maximum context|too many tokens|max_tokens|上下文|长度超/i;

export const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Retry-After 可能是秒数或 HTTP 日期;retry-after-ms 为部分网关的毫秒扩展
export function parseRetryAfter(headers: Headers): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const v = headers.get("retry-after");
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// 服务端错误原文脱敏:去掉 API Key、Bearer 凭据与 HTML 错误页,压成一行并截断
export function redact(text: string, apiKey: string): string {
  let t = text;
  if (apiKey && apiKey.length >= 6) t = t.split(apiKey).join("***");
  return t
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/\b(sk|ak|key)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function errorDetail(raw: string, apiKey: string): { detail: string; code: string } {
  let detail = raw;
  let code = "";
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const e = (j.error ?? j) as Record<string, unknown> | string;
    if (typeof e === "string") detail = e;
    else {
      const m = e.message ?? j.message ?? j.msg ?? j.detail;
      if (typeof m === "string") detail = m;
      const c = e.code ?? e.type;
      if (typeof c === "string") code = c;
    }
  } catch {
    // 非 JSON:HTML 错误页只取 <title>,纯文本原样保留
    if (/^\s*</.test(raw)) detail = /<title>([^<]*)<\/title>/i.exec(raw)?.[1] ?? "";
  }
  return { detail: redact(detail, apiKey), code };
}

function hintFor(status: number, detail: string, code: string): string {
  const text = `${code} ${detail}`;
  if (status === 401 || status === 403) return "鉴权失败,请检查 API Key 或访问权限";
  if (status === 402 || QUOTA_RE.test(text)) return "账户额度不足";
  if (status === 404) return "接口或模型不存在,请检查 Base URL 与模型名";
  if (status === 413 || CONTEXT_RE.test(text)) return "请求超出模型上下文长度";
  if (status === 429) return "请求过于频繁,已被模型服务限流";
  if (status === 408 || status === 504) return "模型服务响应超时";
  if (status >= 500) return "模型服务暂时不可用";
  if (status === 400 || status === 422) return "请求被模型服务拒绝";
  return "模型服务返回错误";
}

export function toProviderError(status: number, raw: string, apiKey: string, retryAfterMs?: number): ProviderError {
  const { detail, code } = errorDetail(raw, apiKey);
  const quota = QUOTA_RE.test(`${code} ${detail}`);
  return new ProviderError(`${hintFor(status, detail, code)}(HTTP ${status}${detail ? `:${detail}` : ""})`, {
    status,
    retryable: RETRY_STATUS.has(status) && !quota,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}


export interface RetryOptions {
  retries: number;
  retryBaseMs: number;
  maxRetryAfterMs: number;
  apiKey: string;
  signal?: AbortSignal | undefined;
}

export type StreamResponse = Response & { body: ReadableStream<Uint8Array> };

// 只在拿到响应流之前重试(此时还没有任何 token 下发),流开始后的错误交给上层落半截
export async function openWithRetry(request: () => Promise<Response>, o: RetryOptions): Promise<StreamResponse> {
  for (let attempt = 0; ; attempt++) {
    let err: ProviderError;
    try {
      const res = await request();
      if (res.ok && res.body) return res as StreamResponse;
      const raw = res.ok ? "" : await res.text().catch(() => "");
      err = res.ok
        ? new ProviderError("模型服务返回了空响应", { status: res.status })
        : toProviderError(res.status, raw, o.apiKey, parseRetryAfter(res.headers));
    } catch (e) {
      if (o.signal?.aborted || (e as Error)?.name === "AbortError") throw e;
      if (e instanceof ProviderError) throw e;
      const cause = (e as { cause?: { code?: unknown } })?.cause?.code;
      const why = typeof cause === "string" ? cause : e instanceof Error ? e.message : String(e);
      err = new ProviderError(`无法连接模型服务(${redact(why, o.apiKey)})`, { status: 0, retryable: true });
    }
    if (!err.retryable || attempt >= o.retries) throw err;
    const wait = err.retryAfterMs ?? o.retryBaseMs * 2 ** attempt + Math.random() * o.retryBaseMs;
    if (wait > o.maxRetryAfterMs) throw err;
    await sleep(wait, o.signal);
  }
}

// 逐行读取响应流;空闲超时:连接还在但长时间没有任何字节时主动断开,避免请求永久挂起。
// 调用方提前结束(break / 抛错)时取消底层读取。
export async function* readLines(body: ReadableStream<Uint8Array>, idleTimeoutMs: number): AsyncGenerator<string> {
  const reader = body.getReader();
  const read = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (!(idleTimeoutMs > 0)) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // 先 reject 再 cancel:cancel 会同步让挂起的 read 以 done 结束,顺序反了会被当成正常收尾
        reject(new ProviderError(`模型服务超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有返回数据,已断开`, { status: 0 }));
        void reader.cancel().catch(() => {});
      }, idleTimeoutMs);
    });
    return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
  };
  const decoder = new TextDecoder();
  let buf = "";
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done) {
        finished = true;
        buf += decoder.decode();
        // 先交出残留的最后一行
        for (const l of buf.split("\n")) yield l;
        return;
      }
      const cut = buf.lastIndexOf("\n");
      if (cut < 0) continue;
      const ready = buf.slice(0, cut);
      buf = buf.slice(cut + 1);
      for (const l of ready.split("\n")) yield l;
    }
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
  }
}

// SSE 的 data 行解析为 JSON;非 data 行、空行与不完整分片返回 undefined
export function sseData(line: string): { done: true } | { json: unknown } | undefined {
  const t = line.trim();
  if (!t.startsWith("data:")) return undefined;
  const data = t.slice(5).trim();
  if (!data) return undefined;
  if (data === "[DONE]") return { done: true };
  try {
    return { json: JSON.parse(data) };
  } catch {
    return undefined;
  }
}

const trimBase = (u: string) => u.trim().replace(/\/+$/, "");

// baseUrl + 路径 + 配置里的查询参数
export function buildUrl(base: string, path: string, query?: Record<string, string>, extra?: Record<string, string>): string {
  const url = `${trimBase(base)}${path}`;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...(query ?? {}), ...(extra ?? {}) })) if (k) p.set(k, v);
  const qs = p.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

// 默认鉴权头 + 用户附加头;附加头的值支持 {apiKey} 占位(如 Azure 的 api-key: {apiKey})。
// 用户自定义了鉴权头(或引用了 {apiKey})时不再发送默认鉴权头。
export function buildHeaders(config: ProviderConfig, auth: Record<string, string>): Record<string, string> {
  const custom = Object.entries(config.headers ?? {}).filter(([k]) => k.trim());
  const usesKey = custom.some(([k, v]) => v.includes("{apiKey}") || Object.keys(auth).some((a) => a.toLowerCase() === k.toLowerCase()));
  const out: Record<string, string> = { "Content-Type": "application/json", ...(usesKey || !config.apiKey ? {} : auth) };
  for (const [k, v] of custom) out[k.trim()] = v.split("{apiKey}").join(config.apiKey);
  return out;
}

// 思考预算(anthropic / gemini):把 reasoningEffort 换算成 token 数
export const EFFORT_BUDGET = { low: 2048, medium: 8192, high: 24576 } as const;

// 拉取模型列表(设置页"获取模型"):GET 并解析 JSON
export async function getJson(url: string, headers: Record<string, string>, apiKey: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: signal ?? null });
  } catch (e) {
    const cause = (e as { cause?: { code?: unknown } })?.cause?.code;
    throw new ProviderError(`无法连接模型服务(${redact(typeof cause === "string" ? cause : String(e), apiKey)})`, { status: 0 });
  }
  const raw = await res.text().catch(() => "");
  if (!res.ok) throw toProviderError(res.status, raw, apiKey);
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProviderError("模型服务返回的模型列表不是 JSON", { status: res.status });
  }
}

// 解析各家 SSE 时共用的工具调用累积状态
export type CallState = { id: string; name: string; args: string; started: boolean; ended: boolean };

export function resolveOptions(popts: ProviderOptions = {}) {
  return {
    retries: popts.retries ?? 2,
    retryBaseMs: popts.retryBaseMs ?? 500,
    maxRetryAfterMs: popts.maxRetryAfterMs ?? 20_000,
    idleTimeoutMs: popts.idleTimeoutMs ?? 300_000,
  };
}

// 兼容包装:永不传 tools,只透传正文
export function textOnly(
  streamEvents: (messages: ChatMessage[], opts?: ChatStreamOptions) => AsyncIterable<ProviderEvent>,
): ChatProvider["streamChat"] {
  return async function* (messages, opts) {
    for await (const ev of streamEvents(messages, { signal: opts?.signal })) {
      if (ev.type === "text") yield ev.delta;
    }
  };
}

// 非 OpenAI 协议的消息整理:system 合并为一段;其余按 user / assistant 交替(相邻同角色合并,图片一并合并),
// 首条必须是 user;空内容去掉(anthropic / gemini 都拒绝空消息)。
// agent 循环(B1):assistant 的 toolCalls 原样带上;tool 结果并成一条 user 轮次的 toolResults(紧跟发起调用的 assistant);
// raw 只在协议一致时带上(thinking 签名等跨协议无效)
export interface ToolResultTurn {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}
export interface Turn {
  role: "user" | "assistant";
  content: string;
  images?: Array<{ mime: string; data: string }>;
  toolCalls?: ToolCall[];
  toolResults?: ToolResultTurn[];
  raw?: unknown;
}
export function splitSystem(messages: ChatMessage[], protocol?: ProviderProtocol): { system: string; turns: Turn[] } {
  const system = messages.filter((m) => m.role === "system" && m.content.trim()).map((m) => m.content).join("\n\n");
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const last = turns[turns.length - 1];
    if (m.role === "tool") {
      const r: ToolResultTurn = { id: m.toolCallId ?? "", name: m.toolName ?? "", content: m.content };
      if (m.toolError) r.isError = true;
      if (last?.role === "user" && last.toolResults && !last.content && !last.images) last.toolResults.push(r);
      else turns.push({ role: "user", content: "", toolResults: [r] });
      continue;
    }
    const images = m.role === "user" && m.images?.length ? m.images : undefined;
    const calls = m.role === "assistant" && m.toolCalls?.length ? m.toolCalls : undefined;
    if (!m.content.trim() && !images && !calls) continue;
    const raw = calls && protocol && m.raw?.protocol === protocol ? m.raw.content : undefined;
    if (last && last.role === m.role) {
      if (m.content.trim()) last.content = last.content ? `${last.content}\n\n${m.content}` : m.content;
      if (images) last.images = [...(last.images ?? []), ...images];
      if (calls) {
        last.toolCalls = [...(last.toolCalls ?? []), ...calls];
        delete last.raw; // 合并后的原样内容不再完整
      }
    } else {
      turns.push({ role: m.role, content: m.content, ...(images ? { images } : {}), ...(calls ? { toolCalls: calls } : {}), ...(raw !== undefined ? { raw } : {}) });
    }
  }
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: "(continue)" });
  return { system, turns };
}

// 工具参数 JSON 字符串 → 对象(anthropic input / gemini args 必须是对象)
export function argsObject(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
