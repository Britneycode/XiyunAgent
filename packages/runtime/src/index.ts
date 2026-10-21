import type { ChatMessage, ModelRole, ProviderConfig, ProviderProtocol, TokenUsage } from "@xiyun/shared";
import { createAnthropicProvider } from "./anthropic.ts";
import { createGeminiProvider } from "./gemini.ts";
import {
  buildHeaders,
  buildUrl,
  errorDetail,
  getJson,
  openWithRetry,
  ProviderError,
  readLines,
  resolveOptions,
  sseData,
  textOnly,
  type CallState,
  type ProviderOptions,
  type StreamResponse,
} from "./http.ts";

export { parseRetryAfter, ProviderError, toProviderError, type ProviderOptions } from "./http.ts";
export { createAnthropicProvider } from "./anthropic.ts";
export { createGeminiProvider } from "./gemini.ts";

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
  // 拉取服务商可用的模型 id(设置页"获取模型");不支持的实现可省略
  listModels?(signal?: AbortSignal): Promise<string[]>;
}

// 拒绝 stream_options(HTTP 400/422)的网关,按 baseUrl + model 记住,进程内后续请求不再携带。
// Provider 实例按请求创建,所以缓存放在模块级。
const usageUnsupported = new Set<string>();

// 只发 role/content:blocks、id 等内部字段会让严格网关 400。带图片的 user 消息改用 content 数组(B2)
const wireMessages = (messages: ChatMessage[]) =>
  messages.map((m) =>
    m.role === "user" && m.images?.length
      ? {
          role: m.role,
          content: [
            ...(m.content.trim() ? [{ type: "text", text: m.content }] : []),
            ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } })),
          ],
        }
      : { role: m.role, content: m.content },
  );

export function createOpenAIProvider(config: ProviderConfig, popts: ProviderOptions = {}): ChatProvider {
  const usageKey = `${config.baseUrl.replace(/\/+$/, "")}|${config.model}`;
  const o = resolveOptions(popts);
  const headers = () => buildHeaders(config, { Authorization: `Bearer ${config.apiKey}` });

  const streamEvents = async function* (
    messages: ChatMessage[],
    opts?: ChatStreamOptions,
  ): AsyncIterable<ProviderEvent> {
    const body: Record<string, unknown> = { model: config.model, messages: wireMessages(messages), stream: true };
    const p = config.params ?? {};
    if (typeof p.temperature === "number") body.temperature = p.temperature;
    if (typeof p.maxTokens === "number" && p.maxTokens > 0) body.max_tokens = p.maxTokens;
    if (p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;
    if (opts?.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    const url = buildUrl(config.baseUrl, "/chat/completions", config.query);
    const open = (payload: Record<string, unknown>) =>
      openWithRetry(
        () => fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(payload), signal: opts?.signal ?? null }),
        { ...o, apiKey: config.apiKey, signal: opts?.signal },
      );

    // 请求末尾分片附带 usage(OpenAI 兼容:choices 为空、usage 为整轮用量)
    const askUsage = !usageUnsupported.has(usageKey);
    let res: StreamResponse;
    try {
      res = await open(askUsage ? { ...body, stream_options: { include_usage: true } } : body);
    } catch (e) {
      // 严格网关不认识 stream_options:去掉后重试一次;重试成功才判定为不支持
      if (!(askUsage && e instanceof ProviderError && (e.status === 400 || e.status === 422))) throw e;
      res = await open(body);
      usageUnsupported.add(usageKey);
    }

    const calls = new Map<number, CallState>();
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;

    const parseLine = function* (raw: string): Generator<ProviderEvent | "stop"> {
      const d0 = sseData(raw);
      if (!d0) return;
      if ("done" in d0) {
        yield "stop";
        return;
      }
      const obj = d0.json as {
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
      } | null;
      if (!obj || typeof obj !== "object") return;
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

    read: for await (const line of readLines(res.body, o.idleTimeoutMs)) {
      for (const ev of parseLine(line)) {
        if (ev === "stop") break read;
        yield ev;
      }
    }

    // 按 index 升序 flush 未结束的调用
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
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
    streamChat: textOnly(streamEvents),
    async listModels(signal) {
      const j = (await getJson(buildUrl(config.baseUrl, "/models", config.query), headers(), config.apiKey, signal)) as {
        data?: Array<{ id?: unknown }>;
      };
      return (j.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
    },
  };
}

// 按协议选适配器(M2 / D-021);未知协议按 OpenAI 兼容处理
const ADAPTERS: Record<ProviderProtocol, (c: ProviderConfig, o?: ProviderOptions) => ChatProvider> = {
  openai: createOpenAIProvider,
  anthropic: createAnthropicProvider,
  gemini: createGeminiProvider,
};

export function createProvider(config: ProviderConfig, popts: ProviderOptions = {}): ChatProvider {
  return (ADAPTERS[config.protocol ?? "openai"] ?? createOpenAIProvider)(config, popts);
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
