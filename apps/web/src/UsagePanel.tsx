import { useEffect, useState } from "react";
import type { UsageRow, UsageSummary } from "@xiyun/shared";
import { api } from "./api.ts";

// L5:用量账本。按日柱状图 + 明细表,可切换聚合维度与时间范围。

const GROUPS: Array<{ id: UsageSummary["groupBy"]; label: string }> = [
  { id: "day", label: "按天" },
  { id: "session", label: "按会话" },
  { id: "provider", label: "按服务商" },
  { id: "model", label: "按模型" },
];

const RANGES: Array<{ id: string; label: string; days: number | null }> = [
  { id: "7", label: "近 7 天", days: 7 },
  { id: "30", label: "近 30 天", days: 30 },
  { id: "all", label: "全部", days: null },
];

const dayOf = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
};

const fmtMoney = (n: number, currency: string) =>
  `${currency === "USD" ? "$" : ""}${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}${currency === "USD" ? "" : ` ${currency}`}`;

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Bars({ rows, max }: { rows: UsageRow[]; max: number }) {
  if (!rows.length) return <p className="usage-empty">还没有用量记录。</p>;
  return (
    <div className="usage-bars">
      {rows.map((r) => (
        <div key={r.key} className="bar" title={`${r.label}:${fmtTokens(r.totalTokens)} tokens`}>
          <div className="fill" style={{ height: `${max > 0 ? Math.max(2, (r.totalTokens / max) * 100) : 0}%` }} />
          <span className="tick">{r.label.length > 6 ? r.label.slice(5) : r.label}</span>
        </div>
      ))}
    </div>
  );
}

export function UsagePanel() {
  const [groupBy, setGroupBy] = useState<UsageSummary["groupBy"]>("day");
  const [range, setRange] = useState("30");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const days = RANGES.find((r) => r.id === range)?.days ?? null;
    const from = days ? dayOf(days - 1) : undefined;
    let alive = true;
    void api
      .usage(groupBy, from ? { from } : {})
      .then((d) => alive && (setData(d), setError("")))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [groupBy, range]);

  const rows = data?.rows ?? [];
  const max = rows.reduce((m, r) => Math.max(m, r.totalTokens), 0);
  const budget = data?.budget ?? null;
  const spent = data?.spentToday ?? 0;

  return (
    <div className="usage-panel">
      <div className="usage-controls">
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as UsageSummary["groupBy"])}>
          {GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
        </select>
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </div>
      {error && <p className="usage-error">{error}</p>}
      {budget != null && (
        <div className={`usage-budget${spent >= budget ? " over" : ""}`}>
          今日 {fmtMoney(spent, data?.currency ?? "USD")} / 预算 {fmtMoney(budget, data?.currency ?? "USD")}
          <div className="meter"><i style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} /></div>
        </div>
      )}
      {data && (
        <>
          <div className="usage-total">
            合计 {fmtTokens(data.total.totalTokens)} tokens · {fmtMoney(data.total.cost, data.currency)}
          </div>
          <Bars rows={rows} max={max} />
          <table className="usage-table">
            <thead>
              <tr><th>{GROUPS.find((g) => g.id === groupBy)?.label.replace("按", "")}</th><th>输入</th><th>输出</th><th>成本</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="k" title={r.key}>{r.label}</td>
                  <td>{fmtTokens(r.promptTokens)}</td>
                  <td>{fmtTokens(r.completionTokens)}</td>
                  <td>{r.cost > 0 ? fmtMoney(r.cost, data.currency) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
