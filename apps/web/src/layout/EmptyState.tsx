import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../ui/cn.ts";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  spin = false,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  spin?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="grid size-10 place-items-center rounded-xl border border-line bg-surface text-muted">
        <Icon size={18} strokeWidth={1.6} className={cn(spin && "animate-spin")} aria-hidden />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-ui font-medium text-fg">{title}</p>
        {description && <p className="text-xs leading-relaxed text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
