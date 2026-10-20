import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GitPreview, GitStatusEntry } from "@xiyun/shared";
import { assertInside } from "./workspace.ts";

// ---- 阶段 4:Windows 工具层(PathGuard 复用 workspace.ts 的 assertInside)----

export interface ShellInfo {
  id: string;
  name: string;
  exe: string;
  args: (cmd: string) => string[];
}

export interface ShellResult {
  shell: string;
  cwd: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

// 工具调用错误:needsConfirm=true 时前端/子智能体应走确认流程而不是重试。
export class ToolError extends Error {
  needsConfirm: boolean;
  constructor(message: string, needsConfirm = false) {
    super(message);
    this.needsConfirm = needsConfirm;
  }
}

// 绝对拒绝:删除根/递归强删、格式化、关机、fork 炸弹。命中即拒,确认也不放行。
const DENY_RE =
  /(rm\s+-[a-z]*[rf][a-z]*\s+([/\\~*]|\.{1,2}\s)|del\s+\/[fs]|erase\s+\/[fs]|format\s+[a-zA-Z]:|shutdown\b|reboot\b|Remove-Item[\s\S]*-Recurse[\s\S]*-Force|mkfs|:\s*\(\s*\)\s*\{)/i;

// 只读命令免确认。其余命令(git push、安装、脚本等)必须 confirmed=true。
const SAFE_RE =
  /^\s*(git\s+(status|diff|log|show|branch|remote|ls-files|blame)\b|ls\b|dir\b|pwd\b|echo\b|type\b|cat\b|where\b|which\b|node\s+--version|npm\s+--version|pnpm\s+--version|git\s+--version)/i;

// 测试命令视为安全(tester 可运行测试,不写生产文件)。
const TEST_RE =
  /^\s*((npm|pnpm)\s+(test|run\s+(test|tests|typecheck|lint|build))|(npx\s+)?vitest(\s+run)?\b|node\s+--test\b)/i;

// R-007:命令参数中出现绝对路径/驱动器/~/.. 时,即使是白名单命令也升级为 confirm。
// ponytail: 启发式判定——Git Bash 的 /c/... 与 Windows 盘符无法互相解析,统一升级确认而不精确判定越界。
const OUTSIDE_PATH_RE = /(^|\s|"|')([A-Za-z]:[\\/]|\/[^/]|~[\\/]|\.{2}[\\/])/;

export type CommandClass = "deny" | "safe" | "confirm";

export function classifyCommand(command: string): CommandClass {
  if (DENY_RE.test(command)) return "deny";
  if (OUTSIDE_PATH_RE.test(command)) return "confirm";
  if (SAFE_RE.test(command) || TEST_RE.test(command)) return "safe";
  return "confirm";
}

let shellCache: ShellInfo[] | null = null;

// 探测本机可用 shell:PowerShell、Git Bash、WSL(Windows 优先;POSIX 直接用 sh)。
export function detectShells(): ShellInfo[] {
  if (shellCache) return shellCache;
  const found: ShellInfo[] = [];
  const probe = (exe: string) =>
    process.platform !== "win32" ||
    spawnSync("where.exe", [exe], { stdio: "ignore" }).status === 0;
  if (process.platform === "win32") {
    if (probe("powershell.exe"))
      found.push({
        id: "powershell", name: "PowerShell", exe: "powershell.exe",
        args: (c) => ["-NoProfile", "-Command", c],
      });
    if (probe("bash.exe"))
      found.push({ id: "gitbash", name: "Git Bash", exe: "bash.exe", args: (c) => ["-lc", c] });
    if (probe("wsl.exe"))
      found.push({ id: "wsl", name: "WSL", exe: "wsl.exe", args: (c) => ["bash", "-lc", c] });
  }
  if (found.length === 0)
    found.push({ id: "sh", name: "sh", exe: "sh", args: (c) => ["-lc", c] });
  shellCache = found;
  return found;
}

const MAX_OUTPUT = 200 * 1024; // ponytail: 输出截断在 200KB,大输出用 files.read 分页读取

export function shellExec(opts: {
  workspace: string;
  command: string;
  shell?: string;
  confirmed?: boolean;
  timeoutMs?: number;
}): Promise<ShellResult> {
  const cls = classifyCommand(opts.command);
  if (cls === "deny") return Promise.reject(new ToolError("危险命令被拒绝执行"));
  if (cls === "confirm" && !opts.confirmed)
    return Promise.reject(new ToolError(`命令需要用户确认:${opts.command}`, true));

  const shells = detectShells();
  const sh = shells.find((s) => s.id === opts.shell) ?? shells[0];
  const cwd = assertInside(opts.workspace, ".");
  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(sh.exe, sh.args(opts.command), { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 60_000);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ToolError(`shell 启动失败:${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        shell: sh.id, cwd, command: opts.command,
        exitCode: code ?? (timedOut ? -1 : 1),
        stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT),
        durationMs: Date.now() - t0, timedOut,
      });
    });
  });
}

// ---- 文件工具 ----

export function readTool(workspace: string, path: string): string {
  const abs = assertInside(workspace, path);
  const buf = readFileSync(abs);
  if (buf.length > MAX_OUTPUT) throw new ToolError(`文件过大(${buf.length}B),请分段或用 shell 查看`);
  return buf.toString("utf8");
}

export function writeTool(workspace: string, path: string, content: string): { path: string; bytes: number } {
  const abs = assertInside(workspace, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return { path, bytes: Buffer.byteLength(content) };
}

// 工作区文件树(相对路径列表):跳过依赖/构建目录,深度 ≤4,最多 500 条。
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "target"]);

export function listTool(workspace: string, subdir = "."): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 4 || out.length >= 500) return;
    const abs = assertInside(workspace, rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (out.length >= 500) return;
      const r = rel === "." ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(r, depth + 1);
      } else {
        out.push(r);
      }
    }
  };
  walk(subdir || ".", 0);
  return out;
}

// ---- Git 工具(提交必须 confirmed=true)----

// 内部固定 git 命令:argv 直传,不经 classifyCommand 闸,也不经 shell。
// 为什么不用 shellExec:JSON.stringify 的引号在 PowerShell 下会被解释(路径含 $ 会被插值),
// argv 直传既无引号歧义也无注入面;此处命令全部由本模块硬编码,不含用户拼接的 shell 片段。
function gitExec(workspace: string, args: string[], timeoutMs = 30_000): Promise<ShellResult> {
  const cwd = assertInside(workspace, ".");
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ToolError(`git 启动失败:${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        shell: "git", cwd, command: ["git", ...args].join(" "),
        exitCode: code ?? (timedOut ? -1 : 1),
        stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT),
        durationMs: Date.now() - t0, timedOut,
      });
    });
  });
}

