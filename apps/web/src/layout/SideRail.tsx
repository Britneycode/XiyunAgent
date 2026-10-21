import { Brain, PanelLeftOpen, Plus, Search, Settings2 } from "lucide-react";
import { CountBubble, IconButton } from "../ui/primitives.tsx";
import { ModeSwitch } from "./ModeSwitch.tsx";
import type { Mode, Page } from "./types.ts";

// 收起态窄栏:保留模式切换与高频入口,任何操作都无需先展开侧栏。
export function SideRail({
  mode,
  page,
  pendingCandidates,
  onExpand,
  onModeChange,
  onNew,
  onSearch,
  onOpenPage,
}: {
  mode: Mode;
  page: Page;
  pendingCandidates: number;
  onExpand: () => void;
  onModeChange: (mode: Mode) => void;
  onNew: () => void;
  onSearch: () => void;
  onOpenPage: (page: Exclude<Page, "main">) => void;
}) {
  return (
    <nav aria-label="主导航" className="flex h-full w-[var(--w-rail)] flex-col items-center gap-1 py-2">
      <IconButton label="展开侧栏" kbd="Ctrl+B" size="md" onClick={onExpand}>
        <PanelLeftOpen size={16} strokeWidth={1.6} />
      </IconButton>
      <span className="my-1 h-px w-6 bg-line" aria-hidden />
      <ModeSwitch mode={mode} onChange={onModeChange} orientation="vertical" />
      <span className="my-1 h-px w-6 bg-line" aria-hidden />
      <IconButton label="新会话" size="md" className="group" onClick={onNew}>
        <span className="grid size-5 place-items-center rounded-full bg-accent text-accent-fg transition-transform duration-150 group-hover:scale-105">
          <Plus size={12} strokeWidth={2.5} />
        </span>
      </IconButton>
      <IconButton label="搜索会话" kbd="Ctrl+K" size="md" onClick={onSearch}>
        <Search size={16} strokeWidth={1.6} />
      </IconButton>
      <span className="flex-1" />
      <IconButton
        label={pendingCandidates > 0 ? `记忆(${pendingCandidates} 条待确认)` : "记忆"}
        size="md"
        active={page === "memory"}
        className="relative"
        onClick={() => onOpenPage("memory")}
      >
        <Brain size={16} strokeWidth={1.6} />
        <CountBubble count={pendingCandidates} className="absolute -right-0.5 -top-0.5" />
      </IconButton>
      <IconButton label="设置" size="md" active={page === "settings"} onClick={() => onOpenPage("settings")}>
        <Settings2 size={16} strokeWidth={1.6} />
      </IconButton>
    </nav>
  );
}
