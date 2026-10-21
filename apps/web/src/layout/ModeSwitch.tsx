import { motion } from "motion/react";
import { useRef, type KeyboardEvent } from "react";
import { cn } from "../ui/cn.ts";
import { MODE_META, MODES, type Mode } from "./types.ts";

// 模式分段控件(参考 Claude 桌面端 Cowork | Code):
// 横向用于展开的侧栏,纵向(仅图标)用于收起后的窄栏。方向键在模式间移动并立即切换。
export function ModeSwitch({
  mode,
  onChange,
  orientation = "horizontal",
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
  orientation?: "horizontal" | "vertical";
}) {
  const vertical = orientation === "vertical";
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const prevKey = vertical ? "ArrowUp" : "ArrowLeft";
    const nextKey = vertical ? "ArrowDown" : "ArrowRight";
    if (e.key !== prevKey && e.key !== nextKey && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const cur = MODES.indexOf(mode);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? MODES.length - 1
          : (cur + (e.key === nextKey ? 1 : -1) + MODES.length) % MODES.length;
    onChange(MODES[next]);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="工作模式"
      aria-orientation={orientation}
      onKeyDown={onKeyDown}
      className={cn("relative flex gap-0.5 rounded-[10px] bg-surface-2 p-[3px]", vertical && "flex-col")}
    >
      {MODES.map((m, i) => {
        const meta = MODE_META[m];
        const Icon = meta.icon;
        const active = m === mode;
        return (
          <button
            key={m}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={meta.label}
            tabIndex={active ? 0 : -1}
            title={`${meta.label} · ${meta.hint}(Ctrl+${i + 1})`}
            onClick={() => onChange(m)}
            className={cn(
              "relative flex items-center justify-center gap-1.5 rounded-[7px] text-ui transition-colors duration-150",
              vertical ? "size-8" : "h-7 min-w-0 flex-1 px-2",
              active ? "text-fg" : "text-subtle hover:text-muted",
            )}
          >
            {active && (
              <motion.span
                layoutId={`mode-pill-${orientation}`}
                aria-hidden
                className="absolute inset-0 rounded-[7px] border border-line bg-elevated shadow-pill"
                transition={{ type: "spring", stiffness: 560, damping: 42 }}
              />
            )}
            <Icon size={vertical ? 15 : 14} strokeWidth={1.75} className="relative shrink-0" aria-hidden />
            {!vertical && <span className="relative truncate font-medium">{meta.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
