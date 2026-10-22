import type { ChatMessage } from "@xiyun/shared";
import type { ChatProvider } from "@xiyun/runtime";
import type { MemoryStore } from "./memory.ts";
import { estimateTokens } from "@xiyun/shared";

export interface ExtractedItem {
  content: string;
  confidence?: number;
  reason?: string;
  action?: "add" | "supersede";
  targetId?: string;
  // L2:这条事实来自对话里的第几条消息(1 起,对应传入的 history 顺序)
  index?: number;
}

// 宽容解析模型输出:截取第一个 JSON 数组,忽略前后闲聊。
export function parseExtraction(text: string): ExtractedItem[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x): x is ExtractedItem => typeof x === "object" && x !== null && typeof (x as ExtractedItem).content === "string",
    );
  } catch {
    return [];
  }
}

const EXTRACT_PROMPT = `你是记忆提取器。从对话中提取值得长期记住的事实,只包括:用户偏好、学习进度、错题、明确的决定、用户说"记住"的内容。
不要提取闲聊、一次性问题或已在记忆中的内容。
每条消息前有 [序号];请为每条提取出的事实标注它来自哪条消息的序号(字段 "index")。
输出严格 JSON 数组,每项 {"content": "...", "confidence": 0.0-1.0, "reason": "为什么值得记", "index": 序号};没有值得记的输出 []。只输出 JSON。`;

// L2:长会话按约 6k tokens 分片,避免一次塞爆上下文
const CHUNK_TOKENS = 6_000;

export function chunkHistory(history: ChatMessage[], maxTokens = CHUNK_TOKENS): ChatMessage[][] {
  const out: ChatMessage[][] = [];
  let cur: ChatMessage[] = [];
  let used = 0;
  for (const m of history) {
    const cost = estimateTokens(m.content) + 8;
    if (cur.length && used + cost > maxTokens) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(m);
    used += cost;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface ExtractResult {
  added: number;
  // 每条新增记忆对应的原消息 id(按提取顺序)
  messageIds: number[];
}

// 异步提取:不阻塞主回复。失败只记事件,不抛出。
// L2:增加 scope / source / sourceKind;history 消息可带 id,用于 source_message_id 回链
export async function extractMemories(opts: {
  provider: ChatProvider;
  memory: MemoryStore;
  history: Array<ChatMessage & { id?: number }>;
  sessionId: string;
  mode: string;
  workspace: string;
  existingFacts: string[];
  scope?: string;
  sourceKind?: string;
}): Promise<number> {
  const r = await extractMemoriesDetailed(opts);
  return r.added;
}

export async function extractMemoriesDetailed(opts: {
  provider: ChatProvider;
  memory: MemoryStore;
  history: Array<ChatMessage & { id?: number }>;
  sessionId: string;
  mode: string;
  workspace: string;
  existingFacts: string[];
  scope?: string;
  sourceKind?: string;
}): Promise<ExtractResult> {
  const { provider, memory } = opts;
  if (opts.history.length === 0) return { added: 0, messageIds: [] };

  const chunks = chunkHistory(opts.history);
  const known = opts.existingFacts.slice(0, 20).map((f) => `- ${f}`).join("\n");
  let added = 0;
  const messageIds: number[] = [];
  let offset = 0;

  for (const chunk of chunks) {
    const transcript = chunk
      .map((m, i) => `[${offset + i + 1}] ${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 800)}`)
      .join("\n");
    let text = "";
    for await (const delta of provider.streamChat([
      { role: "system", content: EXTRACT_PROMPT },
      { role: "user", content: `${known ? `已有记忆:\n${known}\n\n` : ""}对话:\n${transcript}` },
    ])) {
      text += delta;
    }
    for (const it of parseExtraction(text)) {
      const srcMsg = typeof it.index === "number" ? chunk[it.index - offset - 1] : undefined;
      const messageId = srcMsg?.id;
      memory.addCandidate({
        content: it.content,
        reason: it.reason ?? "",
        confidence: it.confidence ?? 0.5,
        action: it.action === "supersede" ? "supersede" : "add",
        targetId: it.targetId,
        source: `extract:${opts.sessionId}`,
        sessionId: opts.sessionId,
        mode: opts.mode,
        workspace: opts.workspace,
        ...(messageId != null ? { sourceMessageId: messageId } : {}),
        ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
        ...(opts.scope ? { scope: opts.scope } : {}),
        sourceSessionId: opts.sessionId,
      });
      added += 1;
      if (messageId != null) messageIds.push(messageId);
    }
    offset += chunk.length;
  }
  return { added, messageIds };
}