// porcelain=v1 -z 解析:每条记录为 "XY <path>\0";rename/copy 紧随一条原路径记录
// (实测格式 `R  <新路径>\0<原路径>\0`),丢弃原路径,path 取新路径即待暂存目标。
function parseStatusEntries(raw: string): GitStatusEntry[] {
  const parts = raw.split("\0").filter((s) => s.length > 0);
  const out: GitStatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 3) continue;
    const x = rec[0];
    const y = rec[1];
    if (x === "R" || x === "C") i++; // 跳过原路径记录
    out.push({
      path: rec.slice(3),
      x, y,
      staged: x !== " " && x !== "?",
      unstaged: y !== " ",
      untracked: x === "?" && y === "?",
    });
  }
  return out;
}

export async function gitStatusEntries(workspace: string): Promise<GitStatusEntry[]> {
  const r = await gitExec(workspace, ["status", "--porcelain=v1", "-z"]);
  if (r.exitCode !== 0) throw new ToolError(`git status 失败:${r.stderr.trim() || `exit ${r.exitCode}`}`);
  return parseStatusEntries(r.stdout);
}

// 提交前预览:文件清单 + 未暂存/已暂存差异摘要。
// cachedStat 非空表示工作区已有用户手动暂存的内容,提交时会一并带入。
export async function gitPreview(workspace: string): Promise<GitPreview> {
  const [files, unstaged, cached] = await Promise.all([
    gitStatusEntries(workspace),
    gitExec(workspace, ["diff", "--stat"]),
    gitExec(workspace, ["diff", "--cached", "--stat"]),
  ]);
  return {
    files,
    diffStat: unstaged.stdout.trim(),
    cachedStat: cached.stdout.trim(),
  };
}

