import { AnimatePresence } from "motion/react";
import { useId, useState } from "react";
import { cn } from "../ui/cn.ts";
import { PopoverSurface } from "../ui/menu.tsx";
import { formatTokens } from "./tokens.ts";

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

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className={strong ? "text-fg" : "text-muted"}>{label}</span>
      <span className={cn("font-mono tabular-nums", strong ? "text-fg" : "text-muted")}>{value}</span>
    </div>
  );
}

// 上下文 token 估算:悬停/聚焦展开明细。数值为本地估算,统一以 "≈" 标注。
export function TokenMeter({
  history,
  refs,
  draft,
  contextLength,
}: {
  history: number;
  refs: number;
  draft: number;
  contextLength?: number;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const total = history + refs + draft;
  const ratio = contextLength ? Math.min(1, total / contextLength) : null;
  const level: Level = ratio === null ? "normal" : ratio >= 0.95 ? "danger" : ratio >= 0.8 ? "warn" : "normal";

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-describedby={open ? tipId : undefined}
        aria-label={`上下文约 ${total} tokens`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-lg px-1.5 font-mono text-2xs tabular-nums transition-colors duration-150",
          "text-subtle hover:bg-surface-2 hover:text-muted",
          level !== "normal" && LEVEL_TEXT[level],
        )}
      >
        {ratio !== null && <Ring ratio={ratio} level={level} />}
        <span>≈ {formatTokens(total)}</span>
        <span className="hidden @[520px]:inline">tokens</span>
      </button>
      <AnimatePresence>
        {open && (
          <PopoverSurface
            id={tipId}
            role="tooltip"
            placement="top-end"
            className="absolute right-0 bottom-full mb-2 w-64 gap-1.5 p-3 text-xs"
          >
            <div className="mb-0.5 text-2xs font-medium uppercase tracking-wide text-subtle">上下文估算</div>
            <Row label="历史消息" value={`≈ ${formatTokens(history)}`} />
            <Row label="引用内容" value={`≈ ${formatTokens(refs)}`} />
            <Row label="当前输入" value={`≈ ${formatTokens(draft)}`} />
            <div className="my-1 border-t border-line" />
            <Row
              label="合计"
              strong
              value={
                contextLength
                  ? `≈ ${formatTokens(total)} / ${formatTokens(contextLength)}`
                  : `≈ ${formatTokens(total)}`
              }
            />
            {ratio !== null && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
                <div
                  className={cn("h-full rounded-full bg-current transition-[width] duration-300", LEVEL_TEXT[level])}
                  style={{ width: `${Math.max(2, ratio * 100)}%` }}
                />
              </div>
            )}
            <p className="mt-1 text-2xs leading-relaxed text-subtle">
              本地估算(中文约 1 字 ≈ 1 token,英文/代码约 4 字符 ≈ 1 token),不含系统提示与记忆注入;
              引用的文件与文档在发送时读取全文。
            </p>
          </PopoverSurface>
        )}
      </AnimatePresence>
    </div>
  );
}
