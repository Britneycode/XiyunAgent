import type { ChatMessage, ModelRole, ProviderConfig } from "@xiyun/shared";

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
  | { type: "finish"; reason: string | null };

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

export function createOpenAIProvider(config: ProviderConfig): ChatProvider {
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
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: opts?.signal ?? null,
    });
    if (!res.ok || !res.body) throw new Error(`Provider error: HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const calls = new Map<number, CallState>();
    let buf = "";
    let stop = false;
    let finishReason: string | null = null;

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
        choices?: Array<{
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
      const choice = obj.choices?.[0];
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
      const { done: readerDone, value } = await reader.read();
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
