import type { DatabaseSync } from "node:sqlite";
import type { SearchHit } from "@xiyun/shared";

// ---- 消息全文搜索(M7 / D-020)----
// trigram 索引要求每个词至少 3 个字符;有更短的词时退回 LIKE 子串匹配(小库足够快)。
// 片段高亮用 \u0001 / \u0002 包住命中词,前端再转成 <mark>,避免把 HTML 拼进响应。
export const HL_START = "\u0001";
export const HL_END = "\u0002";

export type { SearchHit };

type Row = {
  id: number; session_id: string; title: string; mode: string; workspace: string; s_created: string; s_updated: string | null;
  archived: number; role: string; created_at: string; snip?: string; content?: string;
};

const terms = (q: string) => q.trim().split(/\s+/).filter(Boolean).slice(0, 8);

// 手工片段:首个命中处前后各取一段,命中词加高亮标记
function likeSnippet(content: string, words: string[], radius = 30): string {
  const lower = content.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at - radius);
  const end = Math.min(content.length, (at < 0 ? 0 : at) + radius * 2);
  let text = content.slice(start, end).replace(/\s+/g, " ");
  for (const w of words) {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    text = text.replace(re, (m) => `${HL_START}${m}${HL_END}`);
  }
  return `${start > 0 ? "…" : ""}${text}${end < content.length ? "…" : ""}`;
}

export function searchMessages(
  db: DatabaseSync,
  q: string,
  opts: { mode?: string; limit?: number; includeArchived?: boolean } = {},
): SearchHit[] {
  const words = terms(q);
  if (!words.length) return [];
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const filters: string[] = ["m.role IN ('user', 'assistant')"];
  const args: Array<string | number> = [];
  if (opts.mode) {
    filters.push("s.mode = ?");
    args.push(opts.mode);
  }
  if (!opts.includeArchived) filters.push("s.archived = 0");
  let rows: Row[];
  if (words.every((w) => Array.from(w).length >= 3)) {
    // 每个词作为短语加引号,词之间 AND;引号转义防止 FTS 语法注入
    const match = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
    rows = db
      .prepare(
        `SELECT m.id, m.session_id, s.title, s.mode, s.workspace, s.created_at AS s_created, s.updated_at AS s_updated, s.archived, m.role, m.created_at,
                snippet(messages_fts, 0, '${HL_START}', '${HL_END}', '…', 40) AS snip
         FROM messages_fts f JOIN messages m ON m.id = f.rowid JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ? AND ${filters.join(" AND ")}
         ORDER BY bm25(messages_fts) LIMIT ?`,
      )
      .all(match, ...args, limit) as Row[];
  } else {
    const likes = words.map(() => "m.content LIKE ? ESCAPE '\\'");
    const likeArgs = words.map((w) => `%${w.replace(/[\\%_]/g, "\\$&")}%`);
    rows = db
      .prepare(
        `SELECT m.id, m.session_id, s.title, s.mode, s.workspace, s.created_at AS s_created, s.updated_at AS s_updated, s.archived, m.role, m.created_at, m.content
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE ${[...likes, ...filters].join(" AND ")}
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(...likeArgs, ...args, limit) as Row[];
  }
  return rows.map((r) => ({
    messageId: r.id,
    role: r.role as SearchHit["role"],
    createdAt: r.created_at,
    snippet: (r.snip ?? likeSnippet(r.content ?? "", words)).replace(/\s+/g, " ").trim(),
    // 带上完整会话信息:命中的会话可能不在前端已加载的分页里,点击时直接用它打开
    session: {
      id: r.session_id, title: r.title, mode: r.mode, workspace: r.workspace,
      createdAt: r.s_created, updatedAt: r.s_updated || r.s_created, archived: Number(r.archived) === 1,
    },
  }));
}
