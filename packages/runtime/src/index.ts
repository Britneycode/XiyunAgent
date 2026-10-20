import type { ChatMessage, ModelRole, ProviderConfig } from "@xiyun/shared";

export interface ChatStreamOptions {
  signal?: AbortSignal;
}

// ChatProvider 是模型接入的统一接口。
// 决策 D-001 选定 Pi Runtime,但接入方式未定(见 NOW.md 待确认项);
// Pi 后续作为本接口的另一实现接入,上层不变。
export interface ChatProvider {
  config: ProviderConfig;
  streamChat(messages: ChatMessage[], opts?: ChatStreamOptions): AsyncIterable<string>;
}

export function createOpenAIProvider(config: ProviderConfig): ChatProvider {
  return {
    config,
    async *streamChat(messages, opts) {
      const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, messages, stream: true }),
        signal: opts?.signal ?? null,
      });
      if (!res.ok || !res.body) throw new Error(`Provider error: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta?.content;
            if (typeof delta === "string") yield delta;
          } catch {
            // SSE 分片不完整,跳过
          }
        }
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
