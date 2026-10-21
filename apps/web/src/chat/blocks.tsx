import { AnimatePresence, motion, type Transition } from "motion/react";
import {
  Brain,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Eye,
  File,
  FilePen,
  FileText,
  FolderTree,
  GitBranch,
  GitCompareArrows,
  Globe,
  MessageSquare,
  Search,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatBlock } from "@xiyun/shared";
import { cn } from "../ui/cn.ts";
import { formatElapsed } from "../ui/format.ts";
import { IconButton, StatusDot, type Tone } from "../ui/primitives.tsx";
import { escapeHtml } from "./markdown.ts";
import { StreamingMarkdown } from "./StreamingMarkdown.tsx";

export type Preview =
  | { kind: "artifact"; title: string; body: string; lang?: string }
  | { kind: "tool"; title: string; block: Extract<ChatBlock, { kind: "tool" }> }
  | { kind: "diff"; title: string; workspace: string; path?: string }
  | { kind: "terminal"; title: string; body: string }
  | null;

type ToolBlockData = Extract<ChatBlock, { kind: "tool" }>;
type RefBlockData = Extract<ChatBlock, { kind: "ref" }>;

// 折叠区高度动画:展开/收起只动高度与透明度,内容本身不重排
const reveal = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] } satisfies Transition,
};

// ---------- 复制按钮(带短暂的"已复制"反馈) ----------

export function CopyButton({ text, label = "复制", size = "xs" }: { text: string; label?: string; size?: "xs" | "sm" }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <IconButton
      label={done ? "已复制" : label}
      size={size}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true), () => {})}
    >
      {done ? <Check size={13} strokeWidth={2} className="text-ok" /> : <Copy size={13} strokeWidth={1.75} />}
    </IconButton>
  );
}

// ---------- 思考链 ----------

// 流式中展开并实时计时(呼吸灯 + 跳动秒数),结束后自动折叠为"已思考 N.Ns";
// 用户手动展开/折叠过则不再自动改变。
export function ThinkingBlock({
  block,
  streaming,
}: {
  block: Extract<ChatBlock, { kind: "thinking" }>;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const touched = useRef(false);
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();

  useEffect(() => {
    if (!streaming) {
      if (!touched.current) setOpen(false);
      return;
    }
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [streaming]);

  // 流式中思考区内部保持滚动到底,跟随最新内容
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (streaming && el) el.scrollTop = el.scrollHeight;
  }, [block.text, streaming, open]);

  const ms = block.durationMs ?? (streaming ? now - start : undefined);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          touched.current = true;
          setOpen(!open);
        }}
        className="group -mx-1.5 inline-flex h-7 max-w-full items-center gap-2 self-start rounded-md px-1.5 text-ui text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
      >
        <span className="flex size-3.5 items-center justify-center" aria-hidden>
          {streaming ? (
            <StatusDot tone="accent" pulse className="size-2" />
          ) : (
            <Brain size={14} strokeWidth={1.75} />
          )}
        </span>
        <span className={cn(streaming && "text-shimmer")}>{streaming ? "思考中" : "已思考"}</span>
        {ms !== undefined && (
          <span className="font-mono text-2xs tabular-nums text-subtle" aria-label={`用时 ${formatElapsed(ms)}`}>
            {formatElapsed(ms)}
          </span>
        )}
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          aria-hidden
          className={cn("text-subtle transition-transform duration-200", open && "rotate-90")}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="body" id={bodyId} {...reveal} className="overflow-hidden">
            <div
              ref={bodyRef}
              className="ml-[7px] mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-line pb-0.5 pl-3.5 text-[13px] leading-relaxed text-muted"
            >
              {block.text || (streaming ? "…" : "")}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------- 工具调用卡片 ----------

type ToolPhase = "running" | "pending" | "success" | "error";

const PHASE: Record<ToolPhase, { label: string; tone: Tone }> = {
  running: { label: "运行中", tone: "accent" },
  pending: { label: "待执行", tone: "neutral" },
  success: { label: "成功", tone: "ok" },
  error: { label: "错误", tone: "err" },
};

const PILL_TONE: Record<Tone, string> = {
  neutral: "text-muted",
  accent: "text-accent",
  ok: "text-ok",
  err: "text-err",
  warn: "text-warn",
};

