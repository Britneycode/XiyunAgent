import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, Check, ChevronLeft, ChevronRight, FoldVertical, GitBranch, Pencil, RotateCcw, Square, TriangleAlert } from "lucide-react";
import type { ChatBlock, SessionMeta } from "@xiyun/shared";
import type { RefPayload } from "./api.ts";
import { AttachmentList, CopyButton, MessageBody, RefChips, type AttachmentBlockData, type Preview } from "./chat/blocks.tsx";
import { handleCodeAction } from "./chat/codeActions.ts";
import { Composer } from "./chat/Composer.tsx";
import { StreamingMarkdown } from "./chat/StreamingMarkdown.tsx";
import { formatTokens, messageTokens, MESSAGE_OVERHEAD } from "./chat/tokens.ts";
import { UsageBadge } from "./chat/UsageBadge.tsx";
import { useFocusRequest } from "./chat/focus.ts";
import { ModelPicker } from "./chat/ModelPicker.tsx";
import { useModelOptions, type ModelOption } from "./chat/modelOptions.ts";
import { useChatStream, type UIMessage } from "./chat/useChatStream.ts";
import { useStickToBottom } from "./chat/useStickToBottom.ts";
import { MODE_META, type Mode } from "./layout/types.ts";
import { lastCodeBlock } from "./shortcuts.ts";
import { useHotkey } from "./ui/hooks.ts";
import { cn } from "./ui/cn.ts";
import { Button, IconButton } from "./ui/primitives.tsx";

export interface ChatPageProps {
  session: SessionMeta;
  onBranch?: (messageId: number) => void;
  onPreview?: (p: Preview) => void;
  onNewSession?: () => void;
  onCandidatesChanged?: () => void;
  onSessionChanged?: () => void; // 新消息 / 自动命名后刷新会话列表
}

// 消息项的操作经由 ref 传入,保持引用稳定,让历史消息在流式过程中跳过重渲染
interface ItemActions {
  regenerate: (override?: { providerId: string; model: string }) => void;
  models?: ModelOption[]; // "换个模型重新生成"的候选
  startEdit: (id: number, content: string) => void;
  branch?: (id: number) => void;
  preview?: (p: Preview) => void;
  switchTo?: (id: number) => void; // 切换到同一位置的另一个版本(F6)
}

