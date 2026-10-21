import type { ModelInfo, ProviderConfig, ProviderProtocol } from "@xiyun/shared";

// 设置页 Provider 表单的纯函数(M2):模型列表 / 附加头 / 查询参数的文本 <-> 配置互转,以及常用服务商预设。

export const PROTOCOL_OPTIONS: Array<{ id: ProviderProtocol; label: string; placeholder: string }> = [
  { id: "openai", label: "OpenAI 兼容", placeholder: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic", placeholder: "https://api.anthropic.com" },
  { id: "gemini", label: "Gemini", placeholder: "https://generativelanguage.googleapis.com/v1beta" },
];

export interface Preset {
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export const PRESETS: Preset[] = [
  { name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  { name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  { name: "Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  { name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  {
    name: "Azure OpenAI",
    protocol: "openai",
    baseUrl: "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
    headers: { "api-key": "{apiKey}" },
    query: { "api-version": "2024-10-21" },
  },
  { name: "Ollama(本地)", protocol: "openai", baseUrl: "http://127.0.0.1:11434/v1" },
];

const CAPS = new Set(["stream", "tools", "vision", "json"]);
const CTX_RE = /^(\d+(?:\.\d+)?)([km]?)$/i;

// 每行一个模型:`模型id [上下文] [能力...]`,如 `gpt-4o 128k vision tools`;上下文 k=千、m=百万
export function parseModelLines(text: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const [id, ...rest] = line.trim().split(/\s+/);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const m: ModelInfo = { id };
    const caps: string[] = [];
    for (const t of rest) {
      const ctx = CTX_RE.exec(t);
      if (ctx) {
        const unit = ctx[2]!.toLowerCase();
        m.contextLength = Math.round(Number(ctx[1]) * (unit === "k" ? 1000 : unit === "m" ? 1_000_000 : 1));
      } else if (CAPS.has(t.toLowerCase())) caps.push(t.toLowerCase());
    }
    if (caps.length) m.capabilities = caps;
    out.push(m);
  }
  return out;
}

const fmtCtx = (n: number) => (n % 1_000_000 === 0 ? `${n / 1_000_000}m` : n % 1000 === 0 ? `${n / 1000}k` : String(n));

export function formatModelLines(models: ModelInfo[] | undefined): string {
  return (models ?? [])
    .map((m) => [m.id, m.contextLength ? fmtCtx(m.contextLength) : "", ...(m.capabilities ?? [])].filter(Boolean).join(" "))
    .join("\n");
}

// 键值对:请求头 `Name: value`,查询参数 `key=value`;按第一个分隔符切分,空键忽略
export function parseKV(text: string, sep: ":" | "="): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function formatKV(obj: Record<string, string> | undefined, sep: ":" | "="): string {
  return Object.entries(obj ?? {})
    .map(([k, v]) => (sep === ":" ? `${k}: ${v}` : `${k}=${v}`))
    .join("\n");
}

// 把拉取到的模型 id 合并进文本(已有的保留原设置,新的追加在末尾)
export function mergeModelIds(text: string, ids: string[]): { text: string; added: number } {
  const have = new Set(parseModelLines(text).map((m) => m.id));
  const fresh = ids.filter((id) => id && !have.has(id));
  const base = text.trimEnd();
  return { text: [base, ...fresh].filter(Boolean).join("\n"), added: fresh.length };
}

export interface ProviderForm {
  draft: ProviderConfig;
  modelsText: string;
  headersText: string;
  queryText: string;
}

export const emptyForm = (): ProviderForm => ({
  draft: { id: "", name: "", baseUrl: "", apiKey: "", protocol: "openai", model: "", roles: ["main"], capabilities: ["stream"] },
  modelsText: "",
  headersText: "",
  queryText: "",
});

export function formFrom(p: ProviderConfig & { active?: boolean }): ProviderForm {
  // active 是列表接口附带的展示字段,不写回配置
  const { active: _active, ...rest } = p;
  void _active;
  return {
    draft: { ...rest, apiKey: "", protocol: p.protocol ?? "openai" },
    modelsText: formatModelLines(p.models),
    headersText: formatKV(p.headers, ":"),
    queryText: formatKV(p.query, "="),
  };
}

export function applyPreset(f: ProviderForm, preset: Preset): ProviderForm {
  return {
    ...f,
    draft: {
      ...f.draft,
      name: f.draft.name || preset.name,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: f.draft.model || preset.model || "",
    },
    headersText: formatKV(preset.headers, ":"),
    queryText: formatKV(preset.query, "="),
  };
}

// 表单 -> 提交给 POST /providers 的配置;空的可选项不写入
export function toConfig(f: ProviderForm): ProviderConfig {
  const models = parseModelLines(f.modelsText);
  const headers = parseKV(f.headersText, ":");
  const query = parseKV(f.queryText, "=");
  const params = Object.fromEntries(Object.entries(f.draft.params ?? {}).filter(([, v]) => v !== undefined && v !== ""));
  const { models: _m, headers: _h, query: _q, params: _p, ...rest } = f.draft;
  void _m;
  void _h;
  void _q;
  void _p;
  return {
    ...rest,
    id: f.draft.id || crypto.randomUUID(),
    // 未填默认模型时取列表第一项
    model: f.draft.model.trim() || models[0]?.id || "",
    ...(models.length ? { models } : {}),
    ...(headers ? { headers } : {}),
    ...(query ? { query } : {}),
    ...(Object.keys(params).length ? { params } : {}),
  };
}
