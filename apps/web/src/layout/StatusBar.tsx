import { FolderOpen } from "lucide-react";
import { StatusDot } from "../ui/primitives.tsx";

// 底部状态栏:全部等宽字体,只放运行态信息。
export function StatusBar({
  online,
  mode,
  workspace,
  pendingCandidates,
  onOpenCandidates,
}: {
  online: boolean;
  mode: string;
  workspace?: string;
  pendingCandidates: number;
  onOpenCandidates: () => void;
}) {
  return (
    <footer
      className="flex h-[var(--h-status)] shrink-0 items-center gap-3 border-t border-line bg-canvas px-3 font-mono text-2xs text-subtle"
      aria-label="状态栏"
    >
      <span className="flex items-center gap-1.5" role="status">
        <StatusDot tone={online ? "ok" : "err"} pulse={!online} />
        {online ? "已连接" : "Server 未连接"}
      </span>
      <span className="uppercase">{mode}</span>
      {workspace && (
        <span className="flex min-w-0 items-center gap-1" title={workspace}>
          <FolderOpen size={11} strokeWidth={1.75} className="shrink-0" aria-hidden />
          <span className="truncate">{workspace}</span>
        </span>
      )}
      <span className="flex-1" />
      {pendingCandidates > 0 && (
        <button type="button" className="transition-colors hover:text-fg" onClick={onOpenCandidates}>
          {pendingCandidates} 条待确认记忆
        </button>
      )}
      <span className="hidden sm:inline">XiyunAgent</span>
    </footer>
  );
}
