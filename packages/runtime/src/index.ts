import type { ChatMessage, ModelRole, ProviderConfig, TokenUsage } from "@xiyun/shared";

export interface ToolDef {
  name: string; // 必须匹配 ^[a-zA-Z0-9_-]{1,64}$
  description: string;
  parameters: object; // JSON Schema
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
  tools?: ToolDef[]; // 仅 streamEvents 使用
}

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; index: number; name: string }
  | { type: "tool_args"; id: string; delta: string }
  | { type: "tool_end"; id: string; args: string }
  | { type: "usage"; usage: TokenUsage } // 至多一次,紧挨 finish 之前
  | { type: "finish"; reason: string | null };

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;

// 归一化各家 OpenAI 兼容网关的 usage:
// - OpenAI / 通义 / 智谱:prompt_tokens_details.cached_tokens、completion_tokens_details.reasoning_tokens
// - DeepSeek:prompt_cache_hit_tokens
// - 少数网关:input_tokens / output_tokens
// 输入、输出都拿不到时返回 null(例如 include_usage 开启后中间分片的 usage:null)。
export function normalizeUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const pd = (u.prompt_tokens_details ?? u.input_tokens_details) as Record<string, unknown> | null | undefined;
  const cd = (u.completion_tokens_details ?? u.output_tokens_details) as Record<string, unknown> | null | undefined;
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens);
  const completion = num(u.completion_tokens) ?? num(u.output_tokens);
  if (prompt === undefined && completion === undefined) return null;
  const usage: TokenUsage = {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    totalTokens: num(u.total_tokens) ?? (prompt ?? 0) + (completion ?? 0),
  };
  const cached = num(pd?.cached_tokens) ?? num(u.prompt_cache_hit_tokens);
  if (cached) usage.cachedTokens = cached;
  const reasoning = num(cd?.reasoning_tokens);
  if (reasoning) usage.reasoningTokens = reasoning;
  return usage;
}

// ChatProvider 是模型接入的统一接口。
// 决策 D-001 选定 Pi Runtime,但接入方式未定(见 NOW.md 待确认项);
// Pi 后续作为本接口的另一实现接入,上层不变。
export interface ChatProvider {
  config: ProviderConfig;
  streamChat(messages: ChatMessage[], opts?: ChatStreamOptions): AsyncIterable<string>;
  // streamEvents 是可选的:OpenAI 实现已提供,PI 等其他实现按需补齐
  streamEvents?(messages: ChatMessage[], opts?: ChatStreamOptions): AsyncIterable<ProviderEvent>;
}

