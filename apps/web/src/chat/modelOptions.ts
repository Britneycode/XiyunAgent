import { useEffect, useState } from "react";
import { modelsOf, type ProviderConfig, type ProviderProtocol } from "@xiyun/shared";
import { api } from "../api.ts";

// 模型下拉的一项 = 某个 Provider 下的某个模型(M3)
export interface ModelOption {
  key: string;
  providerId: string;
  providerName: string;
  protocol: ProviderProtocol;
  model: string;
  baseUrl: string;
  contextLength?: number;
  capabilities?: string[];
}

export const optionKey = (providerId: string, model: string) => `${providerId}\n${model}`;

export function toOptions(ps: Array<Omit<ProviderConfig, "apiKey">>): ModelOption[] {
  return ps.flatMap((p) =>
    modelsOf(p).map((m) => ({
      key: optionKey(p.id, m.id),
      providerId: p.id,
      providerName: p.name || "(未命名)",
      protocol: p.protocol ?? "openai",
      model: m.id,
      baseUrl: p.baseUrl,
      contextLength: m.contextLength,
      capabilities: m.capabilities,
    })),
  );
}

// 会话实际使用的模型:与服务端 /chat 同口径——会话指定的 Provider 存在则用它(模型不在列表里用默认模型),
// 否则跟随全局激活 Provider 的默认模型。followGlobal 表示会话未指定(或指定的已失效)
export function resolveOption(
  options: ModelOption[],
  globalId: string,
  sel: { providerId?: string | null; model?: string | null },
): { option: ModelOption | undefined; followGlobal: boolean } {
  const own = sel.providerId ? options.filter((o) => o.providerId === sel.providerId) : [];
  if (own.length) return { option: own.find((o) => o.model === sel.model) ?? own[0], followGlobal: false };
  return { option: options.find((o) => o.providerId === globalId) ?? options[0], followGlobal: true };
}

export function useModelOptions() {
  const [state, setState] = useState<{ options: ModelOption[]; globalId: string; loaded: boolean }>({
    options: [],
    globalId: "",
    loaded: false,
  });
  useEffect(() => {
    let alive = true;
    void api
      .providers()
      .then((ps) => {
        if (!alive) return;
        // 以服务端 active 为准,与实际生效的全局 Provider 保持一致
        setState({ options: toOptions(ps), globalId: ps.find((p) => p.active)?.id ?? ps[0]?.id ?? "", loaded: true });
      })
      .catch(() => alive && setState((s) => ({ ...s, loaded: true })));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
