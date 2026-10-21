import { Archive, ArchiveRestore, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, type KeyboardEvent, type ReactNode } from "react";
import type { SessionMeta } from "@xiyun/shared";
import { cn } from "../ui/cn.ts";
import { Button, IconButton, Skeleton } from "../ui/primitives.tsx";

export interface RenameState {
  id: string;
  title: string;
}

export interface SessionListProps {
  sessions: SessionMeta[]; // 已按模式与搜索词过滤
  activeId: string | null;
  loaded: boolean;
  showArchived: boolean;
  renaming: RenameState | null;
  hasMore: boolean;
  emptyText: string;
  onSelect: (s: SessionMeta) => void;
  onRenameStart: (s: SessionMeta) => void;
  onRenameChange: (title: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onArchive: (s: SessionMeta, archived: boolean) => void;
  onDelete: (s: SessionMeta) => void;
  onLoadMore: () => void;
  footer?: ReactNode; // 列表末尾的附加分组(如搜索时的"消息内容")
}

const GROUPS = ["今天", "昨天", "近 7 天", "近 30 天", "更早"] as const;
type Group = (typeof GROUPS)[number];

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function groupOf(iso: string, today: number): Group {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "更早";
  const day = startOfDay(new Date(t));
  if (day >= today) return "今天";
  if (day >= today - DAY) return "昨天";
  if (day >= today - 6 * DAY) return "近 7 天";
  if (day >= today - 29 * DAY) return "近 30 天";
  return "更早";
}

const pad = (n: number) => String(n).padStart(2, "0");

// 今天显示时刻,今年显示月-日,更早显示年份
function shortTime(iso: string, today: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (startOfDay(d) >= today) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === new Date(today).getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return String(d.getFullYear());
}

// 会话列表:按日期分组;行内操作(重命名 F2 / 归档 / 删除 Delete)只在悬停或聚焦时出现。
export function SessionList(props: SessionListProps) {
  const { sessions, activeId, loaded, showArchived, renaming, hasMore } = props;

  // 服务端按最近活动(updatedAt)倒序返回;分组与时间同样按最近活动,组内保持原顺序
  const groups = useMemo(() => {
    const today = startOfDay(new Date());
    const map = new Map<Group, Array<{ s: SessionMeta; time: string }>>();
    for (const s of sessions) {
      const at = s.updatedAt ?? s.createdAt;
      const g = groupOf(at, today);
      const list = map.get(g) ?? [];
      list.push({ s, time: shortTime(at, today) });
      map.set(g, list);
    }
    return GROUPS.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)! }));
  }, [sessions]);

  const onItemKeyDown = (e: KeyboardEvent<HTMLDivElement>, s: SessionMeta) => {
    if (e.target !== e.currentTarget) return; // 行内操作按钮自行处理键盘
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onSelect(s);
    } else if (e.key === "F2") {
      e.preventDefault();
      props.onRenameStart(s);
    } else if (e.key === "Delete") {
      e.preventDefault();
      props.onDelete(s);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // 列表内上下移动焦点
      e.preventDefault();
      const rows = Array.from(
        e.currentTarget.closest('[role="list"]')?.querySelectorAll<HTMLElement>('[role="listitem"]') ?? [],
      );
      const i = rows.indexOf(e.currentTarget);
      rows[i + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
    }
  };

  if (!loaded) {
    return (
      <div className="flex flex-col gap-2 px-4 pt-3" aria-busy>
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-4/5" />
        <Skeleton className="h-6 w-11/12" />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="list" aria-label="会话列表">
      {groups.length === 0 ? (
        props.emptyText && <div className="px-3 pt-6 text-center text-xs leading-relaxed text-subtle">{props.emptyText}</div>
      ) : (
        groups.map(({ group, items }) => (
          <div key={group} role="presentation">
            <div className="px-2.5 pb-1 pt-3 text-2xs font-medium text-subtle">{group}</div>
            {items.map(({ s, time }) => {
              if (renaming?.id === s.id) {
                return (
                  <input
                    key={s.id}
                    autoFocus
                    aria-label="重命名会话"
                    value={renaming.title}
                    onChange={(e) => props.onRenameChange(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") props.onRenameCommit();
                      if (e.key === "Escape") props.onRenameCancel();
                    }}
                    onBlur={props.onRenameCommit}
                    className="h-8 w-full rounded-lg border border-accent/60 bg-elevated px-2.5 text-ui text-fg outline-none"
                  />
                );
              }
              const active = s.id === activeId;
              return (
                <div
                  key={s.id}
                  role="listitem"
                  tabIndex={0}
                  aria-current={active ? "true" : undefined}
                  title={s.title}
                  onClick={() => props.onSelect(s)}
                  onKeyDown={(e) => onItemKeyDown(e, s)}
                  className={cn(
                    "group relative flex h-8 items-center gap-2 rounded-lg px-2.5 text-ui transition-colors duration-150",
                    active ? "text-fg" : "text-muted hover:bg-surface-2/70 hover:text-fg",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="session-active"
                      aria-hidden
                      className="absolute inset-0 rounded-lg bg-surface-2"
                      transition={{ type: "spring", stiffness: 520, damping: 42 }}
                    />
                  )}
                  <span className="relative min-w-0 flex-1 truncate">{s.title}</span>
                  {s.running ? (
                    // 后台生成中(F1):切走后回来可接着看
                    <span className="relative flex items-center text-accent group-focus-within:hidden group-hover:hidden" title="生成中">
                      <LoaderCircle size={12} strokeWidth={2} className="animate-spin" aria-label="生成中" />
                    </span>
                  ) : (
                    <span className="relative font-mono text-2xs tabular-nums text-subtle group-focus-within:hidden group-hover:hidden">
                      {time}
                    </span>
                  )}
                  <span
                    className="relative hidden items-center group-focus-within:flex group-hover:flex"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconButton label="重命名" kbd="F2" size="xs" onClick={() => props.onRenameStart(s)}>
                      <Pencil size={12} strokeWidth={1.75} />
                    </IconButton>
                    {showArchived ? (
                      <IconButton label="恢复" size="xs" onClick={() => props.onArchive(s, false)}>
                        <ArchiveRestore size={12} strokeWidth={1.75} />
                      </IconButton>
                    ) : (
                      <IconButton label="归档" size="xs" onClick={() => props.onArchive(s, true)}>
                        <Archive size={12} strokeWidth={1.75} />
                      </IconButton>
                    )}
                    <IconButton label="删除" kbd="Delete" size="xs" tone="danger" onClick={() => props.onDelete(s)}>
                      <Trash2 size={12} strokeWidth={1.75} />
                    </IconButton>
                  </span>
                </div>
              );
            })}
          </div>
        ))
      )}
      {hasMore && (
        <Button variant="ghost" size="xs" className="mt-2 w-full" onClick={props.onLoadMore}>
          加载更多
        </Button>
      )}
      {props.footer}
    </div>
  );
}
