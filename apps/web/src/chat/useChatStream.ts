import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentMeta, ChatBlock, ChatMessage, SessionMeta } from "@xiyun/shared";
import { api, streamChat, subscribeRun, type RefPayload, type StreamEvent } from "../api.ts";

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
  let model: string | null = null;
  let trim: UIMessage["trim"];
  for (const ev of queue) {
    if ("type" in ev) {
      if (ev.type === "meta" && ev.userMessageId != null) userId = ev.userMessageId;
      if (ev.type === "meta" && ev.model) model = ev.model;
      if (ev.type === "meta" && ev.trim) trim = ev.trim;
      if (ev.type === "cancelled") {
        if (ev.userMessageId != null) userId = ev.userMessageId;
        if (ev.messageId != null) messageId = ev.messageId;
      }
    } else if ("done" in ev || "error" in ev) {
      if (ev.userMessageId != null) userId = ev.userMessageId;
      if (ev.messageId != null) messageId = ev.messageId;
    }
  }
  const next = [...ms];
  let msg = applyQueue(last, queue);
  if (messageId != null && msg.id == null) msg = { ...msg, id: messageId };
  if (model && !msg.model) msg = { ...msg, model };
  if (trim && !msg.trim) msg = { ...msg, trim };
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

// 重新进入会话时,若有运行中的后台生成:去掉该轮 user 之后已落库的消息(regenerate 时的旧回答、
// 或在两次请求之间刚落库的新回答),由事件回放重建末条 assistant。纯函数。
export function attachBase(ms: UIMessage[], userMessageId: number | null): UIMessage[] {
  const base = userMessageId != null ? ms.filter((m) => m.id == null || m.id <= userMessageId) : ms;
  return [...base, { role: "assistant", content: "", blocks: [], streaming: true, localKey: nextKey() }];
}

// 生成结束后用服务端的消息列表补上版本信息(F6:重新生成 / 编辑后出现的 "2/2")。
// 只更新 parentId / siblings / trim,其余字段与 localKey 保持不变;没有变化的消息沿用原对象,不触发重渲染。纯函数。
export function mergeTree(ms: UIMessage[], server: ChatMessage[]): UIMessage[] {
  const byId = new Map(server.flatMap((m) => (m.id != null ? [[m.id, m] as const] : [])));
  const same = (a?: number[], b?: number[]) => (a ?? []).join(",") === (b ?? []).join(",");
  let changed = false;
  const next = ms.map((m) => {
    const s = m.id != null ? byId.get(m.id) : undefined;
    if (!s) return m;
    if (same(m.siblings, s.siblings) && (m.parentId ?? null) === (s.parentId ?? null) && !!m.trim === !!s.trim) return m;
    changed = true;
    return { ...m, parentId: s.parentId, siblings: s.siblings, trim: s.trim ?? m.trim };
  });
  return changed ? next : ms;
}

// 流结束时收尾末条 assistant:被停止的标记 aborted(全空则移除),否则只结束 streaming。纯函数。
export function finalizeLast(ms: UIMessage[], o: { cancelled: boolean; error?: string }): UIMessage[] {
  const last = ms[ms.length - 1];
  if (!last || last.role !== "assistant") return ms;
  const copy = [...ms];
  if (o.cancelled) {
    if (!last.content && !last.blocks?.length) return copy.slice(0, -1);
    copy[copy.length - 1] = { ...last, streaming: false, aborted: true };
  } else if (o.error) copy[copy.length - 1] = { ...last, streaming: false, error: o.error };
  else copy[copy.length - 1] = { ...last, streaming: false };
  return copy;
}

