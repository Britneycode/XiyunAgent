import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ModelPricing, TokenUsage, UsageRow, UsageSummary } from "@xiyun/shared";

// L5:成本账本。每条主对话回复与子任务执行各记一行,按天 / 会话 / 服务商 / 模型聚合。
// 价格单位为「每百万 tokens」;未定价的模型 cost 记 0,不参与成本对比但仍计 token。

const now = () => new Date().toISOString();

// 单次用量的成本:缓存命中部分按 cachedInput(缺省按 input),其余按 input,输出按 output。
export function costOf(usage: TokenUsage | null | undefined, pricing: ModelPricing | undefined): number {
  if (!usage || !pricing) return 0;
  const prompt = Math.max(0, usage.promptTokens || 0);
  const cached = Math.min(Math.max(0, usage.cachedTokens || 0), prompt);
  const fresh = prompt - cached;
  const completion = Math.max(0, usage.completionTokens || 0);
  const cachedPrice = pricing.cachedInput ?? pricing.input;
  const total = fresh * pricing.input + cached * cachedPrice + completion * pricing.output;
  return total / 1_000_000;
}

export interface UsageEntry {
  sessionId?: string | null;
  messageId?: number | null;
  taskId?: string | null;
  providerId?: string | null;
  model?: string | null;
  usage: TokenUsage | null | undefined;
  pricing?: ModelPricing;
  currency?: string;
}

export type UsageGroupBy = UsageSummary["groupBy"];

interface LedgerRow {
  key: string;
  label: string;
  prompt: number;
  completion: number;
  cached: number;
  total: number;
  cost: number;
}

const emptyRow = (key: string, label: string): UsageRow => ({
  key, label, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0,
});

export class UsageLedger {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  record(e: UsageEntry): void {
    if (!e.usage) return;
    const cost = costOf(e.usage, e.pricing);
    this.db
      .prepare(
        `INSERT INTO usage_ledger (id, at, session_id, message_id, task_id, provider_id, model, prompt, completion, cached, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(), now(),
        e.sessionId ?? null, e.messageId ?? null, e.taskId ?? null,
        e.providerId ?? null, e.model ?? null,
        e.usage.promptTokens || 0, e.usage.completionTokens || 0, e.usage.cachedTokens || 0, cost,
      );
  }

  // 某天(本地日期)起的累计花费,用于日预算判断
  spentToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    const r = this.db
      .prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM usage_ledger WHERE substr(at, 1, 10) = ?")
      .get(day) as { c: number } | undefined;
    return r?.c ?? 0;
  }

  // 聚合查询。from / to 为 ISO 日期(含端点),缺省不限。
  summary(groupBy: UsageGroupBy, from?: string, to?: string): { rows: UsageRow[]; total: UsageRow } {
    const where: string[] = [];
    const args: string[] = [];
    if (from) { where.push("substr(at, 1, 10) >= ?"); args.push(from.slice(0, 10)); }
    if (to) { where.push("substr(at, 1, 10) <= ?"); args.push(to.slice(0, 10)); }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const keyExpr = groupBy === "day" ? "substr(at, 1, 10)" : groupBy === "session" ? "COALESCE(session_id, '')"
      : groupBy === "provider" ? "COALESCE(provider_id, '')" : "COALESCE(model, '')";
    const raw = this.db
      .prepare(
        `SELECT ${keyExpr} AS key, SUM(prompt) AS prompt, SUM(completion) AS completion,
                SUM(cached) AS cached, SUM(cost) AS cost
         FROM usage_ledger${clause} GROUP BY key ORDER BY key`,
      )
      .all(...args) as unknown as LedgerRow[];

    const labels = this.sessionLabels(raw.filter((r) => groupBy === "session").map((r) => r.key));
    const rows = raw.map((r) => ({
      key: r.key,
      label: labelOf(groupBy, r.key, labels),
      promptTokens: r.prompt ?? 0,
      completionTokens: r.completion ?? 0,
      cachedTokens: r.cached ?? 0,
      totalTokens: (r.prompt ?? 0) + (r.completion ?? 0),
      cost: r.cost ?? 0,
    }));
    // 按天看时按时间正序(趋势);其余按花费从高到低,便于找大头
    if (groupBy !== "day") rows.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
    const total = rows.reduce(
      (acc, r) => ({
        ...acc,
        promptTokens: acc.promptTokens + r.promptTokens,
        completionTokens: acc.completionTokens + r.completionTokens,
        cachedTokens: acc.cachedTokens + r.cachedTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        cost: acc.cost + r.cost,
      }),
      emptyRow("total", "合计"),
    );
    return { rows, total };
  }

  private sessionLabels(ids: string[]): Map<string, string> {
    const map = new Map<string, string>();
    const list = ids.filter(Boolean);
    if (!list.length) return map;
    const stmt = this.db.prepare("SELECT id, title FROM sessions WHERE id = ?");
    for (const id of list) {
      const r = stmt.get(id) as { title: string } | undefined;
      map.set(id, r?.title || id);
    }
    return map;
  }
}

function labelOf(groupBy: UsageGroupBy, key: string, sessions: Map<string, string>): string {
  if (!key) return "(未知)";
  if (groupBy === "session") return sessions.get(key) ?? key;
  return key;
}

// 当前配置下最便宜的已定价模型,用于超出日预算时降级
export function cheapestPriced(
  candidates: Array<{ providerId: string; model: string; pricing?: ModelPricing }>,
): { providerId: string; model: string } | null {
  const priced = candidates.filter((c) => c.pricing);
  if (!priced.length) return null;
  const score = (p: ModelPricing) => p.input + p.output;
  const best = priced.reduce((a, b) => (score(a.pricing!) <= score(b.pricing!) ? a : b));
  return { providerId: best.providerId, model: best.model };
}
