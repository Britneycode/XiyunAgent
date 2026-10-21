// 未发送草稿(F5):按会话存 localStorage,切换会话 / 刷新 / 重启后恢复。发送后清除。
// 只保留最近 30 个会话的草稿,避免无限增长。
export interface Draft<R = unknown> {
  text: string;
  refs: R[];
  t: number; // 最近修改时间,用于淘汰
}

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const DRAFTS_KEY = "xiyun.drafts";
const MAX_DRAFTS = 30;

const local = (): KV | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // 隐私模式等禁用存储的环境
  }
};

export function readDrafts(store: KV | undefined = local()): Record<string, Draft> {
  try {
    const raw = store?.getItem(DRAFTS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, Draft> = {};
    for (const [id, d] of Object.entries(v as Record<string, Partial<Draft>>)) {
      if (d && typeof d.text === "string") out[id] = { text: d.text, refs: Array.isArray(d.refs) ? d.refs : [], t: Number(d.t) || 0 };
    }
    return out;
  } catch {
    return {};
  }
}

export function loadDraft(sessionId: string, store: KV | undefined = local()): Draft | null {
  return readDrafts(store)[sessionId] ?? null;
}

// 文本和引用都为空时删除该会话的草稿
export function saveDraft(
  sessionId: string,
  draft: { text: string; refs: unknown[] },
  store: KV | undefined = local(),
  now = Date.now(),
): void {
  if (!store) return;
  const all = readDrafts(store);
  const empty = !draft.text.trim() && draft.refs.length === 0;
  if (empty) {
    if (!(sessionId in all)) return;
    delete all[sessionId];
  } else {
    const prev = all[sessionId];
    if (prev && prev.text === draft.text && JSON.stringify(prev.refs) === JSON.stringify(draft.refs)) return;
    all[sessionId] = { text: draft.text, refs: draft.refs, t: now };
  }
  const kept = Object.entries(all)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, MAX_DRAFTS);
  try {
    if (kept.length === 0) store.removeItem(DRAFTS_KEY);
    else store.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // 配额满时放弃保存,不影响输入
  }
}
