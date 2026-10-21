import { FolderOpen, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, IconButton } from "../ui/primitives.tsx";

// 主区顶部条:会话标题、模式、工作区路径与检查器开关。侧栏开关在侧栏/窄栏内。
export function StreamHeader({
  title,
  badge,
  workspace,
  inspectorOpen,
  onToggleInspector,
  actions,
}: {
  title: string;
  badge?: string;
  workspace?: string;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-canvas pl-4 pr-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="truncate text-ui font-medium text-fg" title={title}>
          {title}
        </h1>
        {badge && <Badge className="uppercase">{badge}</Badge>}
        {workspace && (
          <span
            className="hidden min-w-0 items-center gap-1 font-mono text-2xs text-subtle md:inline-flex"
            title={workspace}
          >
            <FolderOpen size={12} strokeWidth={1.75} className="shrink-0" aria-hidden />
            <span className="truncate">{workspace}</span>
          </span>
        )}
      </div>
      {actions}
      <IconButton
        label={inspectorOpen ? "收起面板" : "展开面板"}
        kbd="Ctrl+J"
        size="sm"
        active={inspectorOpen}
        onClick={onToggleInspector}
      >
        <PanelRight size={15} strokeWidth={1.75} />
      </IconButton>
    </header>
  );
}
