import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withModel, type ProviderConfig } from "@xiyun/shared";
import { createProvider, ModelRegistry, type ChatProvider } from "@xiyun/runtime";

// L5:用量设置。日预算为 0 / 缺省表示不限制;currency 缺省 USD。
export interface AppSettings {
  dailyBudget?: number | null;
  currency?: string;
}

interface ConfigFile {
  providers: ProviderConfig[];
  activeProviderId?: string;
  settings?: AppSettings;
}

const MASK = "********";
const PROTOCOLS = new Set(["openai", "anthropic", "gemini"]);

// 附加请求头可能直接写了密钥:回显时掩码,引用 {apiKey} 占位的原样返回
const maskHeaders = (h?: Record<string, string>) =>
  h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.includes("{apiKey}") ? v : MASK])) : undefined;

// apiKey 只存在于本地配置文件,不得进入日志、会话或 API 响应。
export class ProviderStore {
  private file: string;
  private data: ConfigFile = { providers: [] };

  constructor(dataDir: string) {
    this.file = join(dataDir, "config.json");
    if (existsSync(this.file)) {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as ConfigFile;
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  listMasked(): Array<Omit<ProviderConfig, "apiKey"> & { apiKey: string; active: boolean }> {
    // 与 activeProvider() 同口径:activeProviderId 缺失时回退到列表第一项
    const activeId = this.data.providers.some((p) => p.id === this.data.activeProviderId)
      ? this.data.activeProviderId
      : this.data.providers[0]?.id;
    return this.data.providers.map((p) => ({
      ...p,
      apiKey: p.apiKey ? MASK : "",
      ...(p.headers ? { headers: maskHeaders(p.headers) } : {}),
      active: p.id === activeId,
    }));
  }

  upsert(p: ProviderConfig): void {
    const old = this.data.providers.find((x) => x.id === p.id);
    // 前端提交掩码或未填 key 时保留旧 key;掩码的附加头同理
    if (!p.apiKey || p.apiKey === MASK) p = { ...p, apiKey: old?.apiKey ?? "" };
    if (p.headers) {
      p = {
        ...p,
        headers: Object.fromEntries(
          Object.entries(p.headers)
            .filter(([k]) => k.trim())
            .map(([k, v]) => [k.trim(), v === MASK ? (old?.headers?.[k.trim()] ?? "") : v]),
        ),
      };
    }
    if (p.protocol && !PROTOCOLS.has(p.protocol)) p = { ...p, protocol: "openai" };
    const i = this.data.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) this.data.providers[i] = p;
    else this.data.providers.push(p);
    if (!this.data.activeProviderId) this.data.activeProviderId = p.id;
    this.save();
  }

  removeProvider(id: string): void {
    this.data.providers = this.data.providers.filter((x) => x.id !== id);
    if (this.data.activeProviderId === id) this.data.activeProviderId = this.data.providers[0]?.id;
    this.save();
  }

  setActive(id: string): void {
    this.data.activeProviderId = id;
    this.save();
  }

  activeProvider(): ChatProvider | undefined {
    const c = this.data.providers.find((x) => x.id === this.data.activeProviderId) ?? this.data.providers[0];
    return c ? createProvider(c) : undefined;
  }

  probeProvider(id: string, model?: string): ChatProvider | undefined {
    const c = this.data.providers.find((x) => x.id === id);
    return c ? createProvider(withModel(c, model)) : undefined;
  }

  // 会话级模型(M3):providerId 存在时用它(model 不在其列表里则用默认模型);否则回退全局激活
  resolve(providerId?: string | null, model?: string | null): ChatProvider | undefined {
    const c = providerId ? this.data.providers.find((x) => x.id === providerId) : undefined;
    return c ? createProvider(withModel(c, model)) : this.activeProvider();
  }

  registry(): ModelRegistry {
    const r = new ModelRegistry();
    for (const c of this.data.providers) r.register(createProvider(c));
    return r;
  }

  // L5:用量设置(日预算 / 计价货币)
  settings(): AppSettings {
    return { dailyBudget: this.data.settings?.dailyBudget ?? null, currency: this.data.settings?.currency || "USD" };
  }

  updateSettings(patch: AppSettings): AppSettings {
    const cur = this.data.settings ?? {};
    const next: AppSettings = { ...cur };
    if ("dailyBudget" in patch) {
      const v = patch.dailyBudget;
      // 负数与非法值视为不限制
      next.dailyBudget = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    }
    if ("currency" in patch && typeof patch.currency === "string" && patch.currency.trim())
      next.currency = patch.currency.trim().toUpperCase().slice(0, 8);
    this.data.settings = next;
    this.save();
    return this.settings();
  }

  // 全部已配置的 provider 原始配置(只读,供价格 / 降级计算)
  configs(): ProviderConfig[] {
    return this.data.providers;
  }
}