// onSessionChanged:会话元信息可能变化(新消息改变排序、自动命名、生成结束)时通知外层刷新列表
export function useChatStream(session: SessionMeta, opts?: { onDone?: () => void; onSessionChanged?: () => void }) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false); // 首次加载完成(搜索定位据此判断消息是否在当前分支上)
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const stopRef = useRef(false); // 已请求停止:meta 晚到时补发 cancel
  const pendingRef = useRef<StreamEvent[]>([]);
  const rafRef = useRef<number | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

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

  // 请服务端中止;3s 内流还没结束就断开本地连接兜底
  const requestCancel = useCallback((runId: string, ac: AbortController) => {
    void api.cancelRun(runId).catch(() => {});
    setTimeout(() => {
      if (abortRef.current === ac) ac.abort();
    }, 3000);
  }, []);

  // 消费一条事件流(新发送或续订后台生成),结束后收尾末条 assistant。
  // 卸载 / 切换会话只断开本地连接(abortRef),后台生成继续;停止由 stop() 走 cancel。
  const consume = useCallback(
    async (start: (onEvent: (ev: StreamEvent) => void, signal: AbortSignal) => Promise<void>) => {
      setBusy(true);
      stopRef.current = false;
      const ac = new AbortController();
      abortRef.current = ac;
      let cancelled = false;
      const onEvent = (ev: StreamEvent) => {
        enqueue(ev);
        if (!("type" in ev)) return;
        if (ev.type === "meta" && ev.runId) {
          runIdRef.current = ev.runId;
          if (stopRef.current) requestCancel(ev.runId, ac);
        }
        if (ev.type === "cancelled") cancelled = true;
        if (ev.type === "meta" || ev.type === "title") optsRef.current?.onSessionChanged?.();
      };
      try {
        await start(onEvent, ac.signal);
        flush(); // 收尾必须同步 flush
        setMessages((ms) => finalizeLast(ms, { cancelled }));
        if (!cancelled) optsRef.current?.onDone?.();
      } catch (e) {
        flush();
        // 本地断开(卸载或停止兜底)视为中断;其余是服务端 / 网络错误
        const aborted = ac.signal.aborted;
        setMessages((ms) =>
          finalizeLast(ms, aborted ? { cancelled: true } : { cancelled, error: e instanceof Error ? e.message : String(e) }),
        );
      } finally {
        if (abortRef.current === ac) {
          abortRef.current = null;
          runIdRef.current = null;
          setBusy(false);
        }
        optsRef.current?.onSessionChanged?.();
        // 补上版本信息:重新生成 / 编辑后,新消息显示 "2/2" 并可切回旧版本
        void api
          .messages(session.id)
          .then((list) => setMessages((ms) => mergeTree(ms, list)))
          .catch(() => {});
      }
    },
    [enqueue, flush, requestCancel, session.id],
  );

  // 进入会话:加载历史;有运行中的后台生成时续订并回放(F1)
  useEffect(() => {
    let alive = true;
    void (async () => {
      const run = await api.activeRun(session.id).catch(() => null);
      const ms = (await api.messages(session.id)).filter((m) => m.role !== "system");
      if (!alive) return;
      setLoaded(true);
      if (run?.status !== "running") {
        setMessages(ms);
        return;
      }
      setMessages(attachBase(ms, run.userMessageId));
      runIdRef.current = run.id;
      void consume((onEvent, signal) => subscribeRun(run.id, onEvent, signal));
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [session.id, consume]);

  // 卸载(切换会话导致 key 变化)时只断开本地订阅,不停止后台生成
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (
      text: string,
      o?: {
        regenerate?: boolean;
        context?: string;
        refs?: RefPayload[];
        providerId?: string;
        model?: string;
        editOf?: number; // 编辑该 user 消息:它之后的内容从界面移走(服务端作为旧版本保留)
        attachments?: AttachmentMeta[]; // 已上传的附件(B2);编辑时缺省沿用原消息的附件
      },
    ) => {
      if (busy) return;
      // 重新生成沿用库里的原话,可以为空(只发了附件的消息);新发送需要文字或附件
      if (!o?.regenerate && !text && !o?.attachments?.length) return;
      if (!o?.regenerate) {
        // 引用即时显示为气泡上方的标签,不必等刷新
        const refBlocks: ChatBlock[] | undefined = o?.refs?.length
          ? o.refs.map((r, i) => ({ id: `ref${i + 1}`, kind: "ref", refType: r.refType, label: r.label, excerpt: r.excerpt }))
          : undefined;
        const attBlocks: ChatBlock[] | undefined = o?.attachments?.length
          ? o.attachments.map((a, i) => ({
              id: `att${i + 1}`, kind: "attachment", attachmentId: a.id, name: a.name, mime: a.mime, size: a.size, type: a.kind,
            }))
          : undefined;
        setMessages((ms) => {
          const idx = o?.editOf != null ? ms.findIndex((m) => m.id === o.editOf) : -1;
          // 编辑时没带新引用 / 附件:沿用原消息的(与服务端一致)
          const orig = idx >= 0 ? (ms[idx]!.blocks ?? []) : [];
          const blocks = [
            ...(refBlocks ?? orig.filter((b) => b.kind === "ref")),
            ...(attBlocks ?? orig.filter((b) => b.kind === "attachment")),
          ];
          return [
            ...(idx >= 0 ? ms.slice(0, idx) : ms),
            { role: "user", content: text, blocks: blocks.length ? blocks : undefined, localKey: nextKey() },
            { role: "assistant", content: "", blocks: [], streaming: true, localKey: nextKey() },
          ];
        });
      } else {
        setMessages((ms) => {
          const trimmed = ms[ms.length - 1]?.role === "assistant" ? ms.slice(0, -1) : ms;
          return [...trimmed, { role: "assistant", content: "", blocks: [], streaming: true, localKey: nextKey() }];
        });
      }
      await consume((onEvent, signal) =>
        streamChat(session.id, text, () => {}, signal, o?.regenerate === true, {
          onEvent,
          context: o?.context,
          refs: o?.refs,
          providerId: o?.providerId,
          model: o?.model,
          editOf: o?.editOf,
          attachments: o?.attachments?.map((a) => a.id),
        }),
      );
    },
    [busy, consume, session.id],
  );

  // F6:切换到另一个版本(兄弟消息)或搜索命中的分支
  const switchTo = useCallback(
    async (messageId: number) => {
      if (busy) return;
      const r = await api.setHead(session.id, messageId);
      setMessages(r.messages.filter((m) => m.role !== "system"));
    },
    [busy, session.id],
  );

  // 停止:请服务端中止(半截落库后流自然结束);已发出 cancel 但 3s 内没结束,就断开本地连接兜底。
  // 还没拿到 runId(服务端仍在准备上下文)时不断开,等 meta 到达后立即补发 cancel,避免后台继续生成
  const stop = useCallback(() => {
    const ac = abortRef.current;
    if (!ac) return;
    stopRef.current = true;
    if (runIdRef.current) requestCancel(runIdRef.current, ac);
  }, [requestCancel]);

  // override:本次换用指定模型重新生成(不改变会话的模型设置)
  const regenerate = useCallback(
    (override?: { providerId: string; model: string }) => {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUser || busy) return;
      void send(lastUser.content, { regenerate: true, ...override });
    },
    [messages, busy, send],
  );

  return { messages, setMessages, send, stop, regenerate, switchTo, busy, loaded };
}
