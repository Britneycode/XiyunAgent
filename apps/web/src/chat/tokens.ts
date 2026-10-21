import type { UIMessage } from "./useChatStream.ts";

// Token 本地估算。服务端与模型网关目前不回传 usage,这里按经验比例估算,界面统一以 "≈" 标注。
// 经验值:CJK 字符约 1 token/字;其余字符(英文、代码、空白、标点)约 4 字符/token。
const CJK = /[\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/g;

// 每条消息的角色与分隔符开销(OpenAI chat 格式约 3–4 token)
export const MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

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
