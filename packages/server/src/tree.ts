import type { DatabaseSync } from "node:sqlite";

// ---- 消息树(F6 / D-022)----
// 每条消息记父消息 parent_id,会话记当前分支末条 head_id。编辑 user 消息 = 在同一父消息下新增兄弟,
// 重新生成 = 在同一 user 消息下新增 assistant 兄弟,旧版本都保留,可在气泡上切换。
// 会话展示与发给模型的历史都是从 head 沿 parent 回溯到根的那条路径。
// head 为空且所有消息都没有 parent(迁移前的老数据、外部直接写入)时按 id 顺序视为单链。

export interface Tree {
  parent: Map<number, number | null>;
  children: Map<number | null, number[]>; // 按 id 升序;key null = 根消息
  head: number | null;
  linear: boolean;
  ids: number[]; // 全部消息 id,升序
}

export function loadTree(db: DatabaseSync, sessionId: string): Tree {
  const rows = db
    .prepare("SELECT id, parent_id FROM messages WHERE session_id = ? ORDER BY id")
    .all(sessionId) as Array<{ id: number; parent_id: number | null }>;
  const s = db.prepare("SELECT head_id FROM sessions WHERE id = ?").get(sessionId) as { head_id: number | null } | undefined;
  const parent = new Map<number, number | null>();
  const children = new Map<number | null, number[]>();
  for (const r of rows) {
    // 父消息不在本会话(被删 / 坏数据)时当作根
    parent.set(r.id, r.parent_id);
  }
  for (const r of rows) {
    const p = r.parent_id != null && parent.has(r.parent_id) ? r.parent_id : null;
    parent.set(r.id, p);
    const list = children.get(p);
    if (list) list.push(r.id);
    else children.set(p, [r.id]);
  }
  const ids = rows.map((r) => r.id);
  let head = s?.head_id ?? null;
  if (head != null && !parent.has(head)) head = null;
  const legacy = rows.every((r) => r.parent_id == null);
  // head 失效但已经是树:回退到最新一条消息所在的分支
  if (head == null && !legacy && ids.length) head = ids[ids.length - 1]!;
  return { parent, children, head, linear: head == null && ids.length > 0, ids };
}

// 从 id 回溯到根,返回根 → id 的路径
export function ancestors(tree: Tree, id: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let cur: number | null = id;
  while (cur != null && tree.parent.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = tree.parent.get(cur) ?? null;
  }
  return out.reverse();
}

// 当前分支路径(根 → head)
export function pathIds(tree: Tree): number[] {
  if (tree.linear) return tree.ids;
  return tree.head == null ? [] : ancestors(tree, tree.head);
}

// 同一父消息下的全部版本;只有一个时返回 undefined
export function siblingsOf(tree: Tree, id: number): number[] | undefined {
  if (tree.linear) return undefined;
  const list = tree.children.get(tree.parent.get(id) ?? null);
  return list && list.length > 1 ? list : undefined;
}

// 沿最新的子消息一直往下,得到以 id 为根的子树里最近的那条分支末端
export function latestLeaf(tree: Tree, id: number): number {
  let cur = id;
  for (;;) {
    const kids = tree.children.get(cur);
    if (!kids?.length) return cur;
    cur = kids[kids.length - 1]!;
  }
}

// 写入前调用:老数据(单链视图)就地补齐 parent_id 与 head_id,之后按树处理
export function ensureTree(db: DatabaseSync, sessionId: string): Tree {
  const tree = loadTree(db, sessionId);
  if (!tree.linear) return tree;
  const upd = db.prepare("UPDATE messages SET parent_id = ? WHERE id = ?");
  tree.ids.forEach((id, i) => upd.run(i === 0 ? null : tree.ids[i - 1]!, id));
  db.prepare("UPDATE sessions SET head_id = ? WHERE id = ?").run(tree.ids[tree.ids.length - 1]!, sessionId);
  return loadTree(db, sessionId);
}

export function setHeadId(db: DatabaseSync, sessionId: string, headId: number | null) {
  db.prepare("UPDATE sessions SET head_id = ? WHERE id = ?").run(headId, sessionId);
}

// 切换到包含 messageId 的分支:已在当前路径上则不变,否则落到它下面最近的分支末端。消息不存在返回 null
export function switchHead(db: DatabaseSync, sessionId: string, messageId: number): number | null {
  const tree = ensureTree(db, sessionId);
  if (!tree.parent.has(messageId)) return null;
  if (pathIds(tree).includes(messageId)) return tree.head;
  const head = latestLeaf(tree, messageId);
  setHeadId(db, sessionId, head);
  return head;
}
