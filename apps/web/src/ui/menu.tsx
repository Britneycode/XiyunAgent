import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "./cn.ts";

// ---------- 浮层容器 ----------

export type PopoverPlacement = "top-start" | "top-end" | "bottom-start" | "bottom-end";

const ORIGIN: Record<PopoverPlacement, string> = {
  "top-start": "bottom left",
  "top-end": "bottom right",
  "bottom-start": "top left",
  "bottom-end": "top right",
};

// 统一的浮层外观与入场动画;定位由调用方通过 className 决定(absolute + bottom-full 等)。
export function PopoverSurface({
  placement = "top-start",
  className,
  children,
  ...aria
}: {
  placement?: PopoverPlacement;
  className?: string;
  children: ReactNode;
  id?: string;
  role?: string;
  "aria-label"?: string;
}) {
  const offset = placement.startsWith("top") ? 4 : -4;
  return (
    <motion.div
      {...aria}
      initial={{ opacity: 0, y: offset, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: offset, scale: 0.98, transition: { duration: 0.08 } }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      style={{ transformOrigin: ORIGIN[placement] }}
      className={cn(
        "z-30 flex flex-col overflow-hidden rounded-xl border border-line bg-elevated text-fg shadow-pop",
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

// ---------- 列表键盘导航 ----------

// 活动项索引:越界时按当前数量夹紧,调用方在查询变化时显式 reset。
export function useActiveIndex(count: number): {
  index: number;
  setIndex: (i: number) => void;
  move: (delta: number) => void;
  reset: () => void;
} {
  const [raw, setRaw] = useState(0);
  const index = count === 0 ? -1 : Math.min(Math.max(raw, 0), count - 1);
  const move = useCallback(
    (delta: number) =>
      setRaw((i) => {
        if (count === 0) return 0;
        const cur = Math.min(Math.max(i, 0), count - 1);
        return (cur + delta + count) % count;
      }),
    [count],
  );
  const reset = useCallback(() => setRaw(0), []);
  return { index, setIndex: setRaw, move, reset };
}

// 可滚动的选项容器:活动项变化时滚动到可见区域
export function MenuList({
  activeIndex,
  className,
  children,
}: {
  activeIndex: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  return (
    <div ref={ref} className={cn("min-h-0 overflow-y-auto overscroll-contain p-1", className)}>
      {children}
    </div>
  );
}

export function MenuGroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="presentation"
      className={cn("flex h-6 items-center px-2 text-2xs font-medium uppercase tracking-wide text-subtle", className)}
    >
      {children}
    </div>
  );
}

// 单个选项:焦点留在输入框(mousedown 阻止默认),鼠标移动才改变活动项,避免键盘滚动时被指针抢走高亮。
export function MenuItem({
  id,
  active,
  selected,
  icon: Icon,
  label,
  detail,
  trailing,
  mono = false,
  onSelect,
  onHover,
}: {
  id?: string;
  active: boolean;
  selected?: boolean;
  icon?: LucideIcon;
  label: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  mono?: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected ?? active}
      data-active={active}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => !active && onHover()}
      onClick={onSelect}
      className={cn(
        "flex min-h-8 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-75",
        active ? "bg-surface-2 text-fg" : "text-muted",
      )}
    >
      {Icon && (
        <span
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-md border border-line bg-surface transition-colors",
            active ? "text-fg" : "text-subtle",
          )}
        >
          <Icon size={13} strokeWidth={1.75} aria-hidden />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-ui leading-5", active ? "text-fg" : "text-fg/90", mono && "font-mono text-xs")}>
          {label}
        </span>
        {detail && <span className="truncate text-2xs text-subtle">{detail}</span>}
      </span>
      {trailing}
    </div>
  );
}

// 查询高亮:只标第一处匹配,大小写不敏感
export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-semibold text-accent">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

// 点击浮层外部时关闭;ref 覆盖触发器与浮层的共同容器
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, onDismiss: () => void): void {
  const cb = useRef(onDismiss);
  useEffect(() => {
    cb.current = onDismiss;
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, ref]);
}
