// ---- 从 ChatGPT / Claude 导入历史对话(M1 / D-023)----
// 只解析官方"导出数据"里的 conversations.json(ZIP 由前端解开)。
// 只取用户可见的 user / assistant 文本:系统提示、工具调用与结果、思考过程、隐藏消息都跳过。
// 原对话的分支(编辑 / 重新生成)按消息树保留(F6),当前分支作为 head。

export type ExternalSource = "chatgpt" | "claude";
export type ExternalMessage = { key: string; parentKey: string | null; role: "user" | "assistant"; content: string; createdAt: string };
export type ExternalConversation = {
  externalId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ExternalMessage[]; // 父消息一定排在子消息之前
  headKey: string | null;
};

export const EXTERNAL_ATTACHMENT_CHARS = 20_000; // Claude 附件里抽取出的文本,单个上限
export const UNKNOWN_FORMAT = "无法识别的导出文件:请选择 ChatGPT 或 Claude 导出数据里的 conversations.json(或整个 ZIP)";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const iso = (v: unknown, fallback: string): string => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return fallback;
};
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(已截断,原文 ${s.length} 字)` : s);

// 原始节点:role 为 null 表示不可见(跳过,但它的子节点接到最近的可见祖先上)
type Node = { key: string; parentKey: string | null; role: "user" | "assistant" | null; content: string; createdAt: string };

// 把原始节点整理成消息树:跳过不可见节点;同角色且是唯一子节点的连续消息合并
// (ChatGPT 一次回复中间夹工具调用时会拆成多条 assistant)
export function collapse(nodes: Node[], headKey: string | null): { messages: ExternalMessage[]; headKey: string | null } {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const visible = (n: Node) => n.role != null && n.content.trim() !== "";
  // 最近的可见祖先(防环)
  const effParent = (n: Node): string | null => {
    const seen = new Set<string>([n.key]);
    let p = n.parentKey;
    while (p != null && !seen.has(p)) {
      seen.add(p);
      const pn = byKey.get(p);
      if (!pn) return null;
      if (visible(pn)) return p;
      p = pn.parentKey;
    }
    return null;
  };
  const vis = nodes.filter(visible);
  const parentOf = new Map(vis.map((n) => [n.key, effParent(n)]));
  const children = new Map<string | null, Node[]>();
  for (const n of vis) {
    const p = parentOf.get(n.key) ?? null;
    children.set(p, [...(children.get(p) ?? []), n]);
  }
  for (const list of children.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const target = new Map<string, string>(); // 原 key -> 输出消息 key(合并后)
  const out = new Map<string, ExternalMessage>();
  const order: ExternalMessage[] = [];
  const queue: Array<string | null> = [null];
  const done = new Set<string | null>();
  while (queue.length) {
    const p = queue.shift()!;
    if (done.has(p)) continue;
    done.add(p);
    const kids = children.get(p) ?? [];
    for (const n of kids) {
      const pt = p == null ? null : (target.get(p) ?? null);
      const pm = pt == null ? undefined : out.get(pt);
      if (pm && pm.role === n.role && kids.length === 1) {
        pm.content = `${pm.content}\n\n${n.content.trim()}`;
        target.set(n.key, pm.key);
      } else {
        const m: ExternalMessage = { key: n.key, parentKey: pt, role: n.role!, content: n.content.trim(), createdAt: n.createdAt };
        out.set(n.key, m);
        order.push(m);
        target.set(n.key, n.key);
      }
      queue.push(n.key);
    }
  }
  let head: string | null = null;
  const hn = headKey == null ? undefined : byKey.get(headKey);
  if (hn) {
    const k = visible(hn) ? hn.key : effParent(hn);
    head = k == null ? null : (target.get(k) ?? null);
  }
  return { messages: order, headKey: head ?? order[order.length - 1]?.key ?? null };
}

// ChatGPT:mapping 是消息树,current_node 是当前分支末端
function chatgptText(content: unknown): string {
  if (!isObj(content)) return "";
  const type = str(content.content_type);
  if (type !== "text" && type !== "multimodal_text") return "";
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .map((p) => {
      if (typeof p === "string") return p;
      if (isObj(p)) {
        const t = str(p.content_type);
        if (t === "image_asset_pointer") return "[图片]";
        if (t.startsWith("audio")) return "";
        if (typeof p.text === "string") return p.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseChatgpt(c: Raw, i: number): ExternalConversation {
  const created = iso(c.create_time, new Date(0).toISOString());
  const mapping = isObj(c.mapping) ? c.mapping : {};
  const nodes: Node[] = [];
  for (const [key, raw] of Object.entries(mapping)) {
    if (!isObj(raw)) continue;
    const msg = isObj(raw.message) ? raw.message : null;
    const role = msg && isObj(msg.author) ? str(msg.author.role) : "";
    const meta = msg && isObj(msg.metadata) ? msg.metadata : {};
    const recipient = msg ? str(msg.recipient) || "all" : "all";
    const hidden = meta.is_visually_hidden_from_conversation === true || meta.is_user_system_message === true;
    const ok = msg && (role === "user" || role === "assistant") && recipient === "all" && !hidden;
    nodes.push({
      key,
      parentKey: typeof raw.parent === "string" ? raw.parent : null,
      role: ok ? (role as "user" | "assistant") : null,
      content: ok ? chatgptText(msg!.content) : "",
      createdAt: iso(msg?.create_time, created),
    });
  }
  const { messages, headKey } = collapse(nodes, typeof c.current_node === "string" ? c.current_node : null);
  return {
    externalId: str(c.conversation_id) || str(c.id) || `chatgpt-${created}-${i}`,
    title: str(c.title).trim() || "ChatGPT 对话",
    createdAt: created,
    updatedAt: iso(c.update_time, created),
    messages,
    headKey,
  };
}

// Claude:chat_messages 列表;新导出带 parent_message_uuid(可分支),旧导出按顺序成单链
const CLAUDE_ROOT = "00000000-0000-4000-8000-000000000000";
function claudeText(m: Raw): string {
  const blocks = Array.isArray(m.content) ? m.content.filter(isObj) : [];
  const texts = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => str(b.text));
  let text = texts.length ? texts.join("\n\n") : str(m.text);
  const atts = Array.isArray(m.attachments) ? m.attachments.filter(isObj) : [];
  for (const a of atts) {
    const body = str(a.extracted_content);
    text += `\n\n[附件:${str(a.file_name) || "未命名"}]${body ? `\n${cap(body, EXTERNAL_ATTACHMENT_CHARS)}` : ""}`;
  }
  const files = Array.isArray(m.files) ? m.files.filter(isObj) : [];
  for (const f of files) text += `\n\n[文件:${str(f.file_name) || "未命名"}]`;
  return text.trim();
}

function parseClaude(c: Raw, i: number): ExternalConversation {
  const created = iso(c.created_at, new Date(0).toISOString());
  const list = (Array.isArray(c.chat_messages) ? c.chat_messages : []).filter(isObj);
  const tree = list.some((m) => typeof m.parent_message_uuid === "string");
  const nodes: Node[] = list.map((m, j) => {
    const key = str(m.uuid) || `m${j}`;
    const sender = str(m.sender);
    const parent = tree
      ? (typeof m.parent_message_uuid === "string" && m.parent_message_uuid !== CLAUDE_ROOT ? m.parent_message_uuid : null)
      : j > 0 ? str(list[j - 1]!.uuid) || `m${j - 1}` : null;
    return {
      key,
      parentKey: parent,
      role: sender === "human" ? "user" : sender === "assistant" ? "assistant" : null,
      content: claudeText(m),
      createdAt: iso(m.created_at, created),
    };
  });
  const lastKey = nodes[nodes.length - 1]?.key ?? null;
  const { messages, headKey } = collapse(nodes, str(c.current_leaf_message_uuid) || lastKey);
  return {
    externalId: str(c.uuid) || `claude-${created}-${i}`,
    title: str(c.name).trim() || "Claude 对话",
    createdAt: created,
    updatedAt: iso(c.updated_at, created),
    messages,
    headKey,
  };
}

// 识别来源并解析;无法识别时抛错(UNKNOWN_FORMAT)
export function parseExternal(data: unknown): { source: ExternalSource; conversations: ExternalConversation[] } {
  const list = (Array.isArray(data) ? data : isObj(data) ? [data] : []).filter(isObj);
  if (!list.length) throw new Error(UNKNOWN_FORMAT);
  if (list.every((c) => isObj(c.mapping))) return { source: "chatgpt", conversations: list.map(parseChatgpt) };
  if (list.every((c) => Array.isArray(c.chat_messages))) return { source: "claude", conversations: list.map(parseClaude) };
  throw new Error(UNKNOWN_FORMAT);
}
