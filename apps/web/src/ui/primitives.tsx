import type { ComponentPropsWithRef, ReactNode } from "react";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { cn } from "./cn.ts";

// ---------- Button ----------

export type ButtonVariant = "ghost" | "subtle" | "outline" | "primary" | "danger";
export type ButtonSize = "xs" | "sm" | "md";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  ghost: "bg-transparent text-muted hover:bg-surface-2 hover:text-fg",
  subtle: "bg-surface-2 text-fg hover:bg-surface-3",
  outline: "border border-line bg-transparent text-fg hover:border-line-strong hover:bg-surface-2",
  primary: "bg-accent text-accent-fg hover:bg-accent/90",
  danger: "bg-transparent text-err hover:bg-err/10",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  xs: "h-6 gap-1 rounded px-1.5 text-2xs",
  sm: "h-7 gap-1.5 rounded-md px-2 text-xs",
  md: "h-8 gap-2 rounded-md px-3 text-ui",
};

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = "outline", size = "sm", className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium",
        "transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45",
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
      {...rest}
    />
  );
}

// ---------- IconButton ----------

const ICON_SIZE: Record<ButtonSize, string> = {
  xs: "size-6 rounded",
  sm: "size-7 rounded-md",
  md: "size-8 rounded-md",
};

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  label: string; // 同时作为 aria-label 与悬停提示
  kbd?: string; // 快捷键提示,拼在悬停提示中
  size?: ButtonSize;
  active?: boolean;
  tone?: "default" | "danger";
  children: ReactNode;
}

export function IconButton({
  label,
  kbd,
  size = "sm",
  active = false,
  tone = "default",
  className,
  type = "button",
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-pressed={active || undefined}
      title={kbd ? `${label}(${kbd})` : label}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-45",
        tone === "danger"
          ? "text-muted hover:bg-err/10 hover:text-err"
          : "text-muted hover:bg-surface-2 hover:text-fg",
        active && "bg-surface-2 text-fg",
        ICON_SIZE[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------- Badge ----------

export type Tone = "neutral" | "accent" | "ok" | "err" | "warn";

const BADGE_TONE: Record<Tone, string> = {
  neutral: "border-line bg-surface-2 text-muted",
  accent: "border-accent/30 bg-accent-soft text-accent",
  ok: "border-ok/30 bg-ok/10 text-ok",
  err: "border-err/30 bg-err/10 text-err",
  warn: "border-warn/30 bg-warn/10 text-warn",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded border px-1.5 font-mono text-2xs leading-none",
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// 图标角标上的计数气泡
export function CountBubble({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "pointer-events-none inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1",
        "font-mono text-[9px] font-semibold leading-none tabular-nums text-accent-fg",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

// ---------- Kbd ----------

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 items-center rounded border border-line bg-surface-2 px-1 font-mono text-[10px] leading-none text-subtle",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// ---------- StatusDot ----------

const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-subtle",
  accent: "bg-accent",
  ok: "bg-ok",
  err: "bg-err",
  warn: "bg-warn",
};

export function StatusDot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_TONE[tone], pulse && "animate-breathe", className)}
    />
  );
}

// ---------- Tabs(下划线指示器,motion 共享布局动画) ----------

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  badge?: number;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  layoutId,
  className,
}: {
  items: Array<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  layoutId: string; // 同一页面内多个 Tabs 需要不同 id,避免指示器串组
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("flex h-full items-stretch gap-0.5", className)}>
      {items.map((item) => {
        const selected = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.id)}
            className={cn(
              "relative inline-flex items-center gap-1.5 px-2 text-xs transition-colors duration-150",
              selected ? "text-fg" : "text-muted hover:text-fg",
            )}
          >
            {Icon && <Icon size={13} strokeWidth={1.75} aria-hidden />}
            <span>{item.label}</span>
            {item.badge !== undefined && item.badge > 0 && (
              <span className="font-mono text-2xs tabular-nums text-subtle">{item.badge}</span>
            )}
            {selected && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-x-1.5 -bottom-px h-px bg-accent"
                transition={{ type: "spring", stiffness: 520, damping: 40 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------- 骨架占位 ----------

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded bg-surface-2", className)} />;
}
