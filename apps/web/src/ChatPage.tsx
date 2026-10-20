import { useEffect, useRef, useState } from "react";
import type { SessionMeta } from "@xiyun/shared";
import { api } from "./api.ts";
import { MessageBody, RefChips, type Preview } from "./chat/blocks.tsx";
import { Composer } from "./chat/Composer.tsx";
import { useChatStream } from "./chat/useChatStream.ts";
import { renderMarkdown as renderMarkdownSafe } from "./chat/markdown.ts";

export interface ChatPageProps {
  session: SessionMeta;
  onBranch?: (messageId: number) => void;
  onPreview?: (p: Preview) => void;
  onNewSession?: () => void;
  onCandidatesChanged?: () => void;
}

export function ChatPage({ session, onBranch, onPreview, onNewSession, onCandidatesChanged }: ChatPageProps) {
  const { messages, setMessages, send, stop, regenerate, busy } = useChatStream(session, {
    onDone: onCandidatesChanged,
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  // 仅在接近底部时自动滚动;瞬时定位避免 smooth 造成抖动
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 代码块复制:事件委托
  const onCopyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
    if (!btn) return;
    const code = btn.closest(".code-block")?.querySelector("code");
    if (!code) return;
    void navigator.clipboard.writeText(code.textContent ?? "").then(() => {
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = "复制"), 1200);
    });
  };

  const startEdit = (id: number, content: string) => {
    if (busy) return;
    setEditingId(id);
    setEditText(content);
  };

  const submitEdit = async () => {
    if (editingId == null) return;
    const text = editText.trim();
    await api.truncateFrom(session.id, editingId).catch(() => {});
    setEditingId(null);
    setEditText("");
    setMessages((ms) => {
      const idx = ms.findIndex((m) => m.id === editingId);
      return idx >= 0 ? ms.slice(0, idx) : ms;
    });
    if (text) void send(text);
  };

  // Esc 停止生成
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && stop();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, stop]);

  return (
    <>
      <div className="chat-messages" ref={scroller} onClick={onCopyClick}>
        {messages.length === 0 && <div className="empty">这个会话还没有消息。</div>}
        {messages.map((m, i) => (
          <div className={`msg ${m.role}`} key={m.id ?? `tmp-${i}`}>
            {m.role === "user" && m.blocks?.some((b) => b.kind === "ref") && (
              <RefChips refs={m.blocks.filter((b) => b.kind === "ref") as never} />
            )}
            {m.role === "user" ? (
              <div className="msg-body" dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(m.content) }} />
            ) : (
              <MessageBody
                content={m.content}
                blocks={m.blocks}
                streaming={m.streaming}
                onPreview={onPreview}
              />
            )}
            {m.aborted && <div className="msg-note mono">已中断</div>}
            {m.error && (
              <div className="msg-error mono">
                {m.error}
                <button type="button" onClick={regenerate}>重试</button>
              </div>
            )}
            {!busy && m.content && (
              <div className="msg-actions">
                <button
                  title="复制"
                  onClick={() => void navigator.clipboard.writeText(m.content)}
                >⧉</button>
                {m.role === "assistant" && i === messages.length - 1 && (
                  <button title="重新生成" onClick={regenerate}>↻</button>
                )}
                {m.role === "user" && m.id != null && (
                  <>
                    <button title="编辑并重新生成" onClick={() => startEdit(m.id!, m.content)}>✎</button>
                    {onBranch && <button title="分支到新会话" onClick={() => onBranch(m.id!)}>⑂</button>}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <Composer
        session={session}
        busy={busy}
        editingId={editingId}
        editText={editText}
        onEditText={setEditText}
        onCancelEdit={() => { setEditingId(null); setEditText(""); }}
        onSubmit={(text, o) => (editingId != null ? void submitEdit() : void send(text, o))}
        onStop={stop}
        onNewSession={onNewSession}
        onCandidatesChanged={onCandidatesChanged}
        messages={messages}
      />
    </>
  );
}
