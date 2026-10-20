import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderConfig } from "@xiyun/shared";
import { createOpenAIProvider, ModelRegistry, type ChatProvider } from "@xiyun/runtime";

interface ConfigFile {
  providers: ProviderConfig[];
  activeProviderId?: string;
}

const MASK = "********";

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

  listMasked(): Array<Omit<ProviderConfig, "apiKey"> & { apiKey: string }> {
    return this.data.providers.map((p) => ({ ...p, apiKey: p.apiKey ? MASK : "" }));
  }

  upsert(p: ProviderConfig): void {
    // 前端提交掩码或未填 key 时保留旧 key
    if (!p.apiKey || p.apiKey === MASK) {
      p = { ...p, apiKey: this.data.providers.find((x) => x.id === p.id)?.apiKey ?? "" };
    }
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
    return c ? createOpenAIProvider(c) : undefined;
  }

  probeProvider(id: string): ChatProvider | undefined {
    const c = this.data.providers.find((x) => x.id === id);
    return c ? createOpenAIProvider(c) : undefined;
  }

  registry(): ModelRegistry {
    const r = new ModelRegistry();
    for (const c of this.data.providers) r.register(createOpenAIProvider(c));
    return r;
  }
}
