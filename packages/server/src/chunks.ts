import type { DatabaseSync } from "node:sqlite";

// ---- F8:文档分块与 BM25 检索(D-026)----
// 按段落累积到约 800 字符,相邻块重叠 100 字符;查询词 ≥3 字符走 FTS5 trigram + bm25,
// 更短的词退回 LIKE(FTS5 trigram 无法匹配 2 字以下的片段)。

export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 100;

export interface Chunk {
  ord: number;
  start: number;
  end: number;
  text: string;
}

// 按段落切分:先按空行分段,超长段再按长度硬切。
// 重叠只作用于块之间,保证跨段的句子能被邻块命中。
export function splitChunks(content: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): Chunk[] {
  const text = content ?? "";
  if (!text.trim()) return [];
  const paras: Array<{ start: number; end: number }> = [];
  const re = /\n\s*\n/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    paras.push({ start: last, end: m.index });
    last = m.index + m[0].length;
  }
  if (last < text.length) paras.push({ start: last, end: text.length });

  const out: Chunk[] = [];
  let cur: { start: number; end: number } | null = null;
  const flush = () => {
    if (!cur) return;
    out.push({ ord: out.length, start: cur.start, end: cur.end, text: text.slice(cur.start, cur.end) });
    cur = null;
  };

  for (const p of paras) {
    const len = p.end - p.start;
    if (cur && p.end - cur.start > size) flush();
    if (len > size) {
      // 超长段落硬切
      let s = p.start;
      while (s < p.end) {
        const e = Math.min(p.end, s + size);
        out.push({ ord: out.length, start: s, end: e, text: text.slice(s, e) });
        if (e >= p.end) break;
        s = Math.max(s + 1, e - overlap);
      }
      continue;
    }
    if (!cur) cur = { start: p.start, end: p.end };
    else cur.end = p.end;
  }
  flush();

  // 相邻块之间补上重叠:把后一块的起点前移,让跨界内容能被前一块命中
  if (overlap > 0 && out.length > 1) {
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]!;
      const c = out[i]!;
      const start = Math.max(prev.start + 1, c.start - overlap);
      if (start < c.start) out[i] = { ord: c.ord, start, end: c.end, text: text.slice(start, c.end) };
    }
  }
  return out;
}

export interface ChunkHit {
  docId: string;
  ord: number;
  start: number;
  end: number;
  snippet: string;
  // 命中块的完整原文(Work 模式注入用,不做截断)
  text: string;
  score: number;
}

