// Gemini API 适配器(M2 / D-021):POST {base}/models/{model}:streamGenerateContent?alt=sse,x-goog-api-key 鉴权,
// system 放 systemInstruction,assistant 角色叫 model;函数调用整段下发,直接映射成 tool_start/args/end。
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

// 用户只填主机名时补上版本前缀
const base = (u: string) => (/\/v1(beta|alpha)?\d*\/?$/.test(u.trim()) ? u : `${u.trim().replace(/\/+$/, "")}/v1beta`);

const STOP: Record<string, string> = { STOP: "stop", MAX_TOKENS: "length" };

// Gemini 只接受 OpenAPI 子集的 schema:去掉它会拒绝的 JSON Schema 关键字
const DROP = new Set(["$schema", "$id", "$ref", "$defs", "definitions", "additionalProperties", "examples", "default", "const"]);
export function geminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    // properties 的键是参数名,不按关键字过滤
    if (k === "properties" && v && typeof v === "object")
      out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    else if (!DROP.has(k)) out[k] = geminiSchema(v);
  }
  return out;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

export function createGeminiProvider(config: ProviderConfig, popts: ProviderOptions = {}): ChatProvider {
  const o = resolveOptions(popts);
  const headers = () => buildHeaders(config, { "x-goog-api-key": config.apiKey });

  const streamEvents = async function* (messages: ChatMessage[], opts?: ChatStreamOptions): AsyncIterable<ProviderEvent> {
    const { system, turns } = splitSystem(messages);
    const p = config.params ?? {};
    const body: Record<string, unknown> = {
      contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })),
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const gen: Record<string, unknown> = {};
    if (typeof p.temperature === "number") gen.temperature = p.temperature;
    if (p.maxTokens && p.maxTokens > 0) gen.maxOutputTokens = p.maxTokens;
    if (p.reasoningEffort) gen.thinkingConfig = { thinkingBudget: EFFORT_BUDGET[p.reasoningEffort], includeThoughts: true };
    if (Object.keys(gen).length) body.generationConfig = gen;
    if (opts?.tools?.length) {
      body.tools = [
        { functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) },
      ];
    }
    const url = buildUrl(base(config.baseUrl), `/models/${encodeURIComponent(config.model)}:streamGenerateContent`, config.query, { alt: "sse" });
    const res = await openWithRetry(
      () => fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: opts?.signal ?? null }),
      { ...o, apiKey: config.apiKey, signal: opts?.signal },
    );

    let usage: TokenUsage | null = null;
    let finish: string | null = null;
    let calls = 0;
    for await (const line of readLines(res.body, o.idleTimeoutMs)) {
      const d = sseData(line);
      if (!d || "done" in d) continue;
      const obj = d.json as {
        error?: { code?: number; message?: string };
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { id?: string; name?: string; args?: unknown } }> };
          finishReason?: string;
        }>;
        usageMetadata?: Record<string, unknown>;
      } | null;
      if (!obj || typeof obj !== "object") continue;
      if (obj.error) {
        const { detail } = errorDetail(JSON.stringify({ error: obj.error }), config.apiKey);
        throw new ProviderError(`模型服务在生成中返回错误${detail ? `(${detail})` : ""}`, { status: n(obj.error.code) });
      }
      const c = obj.candidates?.[0];
      for (const part of c?.content?.parts ?? []) {
        if (part.functionCall?.name) {
          const id = part.functionCall.id || `call_${calls}`;
          const args = JSON.stringify(part.functionCall.args ?? {});
          yield { type: "tool_start", id, index: calls, name: part.functionCall.name };
          yield { type: "tool_args", id, delta: args };
          yield { type: "tool_end", id, args };
          calls += 1;
        } else if (typeof part.text === "string" && part.text) {
          yield part.thought ? { type: "thinking", delta: part.text } : { type: "text", delta: part.text };
        }
      }
      if (c?.finishReason) finish = calls ? "tool_calls" : (STOP[c.finishReason] ?? c.finishReason.toLowerCase());
      const u = obj.usageMetadata;
      if (u) {
        const prompt = n(u.promptTokenCount);
        const thoughts = n(u.thoughtsTokenCount);
        const completion = n(u.candidatesTokenCount) + thoughts;
        usage = { promptTokens: prompt, completionTokens: completion, totalTokens: n(u.totalTokenCount) || prompt + completion };
        if (n(u.cachedContentTokenCount)) usage.cachedTokens = n(u.cachedContentTokenCount);
        if (thoughts) usage.reasoningTokens = thoughts;
      }
    }
    if (usage) yield { type: "usage", usage };
    yield { type: "finish", reason: finish };
  };

  return {
    config,
    streamEvents,
    streamChat: textOnly(streamEvents),
    async listModels(signal) {
      const j = (await getJson(buildUrl(base(config.baseUrl), "/models", config.query, { pageSize: "1000" }), headers(), config.apiKey, signal)) as {
        models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>;
      };
      return (j.models ?? []).flatMap((m) =>
        typeof m.name === "string" && (!Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes("generateContent"))
          ? [m.name.replace(/^models\//, "")]
          : [],
      );
    },
  };
}
