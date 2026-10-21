import type { ChatProvider } from "../../runtime/src/index.ts";

// ---- 会话自动命名(D-019)----
// 首条消息落库时先用启发式标题(即时可见),再异步请模型起一个短标题覆盖。
export const DEFAULT_TITLE = "新会话";
const HEURISTIC_MAX = 30;
const TITLE_MAX = 40;

// 取首个非空行,去掉常见 Markdown 标记,超长截断加省略号
export function heuristicTitle(message: string): string {
  const line =
    message
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !/^(```|~~~)/.test(l)) ?? "";
  const plain = line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(plain);
  return chars.length > HEURISTIC_MAX ? `${chars.slice(0, HEURISTIC_MAX).join("")}…` : plain;
}

// 清理模型输出:去 <think>、引号、"标题:" 前缀、结尾标点,只留第一行
export function cleanTitle(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
  t = t.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  t = t.replace(/^(标题|title)\s*[::]\s*/i, "").replace(/^#+\s*/, "").replace(/\*\*/g, "");
  const tail = /[。.!!??,,;;::、\s]+$/u;
  t = t.replace(tail, "").replace(/^["'“”‘’「『《]+|["'“”‘’」』》]+$/g, "").replace(tail, "").trim();
  const chars = Array.from(t);
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join("") : t;
}

// 请模型为首条消息起标题;超时或失败返回空串(保留启发式标题)
export async function generateTitle(provider: ChatProvider, message: string, timeoutMs = 20_000): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let out = "";
    for await (const d of provider.streamChat(
      [
        {
          role: "system",
          content:
            "为下面这条用户消息起一个简短的会话标题:与消息同语言,中文不超过 15 个字、英文不超过 8 个词,概括主题。只输出标题本身,不要引号、标点或解释。",
        },
        { role: "user", content: message.slice(0, 2000) },
      ],
      { signal: ac.signal },
    )) {
      out += d;
      if (out.length > 400) break;
    }
    return cleanTitle(out);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