// running:参数仍在流式生成(尚未收到 block_end);pending:参数已就绪,等待执行
function toolPhase(b: ToolBlockData, live: boolean): ToolPhase {
  if (b.status === "error") return "error";
  if (b.status === "success") return "success";
  if (live && b.args === undefined && !b.argsError) return "running";
  return "pending";
}

function toolIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (/(shell|exec|command|terminal|bash|run)/.test(n)) return SquareTerminal;
  if (/(write|edit|patch|apply|replace|create|update|delete|remove)/.test(n)) return FilePen;
  if (/(read|open|view|cat|get_file)/.test(n)) return FileText;
  if (/(list|tree|ls|dir)/.test(n)) return FolderTree;
  if (/(search|grep|find|glob)/.test(n)) return Search;
  if (/(web|fetch|http|url|browse)/.test(n)) return Globe;
  if (/git/.test(n)) return GitBranch;
  return Wrench;
}

const SUMMARY_KEYS = ["path", "file", "filePath", "file_path", "command", "cmd", "query", "pattern", "url"];

// 卡片头的单行摘要:优先展示路径/命令等关键参数,否则为紧凑 JSON;流式中显示原始参数尾部
function toolSummary(b: ToolBlockData): string {
  const a = b.args;
  if (a && typeof a === "object" && !Array.isArray(a)) {
    const o = a as Record<string, unknown>;
    for (const k of SUMMARY_KEYS) {
      const v = o[k];
      if (typeof v === "string" && v) return v;
    }
    const compact = JSON.stringify(a);
    return compact === "{}" ? "" : compact;
  }
  if (a !== undefined) return JSON.stringify(a);
  // 参数仍在流式拼接(JSON 未闭合):尽量取出已到达的关键字段,否则显示原文尾部
  for (const k of SUMMARY_KEYS) {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(b.rawArgs);
    if (m?.[1]) return m[1].replace(/\\(.)/g, "$1");
  }
  return b.rawArgs.replace(/\s+/g, " ").slice(-96);
}

function highlightJson(text: string): string {
  if (typeof hljs !== "undefined" && hljs.getLanguage("json")) return hljs.highlight(text, { language: "json" }).value;
  return escapeHtml(text);
}