// 只提交明确选择的文件(不执行 git add -A),避免带上用户未选择的变更。
// 用户已有暂存内容不剥离:那是用户自己的操作,由前端用 gitPreview 的 cachedStat 提前展示。
export async function gitCommit(opts: {
  workspace: string;
  message: string;
  files?: string[];
  confirmed?: boolean;
}): Promise<ShellResult> {
  if (!opts.confirmed) throw new ToolError("git commit 必须用户确认", true);
  const files = (opts.files ?? []).map((f) => String(f).trim()).filter((f) => f.length > 0);
  if (files.length === 0) throw new ToolError("未选择提交文件");
  for (const f of files) {
    // 只接受工作区相对路径;`..`/前导斜杠/盘符一律拒绝,防止越出工作区暂存。
    if (f.includes("..") || f.startsWith("/") || f.startsWith("\\") || /^[A-Za-z]:/.test(f))
      throw new ToolError(`提交路径必须是工作区相对路径:${f}`);
  }
  if (!opts.message.trim()) throw new ToolError("缺少提交信息");
  const add = await gitExec(opts.workspace, ["add", "--", ...files]);
  if (add.exitCode !== 0)
    throw new ToolError(`git add 失败:${add.stderr.trim() || `exit ${add.exitCode}`}`);
  return gitExec(opts.workspace, ["commit", "-m", opts.message]);
}

// ---- 子智能体工具矩阵(写角色 vs 只读角色,决策见 DECISIONS.md D-007 权限分层)----

export const ROLE_TOOLS: Record<string, string[]> = {
  coder: ["files.list", "files.read", "files.write", "shell.exec", "git.status", "git.diff"],
  tester: ["files.list", "files.read", "shell.exec", "git.status", "git.diff"],
  reviewer: ["files.list", "files.read", "shell.exec", "git.status", "git.diff"],
  researcher: ["files.list", "files.read", "shell.exec", "git.status", "git.diff"],
  tutor: [],
  memory: [],
};

// 子智能体内的工具执行:无交互确认通道,只允许 safe 命令;工作区由 PathGuard 限制。
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { workspace: string },
): Promise<string> {
  const arg = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  switch (name) {
    case "files.read":
      return readTool(ctx.workspace, arg("path"));
    case "files.list":
      return listTool(ctx.workspace, arg("path") || ".").join("\n");
    case "files.write": {
      const r = writeTool(ctx.workspace, arg("path"), String(args.content ?? ""));
      return `已写入 ${r.path}(${r.bytes}B)`;
    }
    case "shell.exec": {
      const r = await shellExec({ workspace: ctx.workspace, command: arg("command"), timeoutMs: 60_000 });
      return `exit=${r.exitCode}${r.timedOut ? " (超时)" : ""}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`;
    }
    case "git.status": {
      const r = await shellExec({ workspace: ctx.workspace, command: "git status --short --branch" });
      return r.stdout || "(clean)";
    }
    case "git.diff": {
      const r = await shellExec({ workspace: ctx.workspace, command: "git diff HEAD" });
      return r.stdout || "(no diff)";
    }
    default:
      throw new ToolError(`未知工具:${name}`);
  }
}
