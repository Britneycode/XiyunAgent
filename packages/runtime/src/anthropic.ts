// Anthropic Messages API 适配器(M2 / D-021):POST {base}/v1/messages,x-api-key + anthropic-version 鉴权,
// system 放顶层;SSE 事件 content_block_* / message_delta 映射成统一的 ProviderEvent。
import type { ChatMessage, ProviderConfig, TokenUsage } from "@xiyun/shared";
import type { ChatProvider, ChatStreamOptions, ProviderEvent } from "./index.ts";
import {
  buildHeaders,
  buildUrl,
  EFFORT_BUDGET,
  errorDetail,
  getJson,
  openWithRetry,
  ProviderError,
  readLines,
  resolveOptions,
  splitSystem,
  sseData,
  textOnly,
  type ProviderOptions,
} from "./http.ts";

const VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;

// 用户填 https://api.anthropic.com 或 .../v1 都可以
const apiPath = (base: string, path: string) => (/\/v1\/?$/.test(base.trim()) ? path : `/v1${path}`);

const STOP: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length" };

type Usage = { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

export function createAnthropicProvider(config: ProviderConfig, popts: ProviderOptions = {}): ChatProvider {
  const o = resolveOptions(popts);
  const headers = () => ({
    ...buildHeaders(config, { "x-api-key": config.apiKey }),
    "anthropic-version": config.headers?.["anthropic-version"] ?? VERSION,
  });

  const streamEvents = async function* (messages: ChatMessage[], opts?: ChatStreamOptions): AsyncIterable<ProviderEvent> {
    const { system, turns } = splitSystem(messages);
    const p = config.params ?? {};
    const budget = p.reasoningEffort ? EFFORT_BUDGET[p.reasoningEffort] : 0;
    // 开启思考时 max_tokens 必须大于思考预算,且不能指定 temperature
    const maxTokens = Math.max(p.maxTokens && p.maxTokens > 0 ? p.maxTokens : DEFAULT_MAX_TOKENS, budget ? budget + 4096 : 0);
    // 带图片的轮次用内容块数组:图片在前、文字在后(Anthropic 推荐顺序)
    const wire = turns.map((t) =>
      t.images?.length
        ? {
            role: t.role,
            content: [
              ...t.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
              ...(t.content.trim() ? [{ type: "text", text: t.content }] : []),
            ],
          }
        : { role: t.role, content: t.content },
    );
    const body: Record<string, unknown> = { model: config.model, max_tokens: maxTokens, messages: wire, stream: true };
    if (system) body.system = system;
    if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
    else if (typeof p.temperature === "number") body.temperature = Math.min(1, Math.max(0, p.temperature));
    if (opts?.tools?.length) {
      body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    const url = buildUrl(config.baseUrl, apiPath(config.baseUrl, "/messages"), config.query);
    const res = await openWithRetry(
      () => fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: opts?.signal ?? null }),
      { ...o, apiKey: config.apiKey, signal: opts?.signal },
    );

    const tools = new Map<number, { id: string; args: string }>();
    let usage: Usage = {};
    let finish: string | null = null;

    for await (const line of readLines(res.body, o.idleTimeoutMs)) {
      const d = sseData(line);
      if (!d || "done" in d) continue;
      const ev = d.json as {
        type?: string;
        index?: number;
        message?: { usage?: Usage };
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
        usage?: Usage;
        error?: { type?: string; message?: string };
      } | null;
      if (!ev || typeof ev !== "object") continue;
      const idx = typeof ev.index === "number" ? ev.index : 0;
      if (ev.type === "message_start") {
        usage = { ...usage, ...(ev.message?.usage ?? {}) };
      } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        const id = ev.content_block.id || `call_${idx}`;
        tools.set(idx, { id, args: "" });
        yield { type: "tool_start", id, index: idx, name: ev.content_block.name ?? "" };
      } else if (ev.type === "content_block_delta" && ev.delta) {
        if (ev.delta.type === "text_delta" && ev.delta.text) yield { type: "text", delta: ev.delta.text };
        else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) yield { type: "thinking", delta: ev.delta.thinking };
        else if (ev.delta.type === "input_json_delta" && ev.delta.partial_json) {
          const t = tools.get(idx);
          if (t) {
            t.args += ev.delta.partial_json;
            yield { type: "tool_args", id: t.id, delta: ev.delta.partial_json };
          }
        }
      } else if (ev.type === "content_block_stop") {
        const t = tools.get(idx);
        if (t) {
          tools.delete(idx);
          yield { type: "tool_end", id: t.id, args: t.args || "{}" };
        }
      } else if (ev.type === "message_delta") {
        if (ev.delta?.stop_reason) finish = STOP[ev.delta.stop_reason] ?? ev.delta.stop_reason;
        // message_delta 的 output_tokens 是累计值
        if (ev.usage) usage = { ...usage, ...ev.usage };
      } else if (ev.type === "message_stop") {
        break;
      } else if (ev.type === "error") {
        // 流内错误(如 overloaded_error);已有 token 下发,交给上层落半截
        const { detail } = errorDetail(JSON.stringify({ error: ev.error ?? {} }), config.apiKey);
        throw new ProviderError(`模型服务在生成中返回错误${detail ? `(${detail})` : ""}`, { status: ev.error?.type === "overloaded_error" ? 529 : 0 });
      }
    }

    for (const t of tools.values()) yield { type: "tool_end", id: t.id, args: t.args || "{}" };
    const cacheRead = n(usage.cache_read_input_tokens);
    const prompt = n(usage.input_tokens) + cacheRead + n(usage.cache_creation_input_tokens);
    const completion = n(usage.output_tokens);
    if (prompt || completion) {
      const u: TokenUsage = { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
      if (cacheRead) u.cachedTokens = cacheRead;
      yield { type: "usage", usage: u };
    }
    yield { type: "finish", reason: finish };
  };

  return {
    config,
    streamEvents,
    streamChat: textOnly(streamEvents),
    async listModels(signal) {
      const url = buildUrl(config.baseUrl, apiPath(config.baseUrl, "/models"), config.query, { limit: "1000" });
      const j = (await getJson(url, headers(), config.apiKey, signal)) as { data?: Array<{ id?: unknown }> };
      return (j.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
    },
  };
}
