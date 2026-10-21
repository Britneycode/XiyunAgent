import { AnimatePresence } from "motion/react";
import { useId, useState } from "react";
import { cn } from "../ui/cn.ts";
import { PopoverSurface } from "../ui/menu.tsx";
import { formatTokens, formatTokensFull, type ContextBaseline } from "./tokens.ts";

type Level = "normal" | "warn" | "danger";

const LEVEL_TEXT: Record<Level, string> = {
  normal: "text-accent",
  warn: "text-warn",
  danger: "text-err",
};

// 环形占用指示:有上下文窗口时显示比例
function Ring({ ratio, level }: { ratio: number; level: Level }) {
  const r = 5.25;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="1.75" className="stroke-line-strong" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - (ratio > 0 ? Math.max(0.04, ratio) : 0))}
        className={cn("stroke-current transition-[stroke-dashoffset] duration-300", LEVEL_TEXT[level])}
      />
    </svg>
  );
}

function Row({
  label,
  value,
  strong = false,
  sub = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  sub?: boolean; // 缩进的子项(缓存命中、推理)
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4", sub && "pl-3 text-2xs")}>
      <span className={strong ? "text-fg" : sub ? "text-subtle" : "text-muted"}>{label}</span>
      <span className={cn("font-mono tabular-nums", strong ? "text-fg" : sub ? "text-subtle" : "text-muted")}>
        {value}
      </span>
    </div>
  );
}

function Tag({ tone, children }: { tone: "ok" | "muted"; children: string }) {
  return (
    <span
      className={cn(
        "rounded-[5px] px-1.5 py-px text-2xs font-medium normal-case tracking-normal",
        tone === "ok"
          ? "bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-ok"
          : "bg-surface-3 text-muted",
      )}
    >
      {children}
    </span>
  );
}

// 上下文 token 计数:优先使用模型返回的实测用量作为基线,基线之后的新增内容按本地估算叠加;
// 模型从未返回用量时整体退回估算,并以 "≈" 标注。悬停/聚焦展开明细。
export function TokenMeter({
  baseline,
  refs,
  draft,
  contextLength,
}: {
  baseline: ContextBaseline;
  refs: number;
  draft: number;
  contextLength?: number;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const { usage, carried, pending, session } = baseline;
  const measured = usage !== null;
  const added = pending + refs + draft;
  const total = carried + added;
  const ratio = contextLength ? Math.min(1, total / contextLength) : null;
  const level: Level = ratio === null ? "normal" : ratio >= 0.95 ? "danger" : ratio >= 0.8 ? "warn" : "normal";
  const approx = measured ? "" : "≈ ";
  const totalText = contextLength
    ? `${approx}${formatTokens(total)} / ${formatTokens(contextLength)}`
    : `${approx}${formatTokens(total)}`;

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-describedby={open ? tipId : undefined}
        aria-label={
          measured
            ? `上下文 ${total} tokens,基于上一轮实测用量`
            : `上下文约 ${total} tokens,本地估算`
        }
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-lg px-1.5 font-mono text-2xs tabular-nums transition-colors duration-150",
          "text-subtle hover:bg-surface-2 hover:text-muted",
          level !== "normal" && LEVEL_TEXT[level],
        )}
      >
        {ratio !== null && <Ring ratio={ratio} level={level} />}
        <span>
          {approx}
          {formatTokens(total)}
        </span>
        <span className="hidden @[520px]:inline">tokens</span>
      </button>
      <AnimatePresence>
        {open && (
          <PopoverSurface
            id={tipId}
            role="tooltip"
            placement="top-end"
            className="absolute right-0 bottom-full mb-2 w-72 gap-1.5 p-3 text-xs"
          >
            <div className="mb-0.5 flex items-center justify-between text-2xs font-medium uppercase tracking-wide text-subtle">
              <span>上下文</span>
              {measured ? <Tag tone="ok">实测</Tag> : <Tag tone="muted">估算</Tag>}
            </div>

            {usage ? (
              <>
                <Row label="上一轮输入" value={formatTokensFull(usage.promptTokens)} />
                {!!usage.cachedTokens && (
                  <Row sub label="其中缓存命中" value={formatTokensFull(usage.cachedTokens)} />
                )}
                <Row label="上一轮输出" value={formatTokensFull(usage.completionTokens)} />
                {!!usage.reasoningTokens && (
                  <Row sub label="其中推理(不带入下一轮)" value={formatTokensFull(usage.reasoningTokens)} />
                )}
                <Row label="新增内容" value={`≈ ${formatTokensFull(added)}`} />
              </>
            ) : (
              <>
                <Row label="历史消息" value={`≈ ${formatTokensFull(pending)}`} />
                <Row label="引用内容" value={`≈ ${formatTokensFull(refs)}`} />
                <Row label="当前输入" value={`≈ ${formatTokensFull(draft)}`} />
              </>
            )}

            <div className="my-1 border-t border-line" />
            <Row label={measured ? "预计下一轮" : "合计"} strong value={totalText} />
            {ratio !== null && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
                <div
                  className={cn("h-full rounded-full bg-current transition-[width] duration-300", LEVEL_TEXT[level])}
                  style={{ width: `${Math.max(2, ratio * 100)}%` }}
                />
              </div>
            )}

            {session.turns > 0 && (
              <>
                <div className="mt-1.5 text-2xs font-medium uppercase tracking-wide text-subtle">
                  本会话累计 · {session.turns} 轮
                </div>
                <Row label="输入" value={formatTokensFull(session.prompt)} />
                {session.cached > 0 && <Row sub label="其中缓存命中" value={formatTokensFull(session.cached)} />}
                <Row label="输出" value={formatTokensFull(session.completion)} />
              </>
            )}

            <p className="mt-1 text-2xs leading-relaxed text-subtle">
              {measured
                ? "实测值由模型在每轮回复末尾返回,已包含系统提示、记忆与引用;新增内容(之后的消息、引用与当前输入)为本地估算。"
                : "当前会话的模型未返回用量,以上为本地估算(中文约 1 字 ≈ 1 token,英文/代码约 4 字符 ≈ 1 token),不含系统提示与记忆注入。"}
            </p>
          </PopoverSurface>
        )}
      </AnimatePresence>
    </div>
  );
}
