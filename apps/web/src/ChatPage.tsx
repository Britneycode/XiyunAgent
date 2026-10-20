import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@xiyun/shared";
import { api, streamChat } from "./api.ts";
import { renderMarkdown } from "./chat/markdown.ts";

export function ChatPage({ sessionId, onBranch }: { sessionId: string; onBranch?: (messageId: number) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.messages(sessionId).then((ms) => setMessages(ms.filter((m) => m.role !== "system")));
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (typeof renderMathInElement === "undefined") return;
    document.querySelectorAll<HTMLElement>(".msg-body").forEach((el) =>
      renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
      }),
    );
  }, [messages]);

  const send = async (text: string, regenerate = false) => {
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    abortRef.current = new AbortController();
    if (!regenerate)
      setMessages((ms) => [...ms, { role: "user", content: text }, { role: "assistant", content: "" }]);
    else setMessages((ms) => [...ms, { role: "assistant", content: "" }]);
    try {
      await streamChat(sessionId, text, (delta) => {
        setMessages((ms) => {
          const copy = [...ms];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, content: last.content + delta };
          return copy;
        });
      }, abortRef.current.signal, regenerate);
    } catch (e) {
      if (!abortRef.current.signal.aborted) {
        setMessages((ms) => {
          const copy = [...ms];
          copy[copy.length - 1] = { role: "assistant", content: `出错:${e instanceof Error ? e.message : e}` };
          return copy;
        });
      } else {
        // 用户主动停止:删掉空气泡,保留已流出的内容
        setMessages((ms) => {
          const copy = [...ms];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant" && !last.content) copy.pop();
          return copy;
        });
      }
    } finally {
      setBusy(false);
    }
  };

  // 重新生成/重试:丢弃本地最后一条 assistant 气泡,对同一 user 消息重发(regenerate=true 让 server 不重复落库 user 消息)
  const regenerate = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser || busy) return;
    setMessages((ms) => (ms[ms.length - 1]?.role === "assistant" ? ms.slice(0, -1) : ms));
    void send(lastUser.content, true);
  };

  // 复制消息内容到剪贴板
  const copyMsg = (content: string, e: React.MouseEvent<HTMLButtonElement>) => {
    void navigator.clipboard.writeText(content).then(() => {
      const btn = e.currentTarget;
      btn.textContent = "✓";
      setTimeout(() => (btn.textContent = "⧉"), 1200);
    });
  };

  // 编辑 user 消息:把内容放回输入框,并截断该条及其后消息(用户重新发送即重生成)
  const [editingId, setEditingId] = useState<number | null>(null);
  const startEdit = (m: ChatMessage) => {
    if (busy) return;
    setInput(m.content);
    setEditingId(m.id ?? null);
  };
  const submitEdit = async () => {
    if (editingId == null) return;
    const text = input.trim();
    await api.truncateFrom(sessionId, editingId).catch(() => {});
    setEditingId(null);
    // 截断后本地也删掉该条及之后的消息,再重新发送
    setMessages((ms) => {
      const idx = ms.findIndex((m) => m.id === editingId);
      return idx >= 0 ? ms.slice(0, idx) : ms;
    });
    if (text) void send(text);
  };

  // Esc 停止生成
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && abortRef.current?.abort();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  const lastIsAssistant = messages[messages.length - 1]?.role === "assistant";
  const lastIsError = lastIsAssistant && messages[messages.length - 1].content.startsWith("出错:");

  return (
    <>
      <div className="chat-messages">
        {messages.length === 0 && <div className="empty">这个会话还没有消息。</div>}
        {messages.map((m, i) => (
          <div className={`msg ${m.role}`} key={m.id ?? i}>
            <div className="msg-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
            {!busy && m.content && (
              <div className="msg-actions">
                <button title="复制" onClick={(e) => copyMsg(m.content, e)}>⧉</button>
                {m.role === "assistant" && i === messages.length - 1 && (
                  <button title="重新生成" onClick={regenerate}>↻</button>
                )}
                {m.role === "user" && m.id != null && (
                  <>
                    <button title="编辑并重新生成" onClick={() => startEdit(m)}>✎</button>
                    {onBranch && <button title="分支到新会话" onClick={() => onBranch(m.id!)}>⑂</button>}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-wrap">
        {editingId != null && (
          <div className="editing-bar">
            正在编辑消息,发送后将替换该条及其后的对话
            <button onClick={() => { setEditingId(null); setInput(""); }}>取消编辑</button>
          </div>
        )}
        <div className="chat-input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !busy) {
                e.preventDefault();
                if (editingId != null) void submitEdit();
                else {
                  const text = input.trim();
                  if (text) void send(text);
                }
              }
            }}
            placeholder={editingId != null ? "编辑消息,Enter 重新生成" : "输入消息,Enter 发送,Shift+Enter 换行,Esc 停止"}
            disabled={busy}
          />
          {busy ? (
            <>
              <span className="hint">生成中…(Esc 停止)</span>
              <button className="danger" onClick={() => abortRef.current?.abort()}>停止</button>
            </>
          ) : (
            <>
              {lastIsAssistant && messages.length > 0 && editingId == null && (
                <button onClick={regenerate} title="对同一问题重新生成回答">
                  {lastIsError ? "重试" : "重新生成"}
                </button>
              )}
              <button className="primary" onClick={() => (editingId != null ? void submitEdit() : void send(input.trim()))}>
                发送
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
