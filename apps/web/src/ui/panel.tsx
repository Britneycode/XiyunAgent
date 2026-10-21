import type { ComponentPropsWithRef, ReactNode } from "react";
import { CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "./cn.ts";
import type { Tone } from "./primitives.tsx";

// 检查器面板的通用构件:头部、提示条、空态、表单控件。

export function PanelHeader({
  icon: Icon,
  title,
  meta,
  actions,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface/95 pl-3 pr-1.5 backdrop-blur",
        className,
      )}
    >
      {Icon && <Icon size={14} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden />}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-fg">{title}</span>
        {meta}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

type NoticeTone = Extract<Tone, "neutral" | "ok" | "err" | "warn">;

const NOTICE_TONE: Record<NoticeTone, string> = {
  neutral: "border-line bg-surface-2/60 text-muted",
  ok: "border-ok/30 bg-ok/10 text-ok",
  err: "border-err/25 bg-err/5 text-err",
  warn: "border-warn/30 bg-warn/10 text-warn",
};

export function Notice({
  tone = "neutral",
  children,
  action,
  className,
}: {
  tone?: NoticeTone;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = tone === "neutral" ? Info : tone === "ok" ? CircleCheck : TriangleAlert;
  return (
    <div
      role={tone === "err" ? "alert" : undefined}
      className={cn("flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs leading-relaxed", NOTICE_TONE[tone], className)}
    >
      <Icon size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action && <div className="-my-0.5 flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  );
}

export function PanelEmpty({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-6 py-12 text-center", className)}>
      <span className="grid size-9 place-items-center rounded-lg border border-line bg-canvas text-subtle">
        <Icon size={16} strokeWidth={1.6} aria-hidden />
      </span>
      <p className="text-ui font-medium text-fg">{title}</p>
      {description && <p className="max-w-[280px] text-xs leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function SectionLabel({ children, meta, className }: { children: ReactNode; meta?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-6 items-center justify-between gap-2", className)}>
      <span className="text-2xs font-medium uppercase tracking-wide text-subtle">{children}</span>
      {meta}
    </div>
  );
}

const FIELD =
  "w-full min-w-0 rounded-md border border-line bg-elevated text-ui text-fg outline-none transition-[border-color,box-shadow] duration-150 " +
  "placeholder:text-subtle focus:border-accent/60 focus:ring-2 focus:ring-accent/15 disabled:opacity-50";

export function TextInput({ className, mono = false, ...rest }: ComponentPropsWithRef<"input"> & { mono?: boolean }) {
  return <input className={cn(FIELD, "h-8 px-2.5", mono && "font-mono text-xs", className)} {...rest} />;
}

export function TextArea({ className, ...rest }: ComponentPropsWithRef<"textarea">) {
  return <textarea className={cn(FIELD, "resize-y px-2.5 py-2 leading-relaxed", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentPropsWithRef<"select">) {
  return (
    <select className={cn(FIELD, "h-8 cursor-pointer px-2 text-xs", className)} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({ className, ...rest }: Omit<ComponentPropsWithRef<"input">, "type">) {
  return <input type="checkbox" className={cn("size-3.5 shrink-0 cursor-pointer accent-accent", className)} {...rest} />;
}