type CallState = { id: string; name: string; args: string; started: boolean; ended: boolean };

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
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const QUOTA_RE = /insufficient_quota|exceeded your current quota|余额不足|欠费|quota exceeded/i;
const CONTEXT_RE = /context[_ ]length|context window|maximum context|too many tokens|max_tokens|上下文|长度超/i;

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
function redact(text: string, apiKey: string): string {
  let t = text;
  if (apiKey && apiKey.length >= 6) t = t.split(apiKey).join("***");
  return t
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/\b(sk|ak|key)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function errorDetail(raw: string, apiKey: string): { detail: string; code: string } {
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

// 拒绝 stream_options(HTTP 400/422)的网关,按 baseUrl + model 记住,进程内后续请求不再携带。
// Provider 实例按请求创建,所以缓存放在模块级。
const usageUnsupported = new Set<string>();

export function createOpenAIProvider(config: ProviderConfig, popts: ProviderOptions = {}): ChatProvider {
  const usageKey = `${config.baseUrl.replace(/\/+$/, "")}|${config.model}`;
  const retries = popts.retries ?? 2;
  const retryBaseMs = popts.retryBaseMs ?? 500;
  const maxRetryAfterMs = popts.maxRetryAfterMs ?? 20_000;
  const idleTimeoutMs = popts.idleTimeoutMs ?? 300_000;

  const streamEvents = async function* (
    messages: ChatMessage[],
    opts?: ChatStreamOptions,
  ): AsyncIterable<ProviderEvent> {
    const body: Record<string, unknown> = {
      model: config.model,
      // 只发 role/content:blocks、id 等内部字段会让严格网关 400
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };
    if (opts?.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    const request = (payload: Record<string, unknown>) =>
      fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(payload),
        signal: opts?.signal ?? null,
      });
    // 只在拿到响应流之前重试(此时还没有任何 token 下发),流开始后的错误交给上层落半截
    const open = async (payload: Record<string, unknown>): Promise<Response & { body: ReadableStream<Uint8Array> }> => {
      for (let attempt = 0; ; attempt++) {
        let err: ProviderError;
        try {
          const res = await request(payload);
          if (res.ok && res.body) return res as Response & { body: ReadableStream<Uint8Array> };
          const raw = res.ok ? "" : await res.text().catch(() => "");
          err = res.ok
            ? new ProviderError("模型服务返回了空响应", { status: res.status })
            : toProviderError(res.status, raw, config.apiKey, parseRetryAfter(res.headers));
        } catch (e) {
          if (opts?.signal?.aborted || (e as Error)?.name === "AbortError") throw e;
          if (e instanceof ProviderError) throw e;
          const cause = (e as { cause?: { code?: unknown } })?.cause?.code;
          const why = typeof cause === "string" ? cause : e instanceof Error ? e.message : String(e);
          err = new ProviderError(`无法连接模型服务(${redact(why, config.apiKey)})`, { status: 0, retryable: true });
        }
        if (!err.retryable || attempt >= retries) throw err;
        const wait = err.retryAfterMs ?? retryBaseMs * 2 ** attempt + Math.random() * retryBaseMs;
        if (wait > maxRetryAfterMs) throw err;
        await sleep(wait, opts?.signal);
      }
    };

    // 请求末尾分片附带 usage(OpenAI 兼容:choices 为空、usage 为整轮用量)
    const askUsage = !usageUnsupported.has(usageKey);
    let res: Response & { body: ReadableStream<Uint8Array> };
    try {
      res = await open(askUsage ? { ...body, stream_options: { include_usage: true } } : body);
    } catch (e) {
      // 严格网关不认识 stream_options:去掉后重试一次;重试成功才判定为不支持
      if (!(askUsage && e instanceof ProviderError && (e.status === 400 || e.status === 422))) throw e;
      res = await open(body);
      usageUnsupported.add(usageKey);
    }

    const reader = res.body.getReader();
    // 空闲超时:连接还在但长时间没有任何字节时主动断开,避免请求永久挂起
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
    const calls = new Map<number, CallState>();
    let buf = "";
    let stop = false;
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;

    const parseLine = function* (raw: string): Generator<ProviderEvent> {
      const t = raw.trim();
      if (!t.startsWith("data:")) return;
      const data = t.slice(5).trim();
      if (!data) return;
      if (data === "[DONE]") {
        stop = true;
        return;
      }
      let obj: {
        error?: unknown;
        usage?: unknown;
        choices?: Array<{
          usage?: unknown;
          delta?: {
            content?: unknown;
            reasoning_content?: unknown;
            reasoning?: unknown;
            tool_calls?: Array<{
              index?: unknown;
              id?: unknown;
              function?: { name?: unknown; arguments?: unknown };
            }>;
          };
          finish_reason?: unknown;
        }>;
      };
      try {
        obj = JSON.parse(data);
      } catch {
        return; // SSE 分片不完整,跳过
      }
      // 部分网关(如 OpenRouter)HTTP 200 后在流内下发 error 对象;不处理会静默结束成一条空回复
      if (obj.error && !obj.choices?.length) {
        const code = (obj.error as { code?: unknown }).code;
        const status = typeof code === "number" ? code : 0;
        const { detail } = errorDetail(JSON.stringify({ error: obj.error }), config.apiKey);
        throw new ProviderError(`模型服务在生成中返回错误${detail ? `(${detail})` : ""}`, { status });
      }
      const choice = obj.choices?.[0];
      // usage 可能在顶层(OpenAI / DeepSeek / 通义),也可能挂在 choice 上(Moonshot);以最后一次为准
      const u = normalizeUsage(obj.usage ?? choice?.usage);
      if (u) usage = u;
      if (!choice) return;
      const d = choice.delta ?? {};
      // 空串/null 忽略:reasoning 阶段常见 content:"",不能让 thinking 被切碎
      if (typeof d.content === "string" && d.content) yield { type: "text", delta: d.content };
      const think =
        typeof d.reasoning_content === "string"
          ? d.reasoning_content
          : typeof d.reasoning === "string"
            ? d.reasoning
            : "";
      if (think) yield { type: "thinking", delta: think };
      for (const tc of d.tool_calls ?? []) {
        const idx = typeof tc.index === "number" ? tc.index : calls.size;
        let c = calls.get(idx);
        if (!c) {
          const id = typeof tc.id === "string" && tc.id ? tc.id : `call_${idx}`;
          calls.set(idx, (c = { id, name: "", args: "", started: false, ended: false }));
        } else if (typeof tc.id === "string" && tc.id && !c.started) {
          c.id = tc.id;
        }
        if (typeof tc.function?.name === "string") c.name += tc.function.name;
        if (!c.started && c.name) {
          c.started = true;
          yield { type: "tool_start", id: c.id, index: idx, name: c.name };
        }
        if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
          c.args += tc.function.arguments;
          // name 到达前的参数分片先缓存,started 后不补发
          if (c.started) yield { type: "tool_args", id: c.id, delta: tc.function.arguments };
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
    };

    const processBuffer = function* (text: string): Generator<ProviderEvent> {
      for (const l of text.split("\n")) {
        yield* parseLine(l);
        if (stop) return;
      }
    };

    for (;;) {
      const { done: readerDone, value } = await read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (readerDone) {
        buf += decoder.decode();
        yield* processBuffer(buf); // 先解析残留的最后一行
        buf = "";
        break;
      }
      const cut = buf.lastIndexOf("\n");
      if (cut < 0) continue;
      const ready = buf.slice(0, cut + 1);
      buf = buf.slice(cut + 1);
      yield* processBuffer(ready);
      if (stop) break;
    }

    // 按 index 升序 flush 未结束的调用
    for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      void index;
      if (c.started && !c.ended) {
        c.ended = true;
        yield { type: "tool_end", id: c.id, args: c.args };
      }
    }
    if (usage) yield { type: "usage", usage };
    yield { type: "finish", reason: finishReason };
  };

  return {
    config,
    streamEvents,
    // 兼容包装:永不传 tools,只透传正文
    async *streamChat(messages, opts) {
      for await (const ev of streamEvents(messages, { signal: opts?.signal })) {
        if (ev.type === "text") yield ev.delta;
      }
    },
  };
}

// 模型注册表:记录 Provider、能力标签与角色标签(main/subagent/vision/memory/embedding),
// 默认按角色选模型,用户可临时覆盖。
export class ModelRegistry {
  private providers = new Map<string, ChatProvider>();

  register(p: ChatProvider): void {
    this.providers.set(p.config.id, p);
  }

  get(id: string): ChatProvider | undefined {
    return this.providers.get(id);
  }

  byRole(role: ModelRole): ChatProvider | undefined {
    for (const p of this.providers.values()) {
      if (p.config.roles?.includes(role)) return p;
    }
    return undefined;
  }

  // 同角色全部绑定模型,作为授权回退链(只允许在已绑定该角色的模型间回退)。
  byRoleAll(role: ModelRole): ChatProvider[] {
    return [...this.providers.values()].filter((p) => p.config.roles?.includes(role));
  }

  first(): ChatProvider | undefined {
    return this.providers.values().next().value;
  }
}
