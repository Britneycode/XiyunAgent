import { useEffect, useState } from "react";
import type { Fact, MemoryCandidate, MemoryJob } from "@xiyun/shared";
import { api } from "./api.ts";

export function MemoryPage({ onChanged, onOpenSource }: { onChanged: () => void; onOpenSource?: (sessionId: string, messageId?: number) => void }) {
  const [tab, setTab] = useState<"facts" | "candidates" | "jobs">("facts");
  const [facts, setFacts] = useState<Fact[]>([]);
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [jobs, setJobs] = useState<MemoryJob[]>([]);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("all");
  const [source, setSource] = useState("all");
  const [minConf, setMinConf] = useState(0);
  const [msg, setMsg] = useState("");

  const refresh = () => {
    void api.facts().then(setFacts);
    void api.candidates("pending").then(setCandidates);
    void api.memoryJobs().then(setJobs).catch(() => {});
  };
  useEffect(refresh, []);
  // 有进行中的作业时轮询进度;全部结束就停
  useEffect(() => {
    if (!jobs.some((j) => j.status === "running" || j.status === "queued")) return;
    const t = setInterval(() => {
      void api.memoryJobs().then((r) => {
        setJobs(r);
        if (!r.some((j) => j.status === "running" || j.status === "queued")) {
          void api.facts().then(setFacts);
          onChanged();
        }
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [jobs, onChanged]);

  const filtered = facts.filter((f) => {
    if (scope !== "all" && f.scope !== scope) return false;
    if (source !== "all" && (f.sourceKind ?? "") !== source) return false;
    if (f.confidence < minConf) return false;
    if (q && !f.content.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const scopes = [...new Set(facts.map((f) => f.scope))];
  // L2:来源分组(import:chatgpt / import:claude / extract:<sessionId> / 手动)
  const sources = [...new Set(facts.map((f) => f.sourceKind ?? "").filter(Boolean))];

  const confirmCand = async (id: string) => { await api.confirmCandidate(id); refresh(); onChanged(); };
  const rejectCand = async (id: string) => { await api.rejectCandidate(id); refresh(); onChanged(); };
  const forget = async (id: string) => {
    if (!window.confirm("彻底忘记会永久删除事实和索引,不可恢复。确认?")) return;
    await api.deleteFact(id, true); refresh(); onChanged();
  };

  // L2:撤销该来源的全部记忆。两次确认,避免误删。
  const revokeSource = async (kind: string) => {
    if (!window.confirm(`撤销来源「${kind}」的全部记忆?这些记忆会从检索中移除(可从备份恢复)。`)) return;
    if (!window.confirm(`再次确认:撤销「${kind}」的全部记忆。`)) return;
    const r = await api.revokeMemoryBySource(kind);
    setMsg(`已撤销 ${r.revoked} 条来自「${kind}」的记忆。`);
    refresh(); onChanged();
  };

  const jobAction = async (id: string, action: "pause" | "resume" | "cancel") => {
    await api.memoryJobAction(id, action);
    refresh();
  };

  return (
    <div className="memory">
      <div className="filters">
        <button className={tab === "facts" ? "primary" : ""} onClick={() => setTab("facts")}>事实({facts.length})</button>
        <button className={tab === "candidates" ? "primary" : ""} onClick={() => setTab("candidates")}>候选({candidates.length})</button>
        <button className={tab === "jobs" ? "primary" : ""} onClick={() => setTab("jobs")}>提取作业({jobs.length})</button>
        <input placeholder="搜索内容" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">全部范围</option>
          {scopes.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {sources.length > 0 && (
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">全部来源</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          置信度 ≥ {minConf.toFixed(1)}
          <input type="range" min={0} max={1} step={0.1} value={minConf} onChange={(e) => setMinConf(Number(e.target.value))} />
        </label>
      </div>

      {tab === "jobs" ? (
        jobs.length === 0 ? <p style={{ color: "var(--muted)" }}>还没有提取作业。从设置页导入 ChatGPT / Claude 历史时可以勾选「提取记忆」。</p> :
        jobs.map((j) => (
          <div className="fact" key={j.id}>
            <div>来源 {j.source} · {j.status} · {j.done}/{j.total}(失败 {j.failed})</div>
            <div className="meta">
              <span className="badge">{j.scope}</span>
              <span>创建于 {new Date(j.createdAt).toLocaleString()}</span>
              {j.error && <span style={{ color: "#d6453d" }}>{j.error}</span>}
            </div>
            <progress value={j.done} max={Math.max(1, j.total)} style={{ width: "100%", marginTop: 6 }} />
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              {(j.status === "running" || j.status === "queued") && <button onClick={() => void jobAction(j.id, "pause")}>暂停</button>}
              {j.status === "paused" && <button onClick={() => void jobAction(j.id, "resume")}>恢复</button>}
              {j.status !== "done" && j.status !== "cancelled" && <button onClick={() => void jobAction(j.id, "cancel")}>取消</button>}
            </div>
          </div>
        ))
      ) : tab === "candidates" ? (
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
        <>
          {source !== "all" && (
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="danger" onClick={() => void revokeSource(source)}>撤销该来源的全部记忆</button>
            </div>
          )}
          {filtered.length === 0 ? <p style={{ color: "var(--muted)" }}>没有匹配的事实。</p> :
          filtered.map((f) => (
            <div className="fact" key={f.id}>
              <div>{f.content}</div>
              <div className="meta">
                <span className="badge">{f.scope}</span>
                <span>置信度 {f.confidence.toFixed(2)}</span>
                <span>来源 {f.source || "手动"}</span>
                <span>{new Date(f.validFrom).toLocaleDateString()}</span>
                {f.validTo && <span style={{ color: "#d6453d" }}>已过期</span>}
                {f.sourceKind && <span>出处 {f.sourceKind}</span>}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                {f.sourceSessionId && onOpenSource && (
                  <button onClick={() => onOpenSource(f.sourceSessionId!, f.sourceMessageId)}>查看出处</button>
                )}
                <button onClick={() => void api.deleteFact(f.id).then(() => { refresh(); onChanged(); })}>删除</button>
                <button className="danger" onClick={() => void forget(f.id)}>彻底忘记</button>
              </div>
            </div>
          ))}
        </>
      )}
      {msg && <p className="tool-out" style={{ whiteSpace: "pre-wrap" }}>{msg}</p>}
    </div>
  );
}