function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex h-6 items-center justify-between">
        <span className="text-2xs font-medium uppercase tracking-wide text-subtle">{label}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ToolBlock({
  block,
  live = false,
  onPreview,
}: {
  block: ToolBlockData;
  live?: boolean; // 所属消息仍在流式生成
  onPreview?: (p: Preview) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const phase = toolPhase(block, live);
  const Icon = toolIcon(block.name);
  const summary = toolSummary(block);
  const label = block.note || PHASE[phase].label;
  const parsed = block.args !== undefined;
  const argsText = parsed ? JSON.stringify(block.args, null, 2) : block.rawArgs;
  const argsHtml = useMemo(() => (parsed ? highlightJson(argsText) : escapeHtml(argsText)), [parsed, argsText]);
  const target = block.target;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-surface/60 font-sans transition-colors duration-150",
        phase === "error" ? "border-err/30" : "border-line",
      )}
      data-phase={phase}
    >
      <div className="flex h-9 items-center pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="group flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-1.5 text-left"
        >
          <Icon
            size={14}
            strokeWidth={1.75}
            aria-hidden
            className={cn("shrink-0", phase === "error" ? "text-err" : phase === "running" ? "text-accent" : "text-muted")}
          />
          <span className="shrink-0 font-mono text-xs font-medium text-fg">{block.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-subtle" title={summary}>
            {summary}
          </span>
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-2xs", PILL_TONE[PHASE[phase].tone])}>
            {phase === "running" && <StatusDot tone="accent" pulse />}
            {phase === "pending" && <Clock size={12} strokeWidth={1.75} aria-hidden />}
            {phase === "success" && <Check size={12} strokeWidth={2} aria-hidden />}
            {phase === "error" && <X size={12} strokeWidth={2} aria-hidden />}
            <span className={cn(phase === "running" && "text-shimmer")}>{label}</span>
          </span>
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            aria-hidden
            className={cn("shrink-0 text-subtle transition-transform duration-200 group-hover:text-muted", open && "rotate-90")}
          />
        </button>
        {onPreview && (
          <div className="flex shrink-0 items-center gap-0.5 border-l border-line pl-1">
            <IconButton label="在预览中查看" size="xs" onClick={() => onPreview({ kind: "tool", title: block.name, block })}>
              <Eye size={13} strokeWidth={1.75} />
            </IconButton>
            {target?.workspace && (
              <IconButton
                label="查看 Diff"
                size="xs"
                onClick={() =>
                  onPreview({
                    kind: "diff",
                    title: target.path ?? "工作区 Diff",
                    workspace: target.workspace!,
                    path: target.path,
                  })
                }
              >
                <GitCompareArrows size={13} strokeWidth={1.75} />
              </IconButton>
            )}
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="body" id={bodyId} {...reveal} className="overflow-hidden">
            <div className="flex flex-col gap-2.5 border-t border-line px-3 pb-3 pt-1.5">
              <Section label={parsed ? "参数" : "原始参数"} action={argsText ? <CopyButton text={argsText} label="复制参数" /> : undefined}>
                <pre className="max-h-64 overflow-auto rounded-md border border-line bg-code px-3 py-2 font-mono text-xs leading-relaxed text-code-fg">
                  <code className="hljs" dangerouslySetInnerHTML={{ __html: argsHtml || "<span class=\"text-subtle\">(空)</span>" }} />
                  {phase === "running" && <span className="stream-caret" aria-hidden />}
                </pre>
              </Section>
              {block.argsError && (
                <Section label="解析失败">
                  <p className="rounded-md border border-err/25 bg-err/5 px-3 py-2 font-mono text-xs text-err">{block.argsError}</p>
                </Section>
              )}
              {target?.workspace && (
                <Section label="目标">
                  <p className="break-all font-mono text-xs text-muted">
                    {target.workspace}
                    {target.path && <span className="text-fg"> / {target.path}</span>}
                  </p>
                </Section>
              )}
              {phase === "pending" && (
                <p className="text-2xs leading-relaxed text-subtle">模型请求调用该工具;当前版本不会自动执行。</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------- 引用胶囊(用户消息上方) ----------

const REF_ICON: Record<RefBlockData["refType"], LucideIcon> = {
  message: MessageSquare,
  doc: FileText,
  file: File,
};

export function RefChips({ refs }: { refs: RefBlockData[] }) {
  if (!refs.length) return null;
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
      {refs.map((r) => {
        const Icon = REF_ICON[r.refType] ?? File;
        return (
          <span
            key={r.id}
            title={r.excerpt}
            className="inline-flex h-6 max-w-[240px] items-center gap-1 rounded-md border border-line bg-surface px-1.5 text-xs text-muted shadow-pill"
          >
            <Icon size={12} strokeWidth={1.75} className="shrink-0 text-subtle" aria-hidden />
            <span className="truncate">{r.label}</span>
          </span>
        );
      })}
    </div>
  );
}

// ---------- 消息正文 ----------

function PendingReply() {
  return (
    <div className="flex h-7 items-center gap-2 text-ui text-subtle" role="status">
      <StatusDot tone="accent" pulse className="size-2" />
      <span className="text-shimmer">正在生成</span>
    </div>
  );
}

export function MessageBody({
  content,
  blocks,
  streaming,
  onPreview,
}: {
  content: string;
  blocks?: ChatBlock[];
  streaming?: boolean;
  onPreview?: (p: Preview) => void;
}) {
  // ref 块只属于用户消息,在气泡上方单独渲染
  const shown = (blocks ?? []).filter((b) => b.kind !== "ref");
  const live = !!streaming;

  if (!shown.length) {
    if (live && !content) return <PendingReply />;
    return <StreamingMarkdown text={content} streaming={live} />;
  }

  const last = shown.length - 1;
  return (
    <div className="flex flex-col gap-3">
      {shown.map((b, i) => {
        if (b.kind === "thinking")
          return <ThinkingBlock key={b.id} block={b} streaming={live && b.durationMs === undefined} />;
        if (b.kind === "tool") return <ToolBlock key={b.id} block={b} live={live} onPreview={onPreview} />;
        if (b.kind === "text") {
          if (!b.text) return live && i === last ? <PendingReply key={b.id} /> : null;
          return <StreamingMarkdown key={b.id} text={b.text} streaming={live && i === last} />;
        }
        return null;
      })}
    </div>
  );
}
