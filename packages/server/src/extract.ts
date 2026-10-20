import type { ChatMessage } from "@xiyun/shared";
import type { ChatProvider } from "@xiyun/runtime";
import type { MemoryStore } from "./memory.ts";

export interface ExtractedItem {
  content: string;
  confidence?: number;
  reason?: string;
  action?: "add" | "supersede";
  targetId?: string;
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
输出严格 JSON 数组,每项 {"content": "...", "confidence": 0.0-1.0, "reason": "为什么值得记"};没有值得记的输出 []。只输出 JSON。`;

// 异步提取:不阻塞主回复。失败只记事件,不抛出。
export async function extractMemories(opts: {
  provider: ChatProvider;
  memory: MemoryStore;
  history: ChatMessage[];
  sessionId: string;
  mode: string;
  workspace: string;
  existingFacts: string[];
}): Promise<number> {
  const { provider, memory, history } = opts;
  if (history.length === 0) return 0;
  const transcript = history
    .slice(-12)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 800)}`)
    .join("\n");
  const known = opts.existingFacts.slice(0, 20).map((f) => `- ${f}`).join("\n");
  let text = "";
  for await (const delta of provider.streamChat([
    { role: "system", content: EXTRACT_PROMPT },
    { role: "user", content: `${known ? `已有记忆:\n${known}\n\n` : ""}对话:\n${transcript}` },
  ])) {
    text += delta;
  }
  const items = parseExtraction(text);
  for (const it of items) {
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
    });
  }
  return items.length;
}
