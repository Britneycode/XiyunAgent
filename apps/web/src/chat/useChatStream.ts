import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatBlock, ChatMessage, SessionMeta } from "@xiyun/shared";
import { api, streamChat, type RefPayload, type StreamEvent } from "../api.ts";

export interface UIMessage extends ChatMessage {
  streaming?: boolean;
  // 本地创建的气泡的稳定 key:回填落库 id 后 React key 不变,气泡不会重新挂载
  localKey?: string;
}

let localSeq = 0;
const nextKey = () => `local-${++localSeq}`;

// 把块事件应用到本地消息:block 开块,block_delta 追加,block_end 用快照覆盖
function applyEvent(blocks: ChatBlock[], ev: StreamEvent): ChatBlock[] {
  if (!("type" in ev)) return blocks;
  if (ev.type === "block") {
    const next: ChatBlock =
      ev.block.kind === "tool"
        ? { id: ev.id, kind: "tool", name: ev.block.name, rawArgs: "", status: "pending" }
        : ({ id: ev.id, kind: ev.block.kind, text: "" } as ChatBlock);
    return [...blocks, next];
  }
  if (ev.type === "block_delta") {
    return blocks.map((b) => {
      if (b.id !== ev.id) return b;
      if (b.kind === "thinking") return { ...b, text: b.text + ev.delta };
      if (b.kind === "tool") return { ...b, rawArgs: b.rawArgs + ev.delta };
      if (b.kind === "text") return { ...b, text: b.text + ev.delta };
      return b;
    });
  }
  if (ev.type === "block_end") {
    return blocks.map((b) => (b.id === ev.id ? ev.block : b));
  }
  return blocks;
}

// 把一批流式事件合并进正在生成的 assistant 消息。纯函数:StrictMode 下更新函数会执行两次,
// 任何原地修改都会让增量重复。
export function applyQueue(msg: UIMessage, queue: StreamEvent[]): UIMessage {
  let blocks = msg.blocks ? [...msg.blocks] : [];
  let content = msg.content;
  let usage = msg.usage;
  for (const ev of queue) {
    // 带 type 的块事件优先:block_delta 同样带 delta 字段,不能落入下面的正文分支,
    // 否则思考 / 工具参数增量会被拼进正文
    if ("type" in ev) {
      if (ev.type === "usage") usage = ev.usage;
      else blocks = applyEvent(blocks, ev);
    } else if ("delta" in ev && typeof ev.delta === "string") {
      content += ev.delta;
      // 正文增量写入 id 对应的文本块,缺省为最后一个文本块
      let idx = ev.id ? blocks.findIndex((b) => b.id === ev.id) : -1;
      if (idx < 0 || blocks[idx]?.kind !== "text") {
        idx = -1;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i]!.kind === "text") {
            idx = i;
            break;
          }
        }
      }
      const target = blocks[idx];
      if (target?.kind === "text") blocks[idx] = { ...target, text: target.text + ev.delta };
    }
  }
  return { ...msg, content, blocks: blocks.length ? blocks : undefined, usage };
}

// 把一批流式事件应用到消息列表:内容事件写进末条 assistant;meta / done / error 携带的落库 id
// 回填到本轮的 user 与 assistant 气泡,新发出的消息无需刷新即可编辑、分支。纯函数。
export function applyStream(ms: UIMessage[], queue: StreamEvent[]): UIMessage[] {
  const ai = ms.length - 1;
  const last = ms[ai];
  if (!last || last.role !== "assistant") return ms;
  let userId: number | null = null;
  let messageId: number | null = null;
  for (const ev of queue) {
    if ("type" in ev) {
      if (ev.type === "meta" && ev.userMessageId != null) userId = ev.userMessageId;
    } else if ("done" in ev || "error" in ev) {
      if (ev.userMessageId != null) userId = ev.userMessageId;
      if (ev.messageId != null) messageId = ev.messageId;
    }
  }
  const next = [...ms];
  let msg = applyQueue(last, queue);
  if (messageId != null && msg.id == null) msg = { ...msg, id: messageId };
  next[ai] = msg;
  if (userId != null) {
    for (let i = ai - 1; i >= 0; i--) {
      const m = next[i]!;
      if (m.role !== "user") continue;
      if (m.id == null) next[i] = { ...m, id: userId };
      break;
    }
  }
  return next;
}

// onSessionChanged:会话元信息可能变化(新消息改变排序、自动命名)时通知外层刷新列表
export function useChatStream(session: SessionMeta, opts?: { onDone?: () => void; onSessionChanged?: () => void }) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<StreamEvent[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    void api.messages(session.id).then((ms) => setMessages(ms.filter((m) => m.role !== "system")));
  }, [session.id]);

  // 卸载(切换会话导致 key 变化)时中断在途请求
  useEffect(() => () => abortRef.current?.abort(), []);

  const flush = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const queue = pendingRef.current;
    pendingRef.current = [];
    if (!queue.length) return;
    setMessages((ms) => applyStream(ms, queue));
  }, []);

  const enqueue = useCallback(
    (ev: StreamEvent) => {
      pendingRef.current.push(ev);
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        flush();
      });
    },
    [flush],
  );

  const send = useCallback(
    async (text: string, o?: { regenerate?: boolean; context?: string; refs?: RefPayload[] }) => {
      if (!text || busy) return;
      setBusy(true);
      abortRef.current = new AbortController();
      if (!o?.regenerate) {
        setMessages((ms) => [
          ...ms,
          { role: "user", content: text, localKey: nextKey() },
          { role: "assistant", content: "", blocks: [], streaming: true, localKey: nextKey() },
        ]);
      } else {
        setMessages((ms) => {
          const trimmed = ms[ms.length - 1]?.role === "assistant" ? ms.slice(0, -1) : ms;
          return [...trimmed, { role: "assistant", content: "", blocks: [], streaming: true, localKey: nextKey() }];
        });
      }
      try {
        await streamChat(
          session.id, text, () => {}, abortRef.current.signal, o?.regenerate === true,
          {
            onEvent: (ev) => {
              enqueue(ev);
              if ("type" in ev && (ev.type === "meta" || ev.type === "title")) opts?.onSessionChanged?.();
            },
            context: o?.context,
            refs: o?.refs,
          },
        );
        flush(); // 收尾必须同步 flush
        setMessages((ms) => {
          const copy = [...ms];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant") copy[copy.length - 1] = { ...last, streaming: false };
          return copy;
        });
        opts?.onDone?.();
      } catch (e) {
        flush();
        const aborted = abortRef.current?.signal.aborted === true;
        setMessages((ms) => {
          const copy = [...ms];
          const last = copy[copy.length - 1];
          if (!last || last.role !== "assistant") return ms;
          if (aborted) {
            if (!last.content && !last.blocks?.length) return copy.slice(0, -1);
            copy[copy.length - 1] = { ...last, streaming: false, aborted: true };
          } else {
            copy[copy.length - 1] = { ...last, streaming: false, error: e instanceof Error ? e.message : String(e) };
          }
          return copy;
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, enqueue, flush, session.id, opts],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const regenerate = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser || busy) return;
    void send(lastUser.content, { regenerate: true });
  }, [messages, busy, send]);

  return { messages, setMessages, send, stop, regenerate, busy };
}