// 版本切换 "‹ 2/3 ›":编辑或重新生成后同一位置有多个版本时显示,生成中不可切换
function VersionSwitcher({
  id,
  siblings,
  busy,
  actions,
}: {
  id: number;
  siblings: number[];
  busy: boolean;
  actions: RefObject<ItemActions>;
}) {
  const i = siblings.indexOf(id);
  if (i < 0) return null;
  const go = (d: number) => {
    const target = siblings[i + d];
    if (target != null) actions.current?.switchTo?.(target);
  };
  return (
    <div className="flex items-center font-sans text-2xs text-subtle" aria-label={`版本 ${i + 1} / ${siblings.length}`}>
      <IconButton label="上一个版本" size="xs" disabled={busy || i === 0} onClick={() => go(-1)}>
        <ChevronLeft size={13} strokeWidth={1.75} />
      </IconButton>
      <span className="min-w-[2.25rem] text-center font-mono tabular-nums">
        {i + 1}/{siblings.length}
      </span>
      <IconButton label="下一个版本" size="xs" disabled={busy || i === siblings.length - 1} onClick={() => go(1)}>
        <ChevronRight size={13} strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}

type RefBlock = Extract<ChatBlock, { kind: "ref" }>;

function ChatEmpty({ mode }: { mode: string }) {
  const meta = MODE_META[(mode in MODE_META ? mode : "chat") as Mode];
  const Icon = meta.icon;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface text-muted shadow-pill">
        <Icon size={18} strokeWidth={1.75} aria-hidden />
      </span>
      <div>
        <p className="text-ui font-medium text-fg">开始新的对话</p>
        <p className="mt-1 text-xs text-subtle">{meta.hint} · 输入 @ 引用上下文,/ 使用命令</p>
      </div>
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  m,
  isLast,
  busy,
  editing,
  actions,
  altModels = false,
}: {
  m: UIMessage;
  isLast: boolean;
  busy: boolean;
  editing: boolean;
  actions: RefObject<ItemActions>;
  altModels?: boolean; // 有多个模型可选:末条回复显示"换个模型重新生成"
}) {
  if (m.role === "user") {
    const refs = (m.blocks ?? []).filter((b): b is RefBlock => b.kind === "ref");
    const atts = (m.blocks ?? []).filter((b): b is AttachmentBlockData => b.kind === "attachment");
    const canEdit = m.id != null && !busy;
    // 只发了附件(没有文字)时不显示空气泡;编辑中仍显示,便于看到高亮
    const showText = !!m.content.trim() || editing;
    return (
      <div data-mid={m.id ?? undefined} className="group/msg relative flex flex-col items-end gap-1.5">
        <RefChips refs={refs} />
        <AttachmentList items={atts} />
        {showText && (
          <div
            className={cn(
              "max-w-[85%] rounded-2xl rounded-br-md border border-line bg-surface px-3.5 py-2 text-fg",
              editing && "border-accent/50 ring-2 ring-accent/15",
            )}
          >
            <StreamingMarkdown text={m.content} className="md-user" />
          </div>
        )}
        {/* 浮在消息间距里,不额外占高;pt-1 让悬停区域与气泡相连。版本切换常显,其余操作悬停时出现 */}
        <div className="absolute right-0 top-full flex h-7 items-center gap-0.5 pt-1">
          <div
            className={cn(
              "flex items-center gap-0.5 transition-opacity duration-150",
              editing ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100",
            )}
          >
            {editing && <span className="mr-1 text-2xs text-accent">编辑中…</span>}
            <CopyButton text={m.content} />
            {canEdit && (
              <IconButton label="编辑(保留原版本)" size="xs" onClick={() => actions.current?.startEdit(m.id!, m.content)}>
                <Pencil size={13} strokeWidth={1.75} />
              </IconButton>
            )}
            {m.id != null && actions.current?.branch && (
              <IconButton label="分支到新会话" size="xs" onClick={() => actions.current?.branch?.(m.id!)}>
                <GitBranch size={13} strokeWidth={1.75} />
              </IconButton>
            )}
          </div>
          {m.id != null && m.siblings && <VersionSwitcher id={m.id} siblings={m.siblings} busy={busy} actions={actions} />}
        </div>
      </div>
    );
  }

  const done = !m.streaming;
  // 经 ref 转发,始终调用最新的预览回调
  const preview = actions.current?.preview ? (p: Preview) => actions.current?.preview?.(p) : undefined;
  const hasBody = !!m.content || !!m.blocks?.length;
  const estimate = done && !m.usage && hasBody ? Math.max(0, messageTokens(m) - MESSAGE_OVERHEAD) : 0;

  return (
    <div data-mid={m.id ?? undefined} className="group/msg flex flex-col gap-2 font-reading">
      <MessageBody content={m.content} blocks={m.blocks} streaming={m.streaming} onPreview={preview} />
      {m.error && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-err/25 bg-err/5 px-3 py-2.5 font-sans">
          <TriangleAlert size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-err" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-ui font-medium text-err">{hasBody ? "生成出错,已保留已生成的内容" : "生成失败"}</p>
            <p className="mt-0.5 break-words font-mono text-xs text-muted">{m.error}</p>
          </div>
          {/* 重试即重新生成最后一轮,只对末条有意义;历史中的出错气泡只展示原因 */}
          {isLast && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => actions.current?.regenerate()}>
              <RotateCcw size={13} strokeWidth={1.75} />
              重试
            </Button>
          )}
        </div>
      )}
      {done && (hasBody || m.aborted || m.usage) && (
        <div className="-ml-1 flex h-6 items-center gap-0.5 font-sans">
          {m.id != null && m.siblings && (
            <div className="mr-1">
              <VersionSwitcher id={m.id} siblings={m.siblings} busy={busy} actions={actions} />
            </div>
          )}
          {m.aborted && (
            <span className="mr-1 inline-flex h-5 items-center gap-1 rounded border border-line bg-surface-2 px-1.5 text-2xs text-muted">
              <Square size={8} strokeWidth={0} fill="currentColor" aria-hidden />
              已中断
            </span>
          )}
          <div
            className={cn(
              "flex items-center gap-0.5 transition-opacity duration-150",
              !isLast && "opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100",
            )}
          >
            {!!m.content && <CopyButton text={m.content} />}
            {isLast && !busy && (
              <IconButton label="重新生成" size="xs" onClick={() => actions.current?.regenerate()}>
                <RotateCcw size={13} strokeWidth={1.75} />
              </IconButton>
            )}
            {isLast && !busy && altModels && (
              <ModelPicker
                compact
                options={actions.current?.models ?? []}
                value={null}
                disabled={busy}
                onSelect={(o) => o && actions.current?.regenerate({ providerId: o.providerId, model: o.model })}
              />
            )}
          </div>
          {m.model && (
            <span className="ml-0.5 max-w-[180px] truncate px-1 font-mono text-2xs text-subtle" title={`生成模型:${m.model}`}>
              {m.model}
            </span>
          )}
          {m.trim && (
            <span
              className="ml-0.5 inline-flex items-center gap-1 px-1 text-2xs text-subtle"
              title={
                m.trim.summary
                  ? `上下文超出预算:更早的 ${m.trim.dropped} 条消息以摘要代替`
                  : `上下文超出预算:更早的 ${m.trim.dropped} 条消息未带入,摘要生成后会在之后的回复中带入`
              }
            >
              <FoldVertical size={11} strokeWidth={1.75} aria-hidden />
              {m.trim.summary ? "摘要" : "省略"} {m.trim.dropped} 条
            </span>
          )}
          {m.usage ? (
            <UsageBadge usage={m.usage} />
          ) : (
            estimate > 0 && (
              <span
                className="ml-0.5 px-1 font-mono text-2xs tabular-nums text-subtle"
                title="模型未返回用量,按字符数估算的输出 tokens"
              >
                ≈ {formatTokens(estimate)} tokens
              </span>
            )
          )}
        </div>
      )}
    </div>
  );
});

