import { useLayoutEffect, useRef, useState } from "react";
import { CornerDownLeft, Eraser, FolderOpen, LoaderCircle, ShieldAlert, SquareTerminal } from "lucide-react";
import type { ShellInfo, ShellResult } from "@xiyun/shared";
import { CopyButton } from "../chat/blocks.tsx";
import { cn } from "../ui/cn.ts";
import { formatMs } from "../ui/format.ts";
import { Notice, PanelEmpty, PanelHeader, Select } from "../ui/panel.tsx";
import { Badge, Button, IconButton } from "../ui/primitives.tsx";

export type TerminalRun =
  | { id: number; command: string; result: ShellResult & { needsConfirm?: boolean } }
  | { id: number; command: string; error: string };

export interface TerminalPanelProps {
  workspace: string;
  shells: ShellInfo[];
  shell: string;
  onShell: (id: string) => void;
  cmd: string;
  onCmd: (v: string) => void;
  running: boolean;
  pending: { command: string } | null;
  onRun: () => void;
  onConfirm: () => void;
  onCancelPending: () => void;
  runs: TerminalRun[];
  onClear: () => void;
}

function RunCard({ run }: { run: TerminalRun }) {
  const r = "result" in run ? run.result : null;
  const output = r ? [r.stdout, r.stderr].filter(Boolean).join("\n") : "";
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-code">
      <div className="flex h-8 items-center gap-2 border-b border-line bg-surface/60 pl-3 pr-1 font-mono text-xs">
        <span className="text-subtle" aria-hidden>
          $
        </span>
        <span className="min-w-0 flex-1 truncate text-fg" title={run.command}>
          {run.command}
        </span>
        {r ? (
          <>
            {r.timedOut && <Badge tone="warn">超时</Badge>}
            <Badge tone={r.exitCode === 0 ? "ok" : "err"}>exit {r.exitCode}</Badge>
            <span className="text-2xs tabular-nums text-subtle" title="耗时">
              {formatMs(r.durationMs)}
            </span>
            {output && <CopyButton text={output} label="复制输出" />}
          </>
        ) : (
          <Badge tone="err">失败</Badge>
        )}
      </div>
      {r ? (
        r.stdout || r.stderr ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs leading-relaxed text-code-fg">
            {r.stdout}
            {r.stderr && <span className="text-err">{(r.stdout ? "\n" : "") + r.stderr}</span>}
          </pre>
        ) : (
          <p className="px-3 py-1.5 font-mono text-2xs text-subtle">(无输出)</p>
        )
      ) : (
        <p className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs text-err">{"error" in run ? run.error : ""}</p>
      )}
      {r && (
        <p className="border-t border-line px-3 py-1 font-mono text-2xs text-subtle">
          {r.shell} · {r.cwd}
        </p>
      )}
    </div>
  );
}

// Code 模式"终端"面板:命令历史 + 确认条 + 底部输入。
// 非白名单命令需要显式确认后执行;危险命令由 Server 直接拒绝。
export function TerminalPanel(props: TerminalPanelProps) {
  const { workspace, runs, pending, running } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<number | null>(null);

  // 新结果出现时滚动到底部
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs.length, pending, running]);

  const history = runs.map((r) => r.command);

  // ↑/↓ 在历史命令间切换
  const recall = (dir: -1 | 1) => {
    if (!history.length) return;
    const next = cursor === null ? (dir < 0 ? history.length - 1 : null) : cursor + dir;
    if (next === null || next >= history.length) {
      setCursor(null);
      props.onCmd("");
      return;
    }
    const idx = Math.max(0, next);
    setCursor(idx);
    props.onCmd(history[idx]);
  };

  if (!workspace) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader icon={SquareTerminal} title="终端" />
        <PanelEmpty icon={FolderOpen} title="尚未绑定工作区" description="命令在工作区目录中执行。请先在主区顶部绑定项目目录。" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        icon={SquareTerminal}
        title="终端"
        meta={
          <span className="min-w-0 truncate font-mono text-2xs text-subtle" title={workspace}>
            {workspace}
          </span>
        }
        actions={
          runs.length > 0 && (
            <IconButton label="清空记录" size="xs" onClick={props.onClear}>
              <Eraser size={13} strokeWidth={1.75} />
            </IconButton>
          )
        }
      />
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        {runs.length === 0 && !pending && !running && (
          <PanelEmpty
            icon={SquareTerminal}
            title="在工作区中运行命令"
            description="白名单命令直接执行;其他命令需要确认,危险命令会被拒绝。"
          />
        )}
        {runs.map((r) => (
          <RunCard key={r.id} run={r} />
        ))}
        {running && (
          <div className="flex h-8 items-center gap-2 px-1 font-mono text-xs text-muted" role="status">
            <LoaderCircle size={13} strokeWidth={2} className="animate-spin text-accent" aria-hidden />
            <span className="truncate">正在执行 {props.cmd || pending?.command}</span>
          </div>
        )}
        {pending && (
          <Notice
            tone="warn"
            action={
              <>
                <Button size="xs" variant="danger" className="border border-err/30" onClick={props.onConfirm}>
                  <ShieldAlert size={12} strokeWidth={1.75} />
                  确认执行
                </Button>
                <Button size="xs" variant="ghost" onClick={props.onCancelPending}>
                  取消
                </Button>
              </>
            }
          >
            <p>命令需要确认:</p>
            <code className="mt-0.5 block break-all font-mono text-fg">{pending.command}</code>
          </Notice>
        )}
      </div>
      <form
        className="flex shrink-0 items-center gap-1.5 border-t border-line bg-surface p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running && props.cmd.trim()) {
            setCursor(null);
            props.onRun();
          }
        }}
      >
        <Select
          value={props.shell}
          onChange={(e) => props.onShell(e.target.value)}
          aria-label="Shell"
          className="w-[104px] shrink-0"
        >
          {props.shells.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <label
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-elevated px-2.5 transition-[border-color,box-shadow]",
            "focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15",
          )}
        >
          <span className="font-mono text-xs text-accent" aria-hidden>
            $
          </span>
          <input
            value={props.cmd}
            onChange={(e) => {
              setCursor(null);
              props.onCmd(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                recall(-1);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                recall(1);
              }
            }}
            placeholder="命令(非白名单命令需确认)"
            aria-label="命令"
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-subtle"
          />
        </label>
        <Button type="submit" variant="primary" size="sm" disabled={running || !props.cmd.trim()} className="h-8">
          {running ? (
            <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
          ) : (
            <CornerDownLeft size={13} strokeWidth={1.75} />
          )}
          运行
        </Button>
      </form>
    </div>
  );
}
