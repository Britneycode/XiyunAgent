import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Eye,
  FolderOpen,
  GitCommitHorizontal,
  GitCompareArrows,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  WrapText,
  X,
} from "lucide-react";
import type { GitPreview, GitStatusEntry, ShellResult } from "@xiyun/shared";
import type { Preview } from "../chat/blocks.tsx";
import { DiffLines, DiffStat, PathLabel } from "../chat/DiffView.tsx";
import { parseUnifiedDiff, type DiffFile } from "../chat/gitDiff.ts";
import { cn } from "../ui/cn.ts";
import { Checkbox, Notice, PanelEmpty, PanelHeader, SectionLabel, TextArea } from "../ui/panel.tsx";
import { Badge, Button, IconButton, Skeleton } from "../ui/primitives.tsx";

export type CommitOutcome = ShellResult | { error: string };

export interface ChangesPanelProps {
  workspace: string;
  loading: boolean;
  error: string; // 提交范围(git status)读取失败
  preview: GitPreview | null;
  diffText: string | null; // null = 尚未读取
  diffError: string;
  selected: string[];
  onToggle: (path: string) => void;
  onToggleAll: (all: boolean) => void;
  commitMsg: string;
  onCommitMsg: (v: string) => void;
  committing: boolean;
  commitResult: CommitOutcome | null;
  onDismissResult: () => void;
  onCommit: () => void;
  onRefresh: () => void;
  onPreview?: (p: Preview) => void;
  onOpenFile?: (path: string) => void;
}

// porcelain XY → 单字母状态(与常见编辑器的源代码管理视图一致)
function entryStatus(f: GitStatusEntry): { letter: string; label: string; className: string } {
  if (f.untracked) return { letter: "U", label: "未跟踪", className: "text-ok" };
  const xy = f.x + f.y;
  if (xy.includes("U") || xy === "AA" || xy === "DD") return { letter: "!", label: "冲突", className: "text-err" };
  if (xy.includes("D")) return { letter: "D", label: "删除", className: "text-err" };
  if (f.x === "R" || f.x === "C") return { letter: "R", label: "重命名", className: "text-accent" };
  if (f.x === "A") return { letter: "A", label: "新增", className: "text-ok" };
  return { letter: "M", label: "已修改", className: "text-warn" };
}

function stageLabel(f: GitStatusEntry): string {
  if (f.untracked) return "";
  if (f.staged && f.unstaged) return "部分暂存";
  if (f.staged) return "已暂存";
  return "";
}

