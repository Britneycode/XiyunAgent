import { ChevronRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "../ui/cn.ts";
import { splitPath } from "../ui/format.ts";
import type { DiffFile, DiffFileStatus, DiffLine } from "./gitDiff.ts";

// 单文件一次最多渲染的行数,超出部分按需展开,避免超大 diff 卡住界面
const LINE_BUDGET = 1500;

export const STATUS_META: Record<DiffFileStatus, { label: string; className: string }> = {
  M: { label: "已修改", className: "text-warn" },
  A: { label: "新增", className: "text-ok" },
  D: { label: "删除", className: "text-err" },
  R: { label: "重命名", className: "text-accent" },
};

export function DiffStat({ adds, dels, className }: { adds: number; dels: number; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-2xs tabular-nums", className)}>
      <span className="text-ok">+{adds}</span>
      <span className="text-err">−{dels}</span>
    </span>
  );
}

export function PathLabel({ path, className }: { path: string; className?: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className={cn("min-w-0 truncate font-mono text-xs", className)} title={path}>
      {dir && <span className="text-subtle">{dir}</span>}
      <span className="text-fg">{name || path}</span>
    </span>
  );
}

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: " ", hunk: "", note: "" };

// 逐行渲染:旧行号 | 新行号 | 符号 | 内容。wrap 时长行折行,否则横向滚动
export function DiffLines({ lines, wrap = false }: { lines: DiffLine[]; wrap?: boolean }) {
  const [limit, setLimit] = useState(LINE_BUDGET);
  const shown = lines.length > limit ? lines.slice(0, limit) : lines;
  return (
    <div className="diff-scroll">
      <div className={cn("diff-lines", wrap && "is-wrapped")}>
        {shown.map((l, i) =>
          l.kind === "hunk" ? (
            <div key={i} className="diff-hunk">
              {l.text}
            </div>
          ) : (
            <div key={i} className={`diff-row is-${l.kind}`}>
              <span className="diff-no">{l.oldNo ?? ""}</span>
              <span className="diff-no">{l.newNo ?? ""}</span>
              <span className="diff-sign">{SIGN[l.kind]}</span>
              <span className="diff-code">{l.text || " "}</span>
            </div>
          ),
        )}
      </div>
      {lines.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + LINE_BUDGET)}
          className="flex h-8 w-full items-center justify-center border-t border-line text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          显示剩余 {lines.length - limit} 行
        </button>
      )}
    </div>
  );
}

// 单个文件的 diff 卡片:头部(状态 / 路径 / 增删统计 / 操作)+ 可折叠正文
export function DiffFileCard({
  file,
  defaultOpen = true,
  wrap = false,
  actions,
}: {
  file: DiffFile;
  defaultOpen?: boolean;
  wrap?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = STATUS_META[file.status];
  return (
    <div className="diff-file">
      <div className="flex h-9 items-center gap-2 border-b border-line bg-surface/70 pl-2 pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            aria-hidden
            className={cn("shrink-0 text-subtle transition-transform duration-200", open && "rotate-90")}
          />
          <span className={cn("w-3 shrink-0 text-center font-mono text-2xs font-semibold", meta.className)} title={meta.label}>
            {file.status}
          </span>
          {file.path ? <PathLabel path={file.path} /> : <span className="text-xs text-muted">补丁</span>}
          {file.oldPath && (
            <span className="hidden min-w-0 truncate font-mono text-2xs text-subtle sm:inline" title={file.oldPath}>
              ← {file.oldPath}
            </span>
          )}
        </button>
        <DiffStat adds={file.adds} dels={file.dels} />
        {actions}
      </div>
      {open &&
        (file.binary ? (
          <p className="px-3 py-2 text-xs text-subtle">二进制文件,不显示内容差异</p>
        ) : file.lines.length === 0 ? (
          <p className="px-3 py-2 text-xs text-subtle">仅文件模式或名称变化,无内容差异</p>
        ) : (
          <DiffLines lines={file.lines} wrap={wrap} />
        ))}
    </div>
  );
}

export function useDiffTotals(files: DiffFile[]) {
  return useMemo(
    () => files.reduce((acc, f) => ({ adds: acc.adds + f.adds, dels: acc.dels + f.dels }), { adds: 0, dels: 0 }),
    [files],
  );
}
