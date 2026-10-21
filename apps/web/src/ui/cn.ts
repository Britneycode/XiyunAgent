import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// 自定义字号 text-2xs / text-ui 需要登记到 text 主题刻度,
// 否则 tailwind-merge 会把 text-ui 当成颜色类,与 text-fg 互相覆盖。
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "ui"],
    },
  },
});

// 合并条件类名,并让后出现的工具类覆盖冲突的前者(如 px-2 与 px-3)。
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
