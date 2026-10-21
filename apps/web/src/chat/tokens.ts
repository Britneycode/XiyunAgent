import { estimateTokens, type TokenUsage } from "@xiyun/shared";
import type { UIMessage } from "./useChatStream.ts";

// Token 计数分两层:
// 1. 实测:模型在流末返回 usage(服务端经 SSE 下发并随消息落库),以此为基线;
// 2. 估算:基线之后新增的内容(新消息、引用、当前输入),以及模型不返回 usage 时的全部内容。
// 估算经验值:CJK 字符约 1 token/字;其余字符(英文、代码、空白、标点)约 4 字符/token。界面以 "≈" 标注估算值。
// 估算函数与服务端上下文预算(F4)共用同一实现
export { estimateTokens };

// 每条消息的角色与分隔符开销(OpenAI chat 格式约 3–4 token)
export const MESSAGE_OVERHEAD = 4;

// 历史消息正文:流式块模式下 content 可能为空,回退到文本块拼接
function messageText(m: UIMessage): string {
  if (m.content) return m.content;
  return (m.blocks ?? [])
    .map((b) => (b.kind === "text" ? b.text : ""))
    .join("");
}

// 消息对象在更新时整体替换,按对象缓存即可跳过未变化的历史消息
const cache = new WeakMap<UIMessage, number>();

export function messageTokens(m: UIMessage): number {
  let n = cache.get(m);
  if (n === undefined) {
    n = estimateTokens(messageText(m)) + MESSAGE_OVERHEAD;
    cache.set(m, n);
  }
  return n;
}

export function historyTokens(messages: UIMessage[]): number {
  let sum = 0;
  for (const m of messages) sum += messageTokens(m);
  return sum;
}

// 980 → "980";1234 → "1.2k";12345 → "12k";1_250_000 → "1.3M"
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// 下一轮会随历史再次带入的部分:上一轮输入 + 输出;推理内容不回传给模型,扣除
export function carriedTokens(u: TokenUsage): number {
  return u.promptTokens + Math.max(0, u.completionTokens - (u.reasoningTokens ?? 0));
}

export interface SessionUsage {
  prompt: number;
  completion: number;
  cached: number;
  turns: number; // 带实测用量的回复数
}

export interface ContextBaseline {
  usage: TokenUsage | null; // 最近一次实测用量;null = 当前会话没有任何实测
  carried: number; // 基线:usage 存在时为 carriedTokens(usage),否则为 0
  pending: number; // 基线之后新增消息的估算(无基线时为全部历史的估算,且不含系统提示与记忆注入)
  session: SessionUsage; // 会话累计(仅实测部分)
}

export function contextBaseline(messages: UIMessage[]): ContextBaseline {
  const session: SessionUsage = { prompt: 0, completion: 0, cached: 0, turns: 0 };
  let last = -1;
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || !m.usage) return;
    session.prompt += m.usage.promptTokens;
    session.completion += m.usage.completionTokens;
    session.cached += m.usage.cachedTokens ?? 0;
    session.turns += 1;
    last = i;
  });
  if (last < 0) return { usage: null, carried: 0, pending: historyTokens(messages), session };
  const usage = messages[last].usage!;
  return { usage, carried: carriedTokens(usage), pending: historyTokens(messages.slice(last + 1)), session };
}

// 完整数字(带千分位),用于明细
export function formatTokensFull(n: number): string {
  return n.toLocaleString("en-US");
}
