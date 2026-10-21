import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, GitCompareArrows, SquareTerminal } from "lucide-react";
import type { GitPreview, SessionMeta, ShellInfo } from "@xiyun/shared";
import { api } from "./api.ts";
import { ChatPage } from "./ChatPage.tsx";
import type { Preview } from "./chat/blocks.tsx";
import { ChangesPanel, type CommitOutcome } from "./code/ChangesPanel.tsx";
import { TerminalPanel, type TerminalRun } from "./code/TerminalPanel.tsx";
import { ContextBar, PanelToggle } from "./layout/ContextBar.tsx";
import { InspectorPortal, useInspectorBadge, useInspectorBridge, usePanelVisible } from "./layout/inspectorBridge.tsx";
import { errorMessage, langFromPath } from "./ui/format.ts";

// 终端记录上限:只保留最近的若干条,避免长会话占用过多内存
const MAX_RUNS = 50;

interface BranchInfo {
  name: string;
  ahead: number;
  behind: number;
}

// `git status --short --branch` 首行:"## main...origin/main [ahead 1, behind 2]" / "## No commits yet on main"
function parseBranch(stdout: string): BranchInfo | null {
  const head = stdout.split("\n")[0] ?? "";
  if (!head.startsWith("## ")) return null;
  const rest = head.slice(3);
  const initial = /^No commits yet on (.+)$/.exec(rest);
  if (initial) return { name: initial[1], ahead: 0, behind: 0 };
  const name = rest.split(/\.\.\.|\s/)[0] || "HEAD";
  const ahead = Number(/ahead (\d+)/.exec(rest)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(rest)?.[1] ?? 0);
  return { name: name === "HEAD" ? "(分离 HEAD)" : name, ahead, behind };
}

export interface CodePageProps {
  session: SessionMeta;
  onSessionChanged: () => void;
  onPreview?: (p: Preview) => void;
  onBranch?: (messageId: number) => void;
  onNewSession?: () => void;
  onCandidatesChanged?: () => void;
}

