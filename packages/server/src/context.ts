import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { estimateTokens, type ChatBlock, type ChatMessage, type TokenUsage } from "@xiyun/shared";
import type { ChatProvider } from "../../runtime/src/index.ts";
import { assertInside } from "./workspace.ts";

// ---- 上下文管理(F4 / D-022)----
// 历史不再固定取最近 20 条,而是按模型上下文窗口算 token 预算,从新到旧装入;
// 装不下的早先消息由后台滚动摘要代替。引用上下文随 user 消息落库,最近几轮继续带入。

export const DEFAULT_CONTEXT = 32_000; // 未配置上下文长度时的保守值
export const DEFAULT_RESERVE = 4_096; // 为回复预留(未配置 maxTokens 时)
export const CONTEXT_RATIO = 0.8; // 只用窗口的 80%,给估算误差留余量
export const MESSAGE_OVERHEAD = 4;
export const REF_TURNS = 3; // 历史中最近 3 条带引用的 user 消息重新带入引用上下文
export const SUMMARY_MAX_CHARS = 1_500;
export const IMAGE_TOKENS = 1_200; // 单张图片的粗略占用(各家按分辨率计费,这里取常见尺寸的上限附近)

type AttachmentBlock = Extract<ChatBlock, { kind: "attachment" }>;

export interface PathMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  refContext?: string | null;
  refs?: Array<Extract<ChatBlock, { kind: "ref" }>>;
  attachments?: AttachmentBlock[];
  usage?: TokenUsage;
}

// 历史消息:imageIds 由调用方读成 base64 填进 images
export type HistoryMessage = ChatMessage & { imageIds?: string[] };

export interface PlanOptions {
  changed?: (m: PathMessage) => string[]; // 引用之后已变更的文件
  attachmentText?: (m: PathMessage) => string; // 文本附件正文(已拼好标题)
  vision?: boolean; // 模型能看图;否则历史里的图片只留占位
}

// 附件的占位说明(较早的轮次、或模型不支持图片时)
export const attachmentNote = (list: AttachmentBlock[]) =>
  list.length ? `[附件:${list.map((a) => a.name).join("、")}]` : "";

export function contextBudget(o: { contextLength?: number; maxTokens?: number }): number {
  const window = o.contextLength && o.contextLength > 0 ? o.contextLength : DEFAULT_CONTEXT;
  const reserve = o.maxTokens && o.maxTokens > 0 ? o.maxTokens : DEFAULT_RESERVE;
  return Math.max(0, Math.floor(window * CONTEXT_RATIO) - reserve);
}

export const withRefContext = (content: string, context: string) => `${content}\n\n# 引用上下文\n${context}`;

// 文件内容指纹:引用时记下,之后带入历史时对比,变了就提示模型内容可能过时
export function fileHash(workspace: string, path: string): string | undefined {
  try {
    const abs = assertInside(workspace, path);
    return createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

export interface HistoryPlan {
  history: HistoryMessage[];
  dropped: PathMessage[]; // 未逐字带入的早先消息(旧 → 新)
  used: number; // 历史占用的估算 tokens
}

// 从新到旧装入历史直到用完预算;开头保证是 user 消息。
// 最近 REF_TURNS 条带引用 / 附件的 user 消息完整带入(引用上下文、文本附件、图片),更早的只留附件占位
export function planHistory(path: PathMessage[], budget: number, opts: PlanOptions = {}): HistoryPlan {
  const usable = path.filter((m) => m.role !== "system" && (m.content.trim() || m.attachments?.length));
  const rich = new Set(
    usable
      .filter((m) => m.role === "user" && (m.refContext || m.attachments?.length))
      .slice(-REF_TURNS)
      .map((m) => m.id),
  );
  const kept: HistoryMessage[] = [];
  let used = 0;
  let i = usable.length - 1;
  for (; i >= 0; i--) {
    const m = usable[i]!;
    let content = m.content;
    let imageIds: string[] | undefined;
    const atts = m.attachments ?? [];
    if (rich.has(m.id)) {
      if (m.refContext) {
        const stale = opts.changed?.(m) ?? [];
        content = withRefContext(
          content,
          stale.length ? `${m.refContext}\n\n(注意:${stale.join("、")} 在引用之后已修改,以上内容可能过时)` : m.refContext,
        );
      }
      const text = opts.attachmentText?.(m) ?? "";
      if (text) content = withAttachments(content, text);
      const images = atts.filter((a) => a.type === "image");
      if (images.length && opts.vision) imageIds = images.map((a) => a.attachmentId);
      else if (images.length) content = [content, attachmentNote(images)].filter(Boolean).join("\n\n");
    } else if (atts.length) {
      content = [content, attachmentNote(atts)].filter(Boolean).join("\n\n");
    }
    // assistant 有实测用量时以输出 tokens 计(推理部分不回传)。
    // 多步 agent 回复的 completionTokens 是各步之和,不代表这条消息的长度,改用估算值
    const cost =
      (m.role === "assistant" && m.usage && (m.usage.steps ?? 1) <= 1
        ? Math.max(estimateTokens(m.content), m.usage.completionTokens - (m.usage.reasoningTokens ?? 0))
        : estimateTokens(content)) +
      MESSAGE_OVERHEAD +
      (imageIds?.length ?? 0) * IMAGE_TOKENS;
    if (used + cost > budget) break;
    used += cost;
    kept.unshift({ role: m.role, content, ...(imageIds ? { imageIds } : {}) });
  }
  // 从 assistant 开头的历史不完整,连同它一起交给摘要
  while (kept.length && kept[0]!.role === "assistant") {
    kept.shift();
    i++;
  }
  return { history: kept, dropped: usable.slice(0, i + 1), used };
}

export const withAttachments = (content: string, text: string) => (content ? `${content}\n\n# 附件\n${text}` : `# 附件\n${text}`);

// 把早先消息压缩进滚动摘要;previous 为已有摘要。失败或超时返回空串
export async function summarize(
  provider: ChatProvider,
  previous: string,
  messages: PathMessage[],
  timeoutMs = 60_000,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const lines = messages
    .map((m) => `${m.role === "user" ? "用户" : "助手"}:${m.content.length > 1_500 ? `${m.content.slice(0, 1_500)}…` : m.content}`)
    .join("\n\n");
  try {
    let out = "";
    for await (const d of provider.streamChat(
      [
        {
          role: "system",
          content:
            "你负责压缩一段较早的对话,供之后的回复参考。输出要点式摘要:保留用户的目标、关键事实与数据、已做出的决定、约定的格式偏好和尚未解决的问题;省略寒暄与重复。与对话同语言,不超过 400 字,只输出摘要本身。",
        },
        {
          role: "user",
          content: `${previous ? `# 已有摘要\n${previous}\n\n# 之后的对话\n` : ""}${lines}`,
        },
      ],
      { signal: ac.signal },
    )) {
      out += d;
      if (out.length > SUMMARY_MAX_CHARS * 2) break;
    }
    const text = out.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
    return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}…` : text;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// 单次摘要的输入上限:超出时先摘要最早的一段,之后的轮次继续补齐
export const SUMMARY_INPUT_CHARS = 24_000;
export function summaryBatch(messages: PathMessage[]): PathMessage[] {
  const out: PathMessage[] = [];
  let total = 0;
  for (const m of messages) {
    const len = Math.min(m.content.length, 1_500) + 8;
    if (out.length && total + len > SUMMARY_INPUT_CHARS) break;
    out.push(m);
    total += len;
  }
  return out;
}
