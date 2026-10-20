import type { ChatProvider } from "@xiyun/runtime";
import type { MemoryStore } from "./memory.ts";

// 自然语言记忆指令:用户明确说"记住/忘掉"时,立即执行增删,不等异步候选流水线。
// 只有消息含明显意图词才触发一次额外的小模型调用,避免每句聊天多花一次请求。
const INTENT_RE = /记住|记一下|帮我记|忘掉|忘记|别记|删除.{0,8}记忆|清除.{0,8}记忆/;

export type MemoryAction =
  | { action: "remember"; content: string }
  | { action: "forget"; query: string };

// 宽容解析:截取第一个 JSON 对象,忽略前后闲聊。
export function parseMemoryAction(text: string): MemoryAction | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (o.action === "remember" && typeof o.content === "string" && o.content.trim())
      return { action: "remember", content: o.content.trim() };
    if (o.action === "forget" && typeof o.query === "string" && o.query.trim())
      return { action: "forget", query: o.query.trim() };
    return null;
  } catch {
    return null;
  }
}

const INTENT_PROMPT = `判断用户是否在要求增删长期记忆。只输出严格 JSON:
- 要求记住:{"action":"remember","content":"要记的事实(陈述句)"}
- 要求忘掉/删除:{"action":"forget","query":"用于检索要删除记忆的关键词"}
- 其他一律:{"action":"none"}
只输出 JSON,不要解释。`;

// 返回给主对话的系统提示文本;无记忆意图返回 null。
export async function runMemoryTool(opts: {
  provider: ChatProvider;
  memory: MemoryStore;
  message: string;
  scopes: string[]; // 检索范围:global/模式/工作区
  scope: string; // 新记忆写入层级(当前模式)
}): Promise<string | null> {
  const { provider, memory, message, scopes, scope } = opts;
  if (!INTENT_RE.test(message)) return null;
  let text = "";
  for await (const d of provider.streamChat([
    { role: "system", content: INTENT_PROMPT },
    { role: "user", content: message },
  ])) {
    text += d;
  }
  const action = parseMemoryAction(text);
  if (!action) return null;

  if (action.action === "remember") {
    const fact = memory.addFact(action.content, { source: "chat:cmd", confidence: 0.9, scope });
    return `系统已执行记忆操作:新增记忆「${fact.content}」(id ${fact.id},scope=${fact.scope})。`;
  }
  // forget:检索命中的当前有效事实,软删除(检索不可见,可在记忆页彻底忘记)
  const hits = memory.search(action.query, 5, scopes);
  if (hits.length === 0) return `系统已执行记忆操作:没有找到与「${action.query}」相关的记忆。`;
  for (const f of hits) memory.remove(f.id);
  return `系统已执行记忆操作:已删除 ${hits.length} 条相关记忆:${hits.map((f) => `「${f.content}」`).join("、")}。`;
}