export function ChatPage({ session, onBranch, onPreview, onNewSession, onCandidatesChanged, onSessionChanged }: ChatPageProps) {
  const { messages, send, stop, regenerate, switchTo, busy, loaded } = useChatStream(session, {
    onDone: onCandidatesChanged,
    onSessionChanged,
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const { scrollRef, contentRef, atBottom, scrollToBottom, release } = useStickToBottom<HTMLDivElement, HTMLDivElement>();

  // M7:从搜索结果跳转。消息加载后定位到目标消息(视口上 1/3 处)并短暂高亮
  const [focusReq, consumeFocus] = useFocusRequest(session.id);
  const switchedFor = useRef<number | null>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!focusReq || !scroller) return;
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-mid="${focusReq.messageId}"]`);
    if (!el) {
      // 已加载但不在当前分支上(旧版本):切到包含它的分支,messages 变化后再定位。还没加载完就等下一次
      if (loaded && !busy && switchedFor.current !== focusReq.messageId) {
        switchedFor.current = focusReq.messageId;
        void switchTo(focusReq.messageId).catch(() => {});
      }
      return;
    }
    release();
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3) });
    el.classList.remove("msg-flash");
    void el.offsetWidth; // 重新触发动画
    el.classList.add("msg-flash");
    setTimeout(() => el.classList.remove("msg-flash"), 2000);
    consumeFocus();
  }, [focusReq, messages, consumeFocus, release, scrollRef, contentRef, loaded, busy, switchTo]);

  // 开始生成(发送 / 重新生成 / 编辑重发)时回到底部并恢复贴底
  useEffect(() => {
    if (busy) scrollToBottom();
  }, [busy, scrollToBottom]);

  const startEdit = (id: number, content: string) => {
    if (busy) return;
    setEditingId(id);
    setEditText(content);
  };

  // 编辑 = 在同一位置发送新版本(F6):原消息与其后的回复保留,可用 "‹ 1/2 ›" 切回
  const submitEdit = (o?: { context?: string; refs?: RefPayload[] }) => {
    if (editingId == null) return;
    const text = editText.trim();
    const id = editingId;
    setEditingId(null);
    setEditText("");
    if (text) void send(text, { ...o, editOf: id });
  };

  // 复制快捷键 / 版本切换的结果提示:底部浮出,1.6s 后消失
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(t);
  }, [toast]);
  const models = useModelOptions();
  const actions = useRef<ItemActions>({ regenerate, startEdit });
  const switchVersion = (id: number) => void switchTo(id).catch(() => setToast({ text: "切换版本失败", ok: false }));
  actions.current = { regenerate, startEdit, branch: onBranch, preview: onPreview, models: models.options, switchTo: switchVersion };

  const copy = (text: string | null, ok: string, empty: string) => {
    if (!text) return setToast({ text: empty, ok: false });
    void navigator.clipboard.writeText(text).then(
      () => setToast({ text: ok, ok: true }),
      () => setToast({ text: "复制失败", ok: false }),
    );
  };
  // 已完成的 assistant 消息,从新到旧
  const finished = () => messages.filter((m) => m.role === "assistant" && !m.streaming && m.content).reverse();
  useHotkey("c", () => copy(finished()[0]?.content ?? null, "已复制最后一条回复", "还没有可复制的回复"), { mod: true, shift: true });
  useHotkey(
    "Semicolon",
    () => {
      let code: string | null = null;
      for (const m of finished()) if ((code = lastCodeBlock(m.content)) !== null) break;
      copy(code, "已复制最后一个代码块", "回复里还没有代码块");
    },
    { mod: true, shift: true },
  );

  // 输入框为空时 ↑:编辑最后一条已落库的 user 消息
  const editLast = () => {
    const last = [...messages].reverse().find((m) => m.role === "user" && m.id != null);
    if (last) startEdit(last.id!, last.content);
  };

  // Esc 停止生成(Shift+Esc 留给"聚焦输入框")
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.shiftKey && stop();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, stop]);

  return (
    <div data-ui className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          data-scroller
          className="min-h-0 flex-1 overflow-y-auto"
          onClick={(e) => handleCodeAction(e.target, onPreview)}
        >
          <div
            ref={contentRef}
            data-no-preview={onPreview ? undefined : ""}
            className="mx-auto flex min-h-full w-full max-w-[792px] flex-col gap-7 px-4 pb-8 pt-6"
          >
            {messages.length === 0 ? (
              <ChatEmpty mode={session.mode} />
            ) : (
              messages.map((m, i) => (
                <MessageItem
                  key={m.localKey ?? m.id ?? `tmp-${i}`}
                  m={m}
                  isLast={i === messages.length - 1}
                  busy={busy}
                  editing={editingId != null && m.id === editingId}
                  actions={actions}
                  altModels={i === messages.length - 1 && models.options.length > 1}
                />
              ))
            )}
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-2">
          <AnimatePresence>
            {toast && (
              <motion.div
                key="toast"
                role="status"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.15 }}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 text-xs text-muted shadow-pop"
              >
                {toast.ok ? (
                  <Check size={13} strokeWidth={2} className="text-ok" aria-hidden />
                ) : (
                  <TriangleAlert size={13} strokeWidth={1.75} className="text-warn" aria-hidden />
                )}
                {toast.text}
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {!atBottom && messages.length > 0 && (
              <motion.button
                key="to-bottom"
                type="button"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.15 }}
                onClick={() => scrollToBottom(true)}
                className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 text-xs text-muted shadow-pop transition-colors hover:text-fg"
              >
                <ArrowDown size={13} strokeWidth={1.75} aria-hidden />
                {busy ? "跟随最新输出" : "回到底部"}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
      <Composer
        session={session}
        busy={busy}
        editingId={editingId}
        editText={editText}
        onEditText={setEditText}
        onCancelEdit={() => {
          setEditingId(null);
          setEditText("");
        }}
        onSubmit={(text, o) => (editingId != null ? submitEdit(o) : void send(text, o))}
        onStop={stop}
        onNewSession={onNewSession}
        onCandidatesChanged={onCandidatesChanged}
        onEditLast={editLast}
        onSessionChanged={onSessionChanged}
        messages={messages}
        models={models}
      />
    </div>
  );
}
