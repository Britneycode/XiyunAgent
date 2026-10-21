import { Archive, ArrowLeft, Brain, PanelLeftClose, Plus, Search, Settings2, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../ui/cn.ts";
import { IconButton, Kbd } from "../ui/primitives.tsx";
import { BrandMark } from "./Brand.tsx";
import { ModeSwitch } from "./ModeSwitch.tsx";
import { SessionList, type SessionListProps } from "./SessionList.tsx";
import type { Mode, Page } from "./types.ts";

export interface SidebarProps {
  mode: Mode;
  page: Page;
  pendingCandidates: number;
  query: string;
  focusSearch: boolean; // 为 true 时展开并聚焦搜索框(Ctrl+K / 窄栏搜索按钮),处理后回调 onSearchFocused
  showArchived: boolean;
  sessionCount: number;
  hasMore: boolean;
  list: Omit<SessionListProps, "showArchived" | "hasMore">;
  onModeChange: (mode: Mode) => void;
  onOpenPage: (page: Exclude<Page, "main">) => void;
  onNew: () => void;
  onQueryChange: (q: string) => void;
  onToggleArchived: () => void;
  onCollapse: () => void;
  onSearchFocused: () => void;
}

function NavRow({
  icon: Icon,
  label,
  active = false,
  trailing,
  onClick,
  leading,
}: {
  icon?: LucideIcon;
  label: string;
  active?: boolean;
  trailing?: ReactNode;
  leading?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui transition-colors duration-150",
        active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/70 hover:text-fg",
      )}
    >
      {leading ?? (Icon && <Icon size={16} strokeWidth={1.6} className="shrink-0" aria-hidden />)}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

// 展开态侧栏(参考 Claude 桌面端):品牌行 → 模式分段 → 快捷操作 → 最近会话。
export function Sidebar(props: SidebarProps) {
  const { mode, page, pendingCandidates, query, showArchived } = props;
  const [searching, setSearching] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchOpen = searching || query.length > 0;

  const startSearch = () => {
    setSearching(true);
    setFocusTick((t) => t + 1);
  };

  // 外部搜索请求(Ctrl+K / 窄栏搜索按钮):侧栏可能刚从窄栏展开、本组件刚挂载
  const { focusSearch, onSearchFocused } = props;
  useEffect(() => {
    if (!focusSearch) return;
    startSearch();
    onSearchFocused();
  }, [focusSearch, onSearchFocused]);

  // 与 searching 同批提交后输入框已挂载,此时聚焦才可靠
  useEffect(() => {
    if (focusTick > 0) inputRef.current?.focus();
  }, [focusTick]);

  const closeSearch = () => {
    props.onQueryChange("");
    setSearching(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 pl-3.5 pr-2">
        <BrandMark />
        <span className="min-w-0 flex-1 truncate text-ui font-semibold tracking-tight text-fg">XiyunAgent</span>
        <IconButton label="收起侧栏" kbd="Ctrl+B" size="sm" onClick={props.onCollapse}>
          <PanelLeftClose size={15} strokeWidth={1.75} />
        </IconButton>
      </div>

      <div className="shrink-0 px-2.5 pb-2.5">
        <ModeSwitch mode={mode} onChange={props.onModeChange} />
      </div>

      <nav aria-label="快捷操作" className="flex shrink-0 flex-col gap-px px-2 pb-2">
        <NavRow
          label="新会话"
          onClick={props.onNew}
          leading={
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition-transform duration-150 group-hover:scale-105">
              <Plus size={12} strokeWidth={2.5} aria-hidden />
            </span>
          }
        />
        {searchOpen ? (
          <label className="flex h-8 items-center gap-2.5 rounded-lg border border-line bg-elevated px-2.5 text-subtle transition-colors focus-within:border-line-strong">
            <Search size={15} strokeWidth={1.6} className="shrink-0" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => props.onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                }
              }}
              onBlur={() => !query && setSearching(false)}
              placeholder="搜索会话标题"
              aria-label="搜索会话"
              className="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-subtle"
            />
            <button
              type="button"
              aria-label="关闭搜索"
              onMouseDown={(e) => e.preventDefault()}
              onClick={closeSearch}
              className="grid size-5 place-items-center rounded text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </label>
        ) : (
          <NavRow
            icon={Search}
            label="搜索"
            onClick={startSearch}
            trailing={
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <Kbd>Ctrl</Kbd>
                <Kbd>K</Kbd>
              </span>
            }
          />
        )}
        <NavRow
          icon={Brain}
          label="记忆"
          active={page === "memory"}
          onClick={() => props.onOpenPage("memory")}
          trailing={
            pendingCandidates > 0 ? (
              <span
                className="rounded-full bg-accent-soft px-1.5 font-mono text-2xs leading-4 tabular-nums text-accent"
                title={`${pendingCandidates} 条待确认`}
              >
                {pendingCandidates > 99 ? "99+" : pendingCandidates}
              </span>
            ) : null
          }
        />
        <NavRow icon={Settings2} label="设置" active={page === "settings"} onClick={() => props.onOpenPage("settings")} />
      </nav>

      <div className="mx-3.5 shrink-0 border-t border-line" />

      <div className="flex h-9 shrink-0 items-center gap-1 pl-2 pr-2">
        {showArchived ? (
          <button
            type="button"
            onClick={props.onToggleArchived}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <ArrowLeft size={12} strokeWidth={2} aria-hidden />
            已归档
          </button>
        ) : (
          <span className="px-1.5 text-2xs font-medium text-subtle">{query ? "搜索结果" : "最近"}</span>
        )}
        <span className="flex-1" />
        <span className="font-mono text-2xs tabular-nums text-subtle">
          {props.sessionCount}
          {props.hasMore ? "+" : ""}
        </span>
        <IconButton
          label={showArchived ? "返回最近会话" : "查看已归档会话"}
          size="xs"
          active={showArchived}
          onClick={props.onToggleArchived}
        >
          <Archive size={12} strokeWidth={1.75} />
        </IconButton>
      </div>

      <SessionList {...props.list} showArchived={showArchived} hasMore={props.hasMore} />
    </div>
  );
}
