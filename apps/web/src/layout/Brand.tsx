import { cn } from "../ui/cn.ts";

// 品牌标记:强调色圆角方块 + 字母。尺寸随所在栏位变化。
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 select-none place-items-center rounded-[7px] bg-accent font-mono text-[11px] font-bold text-accent-fg",
        className,
      )}
    >
      X
    </span>
  );
}
