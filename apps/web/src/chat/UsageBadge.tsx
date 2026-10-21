import { AnimatePresence } from "motion/react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { TokenUsage } from "@xiyun/shared";
import { cn } from "../ui/cn.ts";
import { PopoverSurface } from "../ui/menu.tsx";
import { formatTokens, formatTokensFull } from "./tokens.ts";

// 明细浮层的预估高度;上方空间不足时改为向下展开,避免被消息滚动区裁切
const POPOVER_SPACE = 150;

function Row({ label, value, sub = false, strong = false }: { label: string; value: number; sub?: boolean; strong?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between gap-6", sub && "pl-3 text-2xs")}>
      <span className={strong ? "text-fg" : sub ? "text-subtle" : "text-muted"}>{label}</span>
      <span className={cn("font-mono tabular-nums", strong ? "text-fg" : sub ? "text-subtle" : "text-muted")}>
        {formatTokensFull(value)}
      </span>
    </div>
  );
}

// 单条回复的实测 token 用量:↑ 输入 ↓ 输出,悬停/聚焦展开明细
export function UsageBadge({ usage }: { usage: TokenUsage }) {
  const [open, setOpen] = useState(false);
  const [below, setBelow] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  const show = () => {
    const el = ref.current;
    const scroller = el?.closest(".chat-messages");
    if (el && scroller) {
      setBelow(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top < POPOVER_SPACE);
    }
    setOpen(true);
  };

  return (
    <span data-ui ref={ref} className="relative inline-flex" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-describedby={open ? tipId : undefined}
        aria-label={`本轮输入 ${usage.promptTokens} tokens,输出 ${usage.completionTokens} tokens`}
        onFocus={show}
        onBlur={() => setOpen(false)}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-2xs tabular-nums",
          "text-subtle transition-colors duration-150 hover:bg-surface-2 hover:text-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        )}
      >
        <ArrowUp className="size-3" strokeWidth={1.75} aria-hidden />
        <span>{formatTokens(usage.promptTokens)}</span>
        <ArrowDown className="ml-0.5 size-3" strokeWidth={1.75} aria-hidden />
        <span>{formatTokens(usage.completionTokens)}</span>
        <span className="ml-0.5">tokens</span>
      </button>
      <AnimatePresence>
        {open && (
          <PopoverSurface
            id={tipId}
            role="tooltip"
            placement={below ? "bottom-start" : "top-start"}
            className={cn("absolute left-0 w-60 gap-1.5 p-3 text-xs", below ? "top-full mt-1.5" : "bottom-full mb-1.5")}
          >
            <div className="mb-0.5 text-2xs font-medium uppercase tracking-wide text-subtle">本轮用量 · 实测</div>
            <Row label="输入" value={usage.promptTokens} />
            {!!usage.cachedTokens && <Row sub label="其中缓存命中" value={usage.cachedTokens} />}
            <Row label="输出" value={usage.completionTokens} />
            {!!usage.reasoningTokens && <Row sub label="其中推理" value={usage.reasoningTokens} />}
            <div className="my-1 border-t border-line" />
            <Row label="合计" strong value={usage.totalTokens} />
            <p className="mt-1 text-2xs leading-relaxed text-subtle">输入包含系统提示、记忆、历史与引用上下文。</p>
          </PopoverSurface>
        )}
      </AnimatePresence>
    </span>
  );
}
