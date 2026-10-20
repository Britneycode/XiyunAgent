import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatBlock, ChatMessage, SessionMeta } from "@xiyun/shared";
import { api, streamChat, type RefPayload, type StreamEvent } from "../api.ts";

export interface UIMessage extends ChatMessage {
  error?: string;
  streaming?: boolean;
}

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

export function useChatStream(session: SessionMeta, opts?: { onDone?: () => void }) {
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
    setMessages((ms) => {
      const copy = [...ms];
      let last = copy[copy.length - 1];
      if (!last || last.role !== "assistant") return ms;
      let blocks = last.blocks ? [...last.blocks] : [];
      let content = last.content;
      for (const ev of queue) {
        if ("delta" in ev && typeof ev.delta === "string") {
          content += ev.delta;
          if (!blocks.length) blocks = [];
          else {
            const lastText = [...blocks].reverse().find((b) => b.kind === "text");
            if (lastText && lastText.kind === "text") lastText.text += ev.delta;
          }
        } else if ("type" in ev) {
          blocks = applyEvent(blocks, ev);
        }
      }
      last = { ...last, content, blocks: blocks.length ? blocks : undefined };
      copy[copy.length - 1] = last;
      return copy;
    });
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
          { role: "user", content: text },
          { role: "assistant", content: "", blocks: [], streaming: true },
        ]);
      } else {
        setMessages((ms) => {
          const trimmed = ms[ms.length - 1]?.role === "assistant" ? ms.slice(0, -1) : ms;
          return [...trimmed, { role: "assistant", content: "", blocks: [], streaming: true }];
        });
      }
      try {
        await streamChat(
          session.id, text, () => {}, abortRef.current.signal, o?.regenerate === true,
          { onEvent: enqueue, context: o?.context, refs: o?.refs },
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
