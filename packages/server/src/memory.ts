import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Fact, MemoryCandidate } from "@xiyun/shared";

type FactRow = {
  id: string;
  content: string;
  source: string;
  confidence: number;
  scope: string;
  valid_from: string;
  valid_to: string | null;
  deleted_at: string | null;
  source_message_id: number | null;
  source_kind: string | null;
  source_session_id: string | null;
};

type CandidateRow = {
  id: string;
  content: string;
  reason: string;
  source: string;
  confidence: number;
  scope: string;
  session_id: string | null;
  mode: string;
  workspace: string;
  action: "add" | "supersede";
  target_id: string | null;
  status: "pending" | "confirmed" | "rejected";
  created_at: string;
  resolved_at: string | null;
  source_message_id: number | null;
  source_kind: string | null;
  source_session_id: string | null;
};

function toFact(r: FactRow): Fact {
  return {
    id: r.id,
    content: r.content,
    source: r.source,
    confidence: r.confidence,
    scope: r.scope,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    deletedAt: r.deleted_at,
    ...(r.source_message_id != null ? { sourceMessageId: r.source_message_id } : {}),
    ...(r.source_kind ? { sourceKind: r.source_kind } : {}),
    ...(r.source_session_id ? { sourceSessionId: r.source_session_id } : {}),
  };
}

function toCandidate(r: CandidateRow): MemoryCandidate {
  return {
    id: r.id,
    content: r.content,
    reason: r.reason,
    source: r.source,
    confidence: r.confidence,
    scope: r.scope,
    sessionId: r.session_id,
    mode: r.mode,
    workspace: r.workspace,
    action: r.action,
    targetId: r.target_id,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    ...(r.source_message_id != null ? { sourceMessageId: r.source_message_id } : {}),
    ...(r.source_kind ? { sourceKind: r.source_kind } : {}),
    ...(r.source_session_id ? { sourceSessionId: r.source_session_id } : {}),
  };
}

