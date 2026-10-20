import { useEffect, useState } from "react";
import type { Fact, MemoryCandidate } from "@xiyun/shared";
import { api } from "./api.ts";

export function MemoryPage({ onChanged }: { onChanged: () => void }) {
  const [tab, setTab] = useState<"facts" | "candidates">("facts");
  const [facts, setFacts] = useState<Fact[]>([]);
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("all");
  const [minConf, setMinConf] = useState(0);

  const refresh = () => {
    void api.facts().then(setFacts);
    void api.candidates("pending").then(setCandidates);
  };
  useEffect(refresh, []);

  const filtered = facts.filter((f) => {
    if (scope !== "all" && f.scope !== scope) return false;
    if (f.confidence < minConf) return false;
    if (q && !f.content.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const scopes = [...new Set(facts.map((f) => f.scope))];

  const confirmCand = async (id: string) => { await api.confirmCandidate(id); refresh(); onChanged(); };
  const rejectCand = async (id: string) => { await api.rejectCandidate(id); refresh(); onChanged(); };
  const forget = async (id: string) => {
    if (!window.confirm("彻底忘记会永久删除事实和索引,不可恢复。确认?")) return;
    await api.deleteFact(id, true); refresh(); onChanged();
  };

  return (
    <div className="memory">
      <div className="filters">
        <button className={tab === "facts" ? "primary" : ""} onClick={() => setTab("facts")}>事实({facts.length})</button>
        <button className={tab === "candidates" ? "primary" : ""} onClick={() => setTab("candidates")}>候选({candidates.length})</button>
        <input placeholder="搜索内容" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">全部范围</option>
          {scopes.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          置信度 ≥ {minConf.toFixed(1)}
          <input type="range" min={0} max={1} step={0.1} value={minConf} onChange={(e) => setMinConf(Number(e.target.value))} />
        </label>
      </div>

      {tab === "candidates" ? (
        candidates.length === 0 ? <p style={{ color: "var(--muted)" }}>暂无待确认候选。对话中产生的候选会自动出现在这里。</p> :
        candidates.map((c) => (
          <div className="fact" key={c.id}>
            <div>{c.content}</div>
            <div className="meta">
              <span className="badge">{c.scope}</span>
              <span>置信度 {c.confidence.toFixed(2)}</span>
              <span>{c.reason}</span>
              <span>{new Date(c.createdAt).toLocaleString()}</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="primary" onClick={() => void confirmCand(c.id)}>确认为事实</button>
              <button onClick={() => void rejectCand(c.id)}>拒绝</button>
            </div>
          </div>
        ))
      ) : (
        filtered.length === 0 ? <p style={{ color: "var(--muted)" }}>没有匹配的事实。</p> :
        filtered.map((f) => (
          <div className="fact" key={f.id}>
            <div>{f.content}</div>
            <div className="meta">
              <span className="badge">{f.scope}</span>
              <span>置信度 {f.confidence.toFixed(2)}</span>
              <span>来源 {f.source || "手动"}</span>
              <span>{new Date(f.validFrom).toLocaleDateString()}</span>
              {f.validTo && <span style={{ color: "#d6453d" }}>已过期</span>}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button onClick={() => void api.deleteFact(f.id).then(() => { refresh(); onChanged(); })}>删除</button>
              <button className="danger" onClick={() => void forget(f.id)}>彻底忘记</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
