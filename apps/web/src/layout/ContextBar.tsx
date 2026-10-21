import { Check, FolderOpen, Pencil, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../ui/cn.ts";
import { errorMessage } from "../ui/format.ts";
import { IconButton } from "../ui/primitives.tsx";

// Code / Work 页顶部上下文栏:工作区绑定(可内联编辑)+ 分支等状态 + 检查器面板开关。
export function ContextBar({
  label,
  workspace,
  placeholder,
  onBind,
  chips,
  children,
}: {
  label: string;
  workspace: string;
  placeholder: string;
  onBind: (path: string) => Promise<void>;
  chips?: ReactNode;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(!workspace);
  const [draft, setDraft] = useState(workspace);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(workspace);
    setEditing(!workspace);
    setError("");
  }, [workspace]);

  useEffect(() => {
    if (editing && workspace) inputRef.current?.select();
  }, [editing, workspace]);

  const save = async () => {
    const next = draft.trim();
    if (next === workspace) {
      setEditing(!workspace);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onBind(next);
    } catch (e) {
      setError(errorMessage(e, "绑定失败"));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft(workspace);
    setError("");
    if (workspace) setEditing(false);
  };

  return (
    <div data-ui className="@container flex h-10 shrink-0 items-center gap-2 border-b border-line bg-canvas pl-4 pr-2">
      <FolderOpen size={14} strokeWidth={1.75} className="shrink-0 text-subtle" aria-hidden />
      <span className="hidden shrink-0 text-2xs text-subtle @[520px]:inline">{label}</span>
      {editing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            ref={inputRef}
            autoFocus={!!workspace}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && cancel()}
            placeholder={placeholder}
            aria-label={label}
            aria-invalid={!!error || undefined}
            className={cn(
              "h-7 min-w-0 flex-1 rounded-md border bg-elevated px-2 font-mono text-xs text-fg outline-none transition-[border-color,box-shadow]",
              "placeholder:font-sans placeholder:text-subtle focus:border-accent/60 focus:ring-2 focus:ring-accent/15",
              error ? "border-err/50" : "border-line",
            )}
          />
          <IconButton label="绑定" size="sm" type="submit" disabled={saving || draft.trim() === workspace}>
            <Check size={14} strokeWidth={2} />
          </IconButton>
          {workspace && (
            <IconButton label="取消" size="sm" onClick={cancel}>
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          {error && (
            <span className="hidden max-w-[200px] truncate text-2xs text-err @[640px]:inline" title={error}>
              {error}
            </span>
          )}
        </form>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            title={`${workspace}(点击更改)`}
            className="group inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 font-mono text-xs text-fg transition-colors hover:bg-surface-2"
          >
            <span className="truncate">{workspace}</span>
            <Pencil
              size={12}
              strokeWidth={1.75}
              className="shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden
            />
          </button>
          {chips}
        </div>
      )}
      {children && <div className="flex shrink-0 items-center gap-0.5">{children}</div>}
    </div>
  );
}

export function PanelToggle({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors duration-150",
        active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden />
      <span className="hidden @[520px]:inline">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="font-mono text-2xs tabular-nums text-subtle">{count > 99 ? "99+" : count}</span>
      )}
    </button>
  );
}