export class MemoryStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  addFact(
    content: string,
    opts: { source?: string; confidence?: number; scope?: string; sourceMessageId?: number; sourceKind?: string; sourceSessionId?: string } = {},
  ): Fact {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO facts (id, content, source, confidence, scope, valid_from, source_message_id, source_kind, source_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id, content, opts.source ?? "", opts.confidence ?? 0.5, opts.scope ?? "global", now,
        opts.sourceMessageId ?? null, opts.sourceKind ?? null, opts.sourceSessionId ?? null,
      );
    this.db.prepare("INSERT INTO facts_fts (id, content) VALUES (?, ?)").run(id, content);
    return this.get(id)!;
  }

  get(id: string): Fact | undefined {
    const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as FactRow | undefined;
    return row ? toFact(row) : undefined;
  }

  // 新事实不覆盖旧事实,而是结束旧事实的有效期(决策 D-004)。
  supersede(
    id: string,
    newContent: string,
    opts: { source?: string; confidence?: number; sourceMessageId?: number; sourceKind?: string; sourceSessionId?: string } = {},
  ): Fact {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE facts SET valid_to = ? WHERE id = ? AND valid_to IS NULL").run(now, id);
    const old = this.get(id);
    return this.addFact(newContent, {
      source: opts.source ?? old?.source ?? "",
      confidence: opts.confidence ?? old?.confidence ?? 0.5,
      scope: old?.scope ?? "global",
      ...(opts.sourceMessageId != null ? { sourceMessageId: opts.sourceMessageId } : {}),
      ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
      ...(opts.sourceSessionId ? { sourceSessionId: opts.sourceSessionId } : {}),
    });
  }

  // 软删除:检索不可见,数据保留。hard=true 为"彻底忘记"。
  remove(id: string, hard = false): void {
    if (hard) {
      this.db.prepare("DELETE FROM facts WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM facts_fts WHERE id = ?").run(id);
    } else {
      this.db.prepare("UPDATE facts SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      this.db.prepare("DELETE FROM facts_fts WHERE id = ?").run(id);
    }
  }

  private audit(type: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)")
      .run(type, JSON.stringify(payload), new Date().toISOString());
  }

  // ---- 阶段 2:候选记忆 ----

  addCandidate(c: {
    content: string;
    reason?: string;
    source?: string;
    confidence?: number;
    scope?: string;
    sessionId?: string;
    mode?: string;
    workspace?: string;
    action?: "add" | "supersede";
    targetId?: string;
    sourceMessageId?: number;
    sourceKind?: string;
    sourceSessionId?: string;
  }): MemoryCandidate {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO candidates (id, content, reason, source, confidence, scope, session_id, mode, workspace, action, target_id, created_at, source_message_id, source_kind, source_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, c.content, c.reason ?? "", c.source ?? "", c.confidence ?? 0.5, c.scope ?? "global",
        c.sessionId ?? null, c.mode ?? "chat", c.workspace ?? "", c.action ?? "add", c.targetId ?? null,
        new Date().toISOString(), c.sourceMessageId ?? null, c.sourceKind ?? null, c.sourceSessionId ?? null,
      );
    return this.getCandidate(id)!;
  }

  getCandidate(id: string): MemoryCandidate | undefined {
    const row = this.db.prepare("SELECT * FROM candidates WHERE id = ?").get(id) as CandidateRow | undefined;
    return row ? toCandidate(row) : undefined;
  }

  listCandidates(status?: MemoryCandidate["status"]): MemoryCandidate[] {
    const sql = `SELECT * FROM candidates ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC`;
    const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as CandidateRow[];
    return rows.map(toCandidate);
  }

  // 确认候选:成为事实(add)或结束旧事实有效期(supersede)。
  confirmCandidate(id: string): Fact {
    const c = this.getCandidate(id);
    if (!c) throw new Error(`candidate not found: ${id}`);
    if (c.status !== "pending") throw new Error(`candidate already ${c.status}`);
    // L2:把候选上的出处传给事实,记忆页才能"查看出处"
    const origin = {
      ...(c.sourceMessageId != null ? { sourceMessageId: c.sourceMessageId } : {}),
      ...(c.sourceKind ? { sourceKind: c.sourceKind } : {}),
      ...(c.sourceSessionId ? { sourceSessionId: c.sourceSessionId } : {}),
    };
    const fact =
      c.action === "supersede" && c.targetId
        ? this.supersede(c.targetId, c.content, { source: c.source, confidence: c.confidence, ...origin })
        : this.addFact(c.content, { source: c.source, confidence: c.confidence, scope: c.scope, ...origin });
    this.db
      .prepare("UPDATE candidates SET status = 'confirmed', resolved_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    this.audit("memory.confirm", { candidateId: id, factId: fact.id });
    return fact;
  }

  rejectCandidate(id: string): void {
    this.db
      .prepare("UPDATE candidates SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(new Date().toISOString(), id);
    this.audit("memory.reject", { candidateId: id });
  }

  // 彻底忘记:删原文、事实和索引,并写审计(决策 D-004、风险 R-004)。
  forget(id: string): void {
    this.remove(id, true);
    this.audit("memory.forget", { factId: id });
  }

  list(includeDeleted = false): Fact[] {
    const sql = `SELECT * FROM facts ${includeDeleted ? "" : "WHERE deleted_at IS NULL"} ORDER BY valid_from DESC`;
    return (this.db.prepare(sql).all() as FactRow[]).map(toFact);
  }

  // L2:按来源撤销(软删除)。返回撤销条数;硬删仍走单条的 forget。
  revokeBySource(sourceKind: string): number {
    const rows = this.db
      .prepare("SELECT id FROM facts WHERE source_kind = ? AND deleted_at IS NULL")
      .all(sourceKind) as Array<{ id: string }>;
    if (!rows.length) return 0;
    const ts = new Date().toISOString();
    const upd = this.db.prepare("UPDATE facts SET deleted_at = ? WHERE id = ?");
    const delFts = this.db.prepare("DELETE FROM facts_fts WHERE id = ?");
    for (const r of rows) {
      upd.run(ts, r.id);
      delFts.run(r.id);
    }
    this.audit("memory.revoke", { sourceKind, count: rows.length });
    return rows.length;
  }

  // 泛化提问兜底:无主题词时 FTS 召回为空,按时间返回最近的有效事实(如"我上次学到哪了")。
  recent(limit = 5, scopes?: string[]): Fact[] {
    const scopeIn = scopes && scopes.length > 0 ? `AND scope IN (${scopes.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL ${scopeIn} ORDER BY valid_from DESC LIMIT ?`,
      )
      .all(...(scopes ?? []), limit) as FactRow[];
    return rows.map(toFact);
  }

  // FTS5(trigram)检索:只返回当前有效且未删除的事实。
  // trigram 需要至少 3 个字符,短查询退化为 LIKE。
  // scopes 限制事实来源层级,如 ["global", "chat", "/project/path"]。
  // 长查询先整体短语精确匹配,无结果再退化为 3 字滑窗 OR(自然语言提问召回)。
  search(query: string, limit = 5, scopes?: string[]): Fact[] {
    const q = query.replace(/\s+/g, " ").trim();
    if (!q) return [];
    const scopeIn = scopes && scopes.length > 0 ? `AND scope IN (${scopes.map(() => "?").join(",")})` : "";
    const scopeArgs = scopes ?? [];
    if (q.length < 3) {
      const rows = this.db
        .prepare(
          `SELECT * FROM facts WHERE content LIKE ? AND deleted_at IS NULL AND valid_to IS NULL ${scopeIn} ORDER BY valid_from DESC LIMIT ?`,
        )
        .all(`%${q}%`, ...scopeArgs, limit) as FactRow[];
      return rows.map(toFact);
    }
    // 整体加引号作为短语匹配,避免用户文本中的 FTS5 语法字符(逗号、括号、引号)破坏 MATCH。
    const stmt = this.db.prepare(
      `SELECT f.* FROM facts_fts t JOIN facts f ON f.id = t.id
       WHERE facts_fts MATCH ? AND f.deleted_at IS NULL AND f.valid_to IS NULL ${scopeIn}
       ORDER BY rank LIMIT ?`,
    );
    const rows = stmt.all(`"${q.replace(/"/g, '""')}"`, ...scopeArgs, limit) as FactRow[];
    if (rows.length === 0 && q.length > 3) {
      const shingles = [...new Set(Array.from({ length: q.length - 2 }, (_, i) => q.slice(i, i + 3)))].slice(0, 50);
      const or = shingles.map((s) => `"${s.replace(/"/g, '""')}"`).join(" OR ");
      return (stmt.all(or, ...scopeArgs, limit) as FactRow[]).map(toFact);
    }
    return rows.map(toFact);
  }
}