export class ChunkStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // 重建某文档的分块(导入或更新文档时调用)
  rebuild(docId: string, content: string): number {
    this.db.prepare("DELETE FROM doc_chunks WHERE doc_id = ?").run(docId);
    const chunks = splitChunks(content);
    const ins = this.db.prepare("INSERT INTO doc_chunks (doc_id, ord, start, end, text) VALUES (?, ?, ?, ?, ?)");
    for (const c of chunks) ins.run(docId, c.ord, c.start, c.end, c.text);
    return chunks.length;
  }

  remove(docId: string): void {
    this.db.prepare("DELETE FROM doc_chunks WHERE doc_id = ?").run(docId);
  }

  // 启动时给缺块的老文档补建;可重复执行
  backfill(): number {
    const rows = this.db
      .prepare("SELECT d.id, d.content FROM docs d WHERE NOT EXISTS (SELECT 1 FROM doc_chunks c WHERE c.doc_id = d.id)")
      .all() as Array<{ id: string; content: string }>;
    for (const r of rows) this.rebuild(r.id, r.content);
    return rows.length;
  }

  count(docId: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM doc_chunks WHERE doc_id = ?").get(docId) as { c: number }).c;
  }

  // 检索:每个词加引号转义,用 OR 连接,按 bm25 排序;每篇文档只取得分最高的块。
  // 整句提问(没有空格的长串)拼不出短语时,退化为 3 字滑窗 OR,和旧的 LIKE 兜底一致。
  search(query: string, limit = 3, workspace?: string): ChunkHit[] {
    const words = query.trim().split(/\s+/).filter((w) => w.length >= 3);
    if (!words.length) return this.searchLike(query, limit, workspace);
    const hit = this.match(words, limit, workspace);
    if (hit.length) return hit;
    // 兜底:整句无命中时按 3 字滑窗再试一次
    if (words.length === 1 && words[0].length > 6) {
      const shingles = [...new Set(Array.from({ length: words[0].length - 2 }, (_, i) => words[0].slice(i, i + 3)))].slice(0, 50);
      const again = this.match(shingles, limit, workspace);
      if (again.length) return again;
    }
    return [];
  }

  // 按词表做一次 MATCH 查询
  private match(words: string[], limit: number, workspace?: string): ChunkHit[] {
    // 每个词加双引号(内部双引号转义为两个),OR 连接
    const match = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
    const wsIn = workspace ? " AND d.workspace = ?" : "";
    const args = workspace ? [match, workspace] : [match];
    let rows: Array<{ doc_id: string; ord: number; start: number; end: number; text: string; score: number }>;
    try {
      rows = this.db
        .prepare(
          `SELECT c.doc_id, c.ord, c.start, c.end, c.text, bm25(doc_chunks_fts) AS score
           FROM doc_chunks_fts f
           JOIN doc_chunks c ON c.id = f.rowid
           JOIN docs d ON d.id = c.doc_id
           WHERE doc_chunks_fts MATCH ?${wsIn}
           ORDER BY score
           LIMIT ?`,
        )
        .all(...args, limit * 8) as typeof rows;
    } catch {
      // 查询语法异常时退回 LIKE
      return this.searchLike(words[0] ?? "", limit, workspace);
    }
    // 每篇文档只保留得分最高的块(bm25 越小越相关)
    const seen = new Set<string>();
    const out: ChunkHit[] = [];
    for (const r of rows) {
      if (seen.has(r.doc_id)) continue;
      seen.add(r.doc_id);
      out.push({
        docId: r.doc_id, ord: r.ord, start: r.start, end: r.end,
        snippet: highlight(r.text, words), text: r.text, score: r.score,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // 短查询退回 LIKE
  private searchLike(query: string, limit: number, workspace?: string): ChunkHit[] {
    const q = query.trim();
    if (!q) return [];
    const wsIn = workspace ? " AND d.workspace = ?" : "";
    const args = workspace ? [`%${q}%`, workspace] : [`%${q}%`];
    const rows = this.db
      .prepare(
        `SELECT c.doc_id, c.ord, c.start, c.end, c.text
         FROM doc_chunks c JOIN docs d ON d.id = c.doc_id
         WHERE c.text LIKE ?${wsIn}
         ORDER BY c.doc_id, c.ord
         LIMIT ?`,
      )
      .all(...args, limit * 8) as Array<{ doc_id: string; ord: number; start: number; end: number; text: string }>;
    const seen = new Set<string>();
    const out: ChunkHit[] = [];
    for (const r of rows) {
      if (seen.has(r.doc_id)) continue;
      seen.add(r.doc_id);
      out.push({ docId: r.doc_id, ord: r.ord, start: r.start, end: r.end, snippet: highlight(r.text, [q]), text: r.text, score: 0 });
      if (out.length >= limit) break;
    }
    return out;
  }
}

// 片段前后各留一点上下文;命中词用 \u0001 / \u0002 包住,前端拆成 <mark>。
// 相邻或重叠的命中合并成一段,3 字滑窗兜底时不会把词切碎。
export function highlight(text: string, words: string[], radius = 60): string {
  const lower = text.toLowerCase();
  const ranges: Array<{ s: number; e: number }> = [];
  for (const w of words) {
    if (!w) continue;
    const wl = w.toLowerCase();
    let i = lower.indexOf(wl);
    while (i >= 0) {
      ranges.push({ s: i, e: i + w.length });
      i = lower.indexOf(wl, i + 1);
    }
  }
  if (!ranges.length) {
    const s = text.slice(0, radius * 2).replace(/\s+/g, " ").trim();
    return `${s}${text.length > radius * 2 ? "…" : ""}`;
  }
  ranges.sort((a, b) => a.s - b.s);
  const merged: Array<{ s: number; e: number }> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else merged.push({ ...r });
  }
  const from = Math.max(0, merged[0].s - radius);
  const to = Math.min(text.length, merged[merged.length - 1].e + radius);
  let out = "";
  let cur = from;
  for (const r of merged) {
    if (r.s < from || r.e > to) continue;
    out += text.slice(cur, r.s);
    out += `\u0001${text.slice(r.s, r.e)}\u0002`;
    cur = r.e;
  }
  out += text.slice(cur, to);
  const s = out.replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${s}${to < text.length ? "…" : ""}`;
}