// Code 页:对话 + 检查器中的"变更"(Git 状态 / Diff / 提交)与"终端"面板。
// 提交与非白名单命令必须用户显式确认;危险命令 Server 直接拒绝。
export function CodePage({ session, onSessionChanged, onPreview, onBranch, onNewSession, onCandidatesChanged }: CodePageProps) {
  const workspace = session.workspace;
  const bridge = useInspectorBridge();
  const changesVisible = usePanelVisible("changes");

  // ---- Git ----
  const [preview, setPreview] = useState<GitPreview | null>(null);
  const [gitError, setGitError] = useState("");
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffError, setDiffError] = useState("");
  const [branch, setBranch] = useState<BranchInfo | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const knownFiles = useRef<Set<string>>(new Set());
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitOutcome | null>(null);

  // ---- 终端 ----
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [shell, setShell] = useState("");
  const [cmd, setCmd] = useState("");
  const [pending, setPending] = useState<{ command: string } | null>(null);
  const [runs, setRuns] = useState<TerminalRun[]>([]);
  const [running, setRunning] = useState(false);
  const runSeq = useRef(0);

  useEffect(() => {
    void api
      .shells()
      .then((s) => {
        setShells(s);
        if (s[0]) setShell(s[0].id);
      })
      .catch(() => {});
  }, []);

  // 切换会话 / 工作区:清空与旧工作区相关的展示状态
  useEffect(() => {
    setPreview(null);
    setGitError("");
    setDiffText(null);
    setDiffError("");
    setBranch(null);
    setSelected([]);
    knownFiles.current = new Set();
    setCommitResult(null);
    setRuns([]);
    setPending(null);
  }, [session.id, workspace]);

  // 提交范围 + 分支(轻量,挂载即读取,用于角标);Diff 只在变更面板可见时读取
  const wsRef = useRef(workspace);
  wsRef.current = workspace;
  const refreshGit = useCallback(
    async (withDiff: boolean) => {
      if (!workspace) return;
      setGitLoading(true);
      const [p, s, d] = await Promise.allSettled([
        api.gitPreview(workspace),
        api.gitStatus(workspace),
        withDiff ? api.gitDiff(workspace) : Promise.resolve(null),
      ]);
      // 等待期间已切换工作区:丢弃旧结果
      if (wsRef.current !== workspace) return;
      if (p.status === "fulfilled") {
        const files = p.value.files.map((f) => f.path);
        // 保留用户已取消的勾选;新出现的文件默认勾选(已暂存项不勾无法剥离)。
        // 先取快照:更新函数可能延迟到渲染时执行,那时 knownFiles 已被下一行改写
        const known = knownFiles.current;
        setSelected((prev) => files.filter((f) => !known.has(f) || prev.includes(f)));
        knownFiles.current = new Set(files);
        setPreview(p.value);
        setGitError("");
      } else {
        setPreview(null);
        setSelected([]);
        knownFiles.current = new Set();
        setGitError(errorMessage(p.reason, "加载提交范围失败"));
      }
      setBranch(s.status === "fulfilled" && s.value.exitCode === 0 ? parseBranch(s.value.stdout) : null);
      if (withDiff) {
        if (d.status === "fulfilled" && d.value) {
          setDiffText(d.value.stdout || "");
          setDiffError("");
        } else if (d.status === "rejected") {
          setDiffText("");
          setDiffError(errorMessage(d.reason, "git diff 失败"));
        }
      }
      setGitLoading(false);
    },
    [workspace],
  );

  // 挂载 / 切换工作区 / 打开变更面板时读取;关闭面板不必重读
  const prevVisible = useRef<boolean | null>(null);
  useEffect(() => {
    const was = prevVisible.current;
    prevVisible.current = changesVisible;
    if (was === true && !changesVisible) return;
    void refreshGit(changesVisible);
  }, [refreshGit, changesVisible]);

  const toggleFile = (path: string) =>
    setSelected((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path]));

  // 只提交勾选的文件;确认按钮即用户的显式确认
  const commit = async () => {
    setCommitting(true);
    setCommitResult(null);
    try {
      const r = await api.gitCommit({ workspace, message: commitMsg, files: selected, confirmed: true });
      setCommitResult(r);
      if (r.exitCode === 0) setCommitMsg("");
      await refreshGit(true);
    } catch (e) {
      setCommitResult({ error: errorMessage(e, "提交失败") });
    } finally {
      setCommitting(false);
    }
  };

  const runCmd = async (confirmed: boolean, command = cmd) => {
    if (!command.trim()) return;
    setRunning(true);
    setPending(null);
    const id = ++runSeq.current;
    const push = (run: TerminalRun) => setRuns((rs) => [...rs, run].slice(-MAX_RUNS));
    try {
      const r = await api.toolShell({ workspace, command, shell, confirmed });
      push({ id, command, result: r });
      if (!r.needsConfirm) setCmd("");
      // 命令可能改动了工作区(git add、生成文件等),顺带刷新变更
      void refreshGit(changesVisible);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 409:需要确认 → 显示确认条
      if (msg.startsWith("409")) setPending({ command });
      else push({ id, command, error: errorMessage(e) });
    } finally {
      setRunning(false);
    }
  };

  const openFile = async (path: string) => {
    try {
      const r = await api.readFile(workspace, path);
      onPreview?.({ kind: "artifact", title: path, body: r.content, lang: langFromPath(path) || "text" });
    } catch (e) {
      onPreview?.({ kind: "terminal", title: path, body: errorMessage(e, "读取失败") });
    }
  };

  const fileCount = preview?.files.length ?? 0;
  useInspectorBadge("changes", fileCount || undefined);

  const isActive = (id: "changes" | "terminal") => !!bridge?.open && bridge.active === id;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContextBar
        label="工作区"
        workspace={workspace}
        placeholder="项目目录绝对路径"
        onBind={async (path) => {
          await api.updateSession(session.id, { workspace: path });
          onSessionChanged();
        }}
        chips={
          branch && (
            <span
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-1.5 font-mono text-2xs text-muted"
              title={`当前分支 ${branch.name}`}
            >
              <GitBranch size={12} strokeWidth={1.75} aria-hidden />
              <span className="max-w-[160px] truncate">{branch.name}</span>
              {branch.ahead > 0 && <span className="text-ok">↑{branch.ahead}</span>}
              {branch.behind > 0 && <span className="text-warn">↓{branch.behind}</span>}
            </span>
          )
        }
      >
        <PanelToggle
          icon={GitCompareArrows}
          label="变更"
          count={fileCount}
          active={isActive("changes")}
          onClick={() => bridge?.togglePanel("changes")}
        />
        <PanelToggle
          icon={SquareTerminal}
          label="终端"
          count={runs.length}
          active={isActive("terminal")}
          onClick={() => bridge?.togglePanel("terminal")}
        />
      </ContextBar>

      <ChatPage
        key={session.id}
        session={session}
        onPreview={onPreview}
        onBranch={onBranch}
        onNewSession={onNewSession}
        onCandidatesChanged={onCandidatesChanged}
        onSessionChanged={onSessionChanged}
      />

      <InspectorPortal id="changes">
        <ChangesPanel
          workspace={workspace}
          loading={gitLoading}
          error={gitError}
          preview={preview}
          diffText={diffText}
          diffError={diffError}
          selected={selected}
          onToggle={toggleFile}
          onToggleAll={(all) => setSelected(all ? (preview?.files.map((f) => f.path) ?? []) : [])}
          commitMsg={commitMsg}
          onCommitMsg={setCommitMsg}
          committing={committing}
          commitResult={commitResult}
          onDismissResult={() => setCommitResult(null)}
          onCommit={() => void commit()}
          onRefresh={() => void refreshGit(true)}
          onPreview={onPreview}
          onOpenFile={(p) => void openFile(p)}
        />
      </InspectorPortal>

      <InspectorPortal id="terminal">
        <TerminalPanel
          workspace={workspace}
          shells={shells}
          shell={shell}
          onShell={setShell}
          cmd={cmd}
          onCmd={setCmd}
          running={running}
          pending={pending}
          onRun={() => void runCmd(false)}
          onConfirm={() => pending && void runCmd(true, pending.command)}
          onCancelPending={() => setPending(null)}
          runs={runs}
          onClear={() => setRuns([])}
        />
      </InspectorPortal>
    </div>
  );
}