function FileRow({
  entry,
  diff,
  checked,
  wrap,
  workspace,
  onToggle,
  onPreview,
  onOpenFile,
}: {
  entry: GitStatusEntry;
  diff?: DiffFile;
  checked: boolean;
  wrap: boolean;
  workspace: string;
  onToggle: () => void;
  onPreview?: (p: Preview) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const st = entryStatus(entry);
  const stage = stageLabel(entry);
  const isDir = entry.path.endsWith("/");
  return (
    <li>
      <div className="group flex h-8 items-center gap-2 rounded-md pl-1.5 pr-1 transition-colors hover:bg-surface-2">
        <Checkbox checked={checked} onChange={onToggle} aria-label={`提交 ${entry.path}`} />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            size={13}
            strokeWidth={1.75}
            aria-hidden
            className={cn("shrink-0 text-subtle transition-transform duration-200", open && "rotate-90")}
          />
          <span className={cn("w-3 shrink-0 text-center font-mono text-2xs font-semibold", st.className)} title={st.label}>
            {st.letter}
          </span>
          <PathLabel path={entry.path} />
          {stage && <span className="hidden shrink-0 text-2xs text-subtle @[300px]:inline">{stage}</span>}
        </button>
        {diff && <DiffStat adds={diff.adds} dels={diff.dels} />}
        {onPreview && diff && (
          <IconButton
            label="在预览中打开"
            size="xs"
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => onPreview({ kind: "diff", title: entry.path, workspace, path: entry.path })}
          >
            <Eye size={13} strokeWidth={1.75} />
          </IconButton>
        )}
      </div>
      {open && (
        <div className="mb-1.5 ml-[30px] mr-1 mt-0.5 overflow-hidden rounded-md border border-line bg-code">
          {diff && diff.lines.length > 0 ? (
            <DiffLines lines={diff.lines} wrap={wrap} />
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-subtle">
              <span className="min-w-0 flex-1">
                {entry.untracked
                  ? isDir
                    ? "未跟踪目录,提交后纳入版本控制。"
                    : "未跟踪文件,git diff HEAD 不包含其内容。"
                  : diff?.binary
                    ? "二进制文件,不显示内容差异。"
                    : "暂无内容差异。"}
              </span>
              {entry.untracked && !isDir && onOpenFile && (
                <Button size="xs" variant="ghost" onClick={() => onOpenFile(entry.path)}>
                  <Eye size={12} strokeWidth={1.75} />
                  预览文件
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// Code 模式"变更"面板:文件清单(勾选提交范围)+ 逐文件 Diff + 提交确认
export function ChangesPanel(props: ChangesPanelProps) {
  const { workspace, preview, selected } = props;
  const [wrap, setWrap] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const allRef = useRef<HTMLInputElement>(null);

  const diffFiles = useMemo(() => parseUnifiedDiff(props.diffText ?? ""), [props.diffText]);
  const byPath = useMemo(() => new Map(diffFiles.map((f) => [f.path, f])), [diffFiles]);
  const totals = useMemo(
    () => diffFiles.reduce((a, f) => ({ adds: a.adds + f.adds, dels: a.dels + f.dels }), { adds: 0, dels: 0 }),
    [diffFiles],
  );

  const files = preview?.files ?? [];
  const allChecked = files.length > 0 && selected.length === files.length;
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = selected.length > 0 && !allChecked;
  }, [selected.length, allChecked]);

  const result = props.commitResult;
  const resultOk = result && !("error" in result) && result.exitCode === 0;

  const header = (
    <PanelHeader
      icon={GitCompareArrows}
      title="变更"
      meta={
        files.length > 0 && (
          <>
            <Badge>{files.length}</Badge>
            {diffFiles.length > 0 && <DiffStat adds={totals.adds} dels={totals.dels} />}
          </>
        )
      }
      actions={
        workspace && (
          <>
            <IconButton label="自动换行" size="xs" active={wrap} onClick={() => setWrap(!wrap)}>
              <WrapText size={13} strokeWidth={1.75} />
            </IconButton>
            <IconButton label="刷新" size="xs" disabled={props.loading} onClick={props.onRefresh}>
              <RefreshCw size={13} strokeWidth={1.75} className={cn(props.loading && "animate-spin")} />
            </IconButton>
          </>
        )
      }
    />
  );

  if (!workspace) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <PanelEmpty icon={FolderOpen} title="尚未绑定工作区" description="在主区顶部的工作区栏填写项目目录后,即可查看改动并提交。" />
      </div>
    );
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {props.error ? (
          <Notice tone="err" className="m-1">
            {props.error}
          </Notice>
        ) : !preview ? (
          <div className="flex flex-col gap-1.5 p-1" aria-label="读取中">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-7" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <PanelEmpty icon={Sparkles} title="工作区很干净" description="没有未提交的改动。" />
        ) : (
          <>
            <div className="flex h-7 items-center gap-2 pl-1.5 pr-1">
              <Checkbox
                ref={allRef}
                checked={allChecked}
                onChange={() => props.onToggleAll(!allChecked)}
                aria-label="全选提交范围"
              />
              <SectionLabel className="flex-1">
                提交范围 <span className="font-mono tabular-nums">{selected.length}/{files.length}</span>
              </SectionLabel>
            </div>
            {props.diffError && (
              <Notice tone="warn" className="mx-1 mb-1">
                无法读取 Diff:{props.diffError}
              </Notice>
            )}
            <ul className="flex flex-col">
              {files.map((f) => (
                <FileRow
                  key={f.path}
                  entry={f}
                  diff={byPath.get(f.path.replace(/\/$/, ""))}
                  checked={selected.includes(f.path)}
                  wrap={wrap}
                  workspace={workspace}
                  onToggle={() => props.onToggle(f.path)}
                  onPreview={props.onPreview}
                  onOpenFile={props.onOpenFile}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {preview && files.length > 0 && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-line bg-surface p-3">
          {preview.cachedStat.trim() !== "" && (
            <Notice tone="warn">工作区已有暂存内容,提交将连带已有暂存内容(勾选项之外的暂存文件也会一并提交)。</Notice>
          )}
          <TextArea
            rows={2}
            value={props.commitMsg}
            placeholder="提交信息(只提交勾选的文件)"
            aria-label="提交信息"
            onChange={(e) => props.onCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && props.commitMsg.trim() && selected.length > 0) {
                e.preventDefault();
                props.onCommit();
              }
            }}
            className="min-h-[56px] text-xs"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-expanded={showStats}
              onClick={() => setShowStats(!showStats)}
              className="inline-flex items-center gap-1 text-2xs text-subtle transition-colors hover:text-muted"
            >
              <ChevronRight size={12} strokeWidth={1.75} className={cn("transition-transform", showStats && "rotate-90")} />
              差异统计
            </button>
            <span className="flex-1" />
            <Button
              variant="primary"
              size="sm"
              disabled={props.committing || !props.commitMsg.trim() || selected.length === 0}
              onClick={props.onCommit}
              title="Ctrl+Enter"
            >
              {props.committing ? (
                <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
              ) : (
                <GitCommitHorizontal size={14} strokeWidth={1.75} />
              )}
              确认提交 {selected.length} 个文件
            </Button>
          </div>
          {showStats && (
            <pre className="max-h-48 overflow-auto rounded-md border border-line bg-code px-3 py-2 font-mono text-2xs leading-relaxed text-code-fg">
              {`$ git diff --stat(未暂存)\n${preview.diffStat || "(无)"}\n\n$ git diff --cached --stat(已暂存)\n${preview.cachedStat || "(无)"}`}
            </pre>
          )}
        </div>
      )}

      {result && (
        <div className="shrink-0 border-t border-line bg-surface px-3 pb-3 pt-2">
          <Notice
            tone={resultOk ? "ok" : "err"}
            action={
              <IconButton label="关闭" size="xs" onClick={props.onDismissResult}>
                <X size={12} strokeWidth={1.75} />
              </IconButton>
            }
          >
            {"error" in result ? (
              result.error
            ) : (
              <>
                <p className="font-medium">{resultOk ? "提交成功" : `提交失败(exit ${result.exitCode})`}</p>
                {(result.stdout || result.stderr) && (
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs text-muted">
                    {(result.stdout + (result.stderr ? `\n${result.stderr}` : "")).trim()}
                  </pre>
                )}
              </>
            )}
          </Notice>
        </div>
      )}
    </div>
  );
}
