import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitExec } from "./tools.ts";
import { assertInside } from "./workspace.ts";

// L4:后台写任务用独立 git worktree 隔离,改动不直接落在用户工作区。
// worktree 放在 <workspace>/.xiyun-wt/<taskId>,并在 .git/info/exclude 里排除,免得污染用户的 git status。
// 用户确认后由「合并 / 推送 / 建 PR」把分支落地,「丢弃」把 worktree 与分支一起清掉。

export const WORKTREE_DIR = ".xiyun-wt";

export interface WorktreeInfo {
  path: string; // worktree 绝对路径
  branch: string; // 分支名
  baseSha: string; // 分支起点(用户工作区当时的 HEAD)
  root: string; // 用户工作区(主仓库)路径
}

export function worktreeRoot(workspace: string): string {
  return assertInside(workspace, WORKTREE_DIR);
}

export function branchOf(taskId: string): string {
  return `xiyun/${taskId}`;
}

// 工作区是不是 git 仓库(不是仓库时子任务照常在原工作区跑)
export async function isGitRepo(workspace: string): Promise<boolean> {
  if (!workspace) return false;
  try {
    const r = await gitExec(workspace, ["rev-parse", "--git-dir"]);
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

export async function headSha(workspace: string): Promise<string> {
  const r = await gitExec(workspace, ["rev-parse", "HEAD"]);
  if (r.exitCode !== 0) throw new Error(`读取 HEAD 失败:${r.stderr.trim() || `exit ${r.exitCode}`}`);
  return r.stdout.trim();
}

// 把 .xiyun-wt/ 写进 .git/info/exclude
export async function excludeWorktrees(workspace: string): Promise<void> {
  const r = await gitExec(workspace, ["rev-parse", "--git-dir"]);
  if (r.exitCode !== 0) return;
  const dir = resolve(workspace, r.stdout.trim());
  const file = join(dir, "info", "exclude");
  mkdirSync(join(dir, "info"), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur.split(/\r?\n/).some((l) => l.trim() === `${WORKTREE_DIR}/`)) return;
  writeFileSync(file, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + `${WORKTREE_DIR}/\n`, "utf8");
}

// 分支是否已存在(重跑同一任务时复用上次的分支,而不是再建一个同名分支)
export async function branchExists(workspace: string, branch: string): Promise<boolean> {
  const r = await gitExec(workspace, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.exitCode === 0;
}

// 分支与当前 HEAD 的共同祖先,作为 diff 的基准
export async function mergeBase(workspace: string, branch: string): Promise<string> {
  const r = await gitExec(workspace, ["merge-base", "HEAD", branch]);
  if (r.exitCode !== 0) throw new Error(`找不到分支 ${branch} 的共同祖先`);
  return r.stdout.trim();
}

// 建隔离 worktree:新分支从当前 HEAD 拉出,不影响用户工作区。
// 分支已存在时直接检出该分支(重跑任务),起点取它与 HEAD 的共同祖先。
export async function createWorktree(workspace: string, taskId: string): Promise<WorktreeInfo> {
  const root = worktreeRoot(workspace);
  mkdirSync(root, { recursive: true });
  await excludeWorktrees(workspace);
  const branch = branchOf(taskId);
  const path = join(root, taskId);
  const existed = await branchExists(workspace, branch);
  const baseSha = existed ? await mergeBase(workspace, branch) : await headSha(workspace);
  const args = existed
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, baseSha];
  const r = await gitExec(workspace, args, 60_000);
  if (r.exitCode !== 0)
    throw new Error(`创建 worktree 失败:${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`);
  return { path, branch, baseSha, root: workspace };
}

// 清理 worktree 与分支(任务失败 / 无改动 / 用户丢弃时调用)
export async function removeWorktree(workspace: string, path: string, branch: string): Promise<void> {
  const abs = assertInside(workspace, path);
  await gitExec(workspace, ["worktree", "remove", "--force", abs], 60_000);
  // 分支可能已被合并或已删除,删不掉不算失败
  await gitExec(workspace, ["branch", "-D", branch]);
  await gitExec(workspace, ["worktree", "prune"]);
  // worktree remove 失败时兜底删目录
  if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
}

// worktree 里有没有未提交的改动
export async function hasChanges(worktree: string): Promise<boolean> {
  const r = await gitExec(worktree, ["status", "--porcelain"]);
  return r.exitCode === 0 && r.stdout.trim().length > 0;
}

// 隔离分支上的自动提交:只在 worktree 内进行(worktree 有自己的 index 与 HEAD),
// 不影响用户工作区,也不动用户当前分支。
export async function commitAll(worktree: string, message: string): Promise<void> {
  const add = await gitExec(worktree, ["add", "-A"]);
  if (add.exitCode !== 0) throw new Error(`git add 失败:${add.stderr.trim() || `exit ${add.exitCode}`}`);
  const c = await gitExec(worktree, ["commit", "-m", message]);
  if (c.exitCode !== 0) throw new Error(`git commit 失败:${c.stderr.trim() || `exit ${c.exitCode}`}`);
}

// 分支相对起点的变更统计
export async function diffStat(workspace: string, baseSha: string, branch: string): Promise<string> {
  const r = await gitExec(workspace, ["diff", "--stat", `${baseSha}..${branch}`]);
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

// 分支相对起点的完整 diff(base_sha...branch),供任务卡片展开查看
export async function diffText(workspace: string, baseSha: string, branch: string): Promise<string> {
  const r = await gitExec(workspace, ["diff", `${baseSha}..${branch}`], 60_000);
  return r.exitCode === 0 ? r.stdout : "";
}

// 合并分支到用户当前分支;冲突时中止合并,不让工作区停在冲突状态
export async function mergeBranch(workspace: string, branch: string): Promise<string> {
  const r = await gitExec(workspace, ["merge", "--no-ff", "-m", `合并子任务分支 ${branch}`, branch], 60_000);
  if (r.exitCode === 0) return r.stdout.trim() || `已合并 ${branch}`;
  await gitExec(workspace, ["merge", "--abort"]);
  throw new Error(`合并冲突,已中止:${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`);
}

// 推送分支到远端
export async function pushBranch(workspace: string, branch: string, remote = "origin"): Promise<string> {
  const r = await gitExec(workspace, ["push", "-u", remote, branch], 120_000);
  if (r.exitCode !== 0) throw new Error(`推送失败:${r.stderr.trim() || `exit ${r.exitCode}`}`);
  return `${r.stdout.trim()}\n${r.stderr.trim()}`.trim();
}

// 远端仓库地址(去掉 .git 后缀),用于拼 compare 链接
export async function remoteUrl(workspace: string, remote = "origin"): Promise<string | null> {
  const r = await gitExec(workspace, ["remote", "get-url", remote]);
  if (r.exitCode !== 0) return null;
  return r.stdout.trim().replace(/\.git$/, "");
}

// gh 可用时建 PR;不可用返回 null,由调用方给 compare 链接
export async function createPullRequest(
  workspace: string,
  branch: string,
  title: string,
  body: string,
  base?: string,
): Promise<{ url: string } | { error: string } | null> {
  const args = ["pr", "create", "--head", branch, "--title", title, "--body", body];
  if (base) args.push("--base", base);
  return new Promise((resolvePromise) => {
    const child = spawn("gh", args, { cwd: resolve(workspace), windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", () => resolvePromise(null)); // 没装 gh
    child.on("close", (code) => {
      if (code !== 0) {
        resolvePromise({ error: stderr.trim() || stdout.trim() || `gh 退出码 ${code}` });
        return;
      }
      const m = stdout.match(/https?:\/\/\S+/);
      resolvePromise(m ? { url: m[0] } : { error: stdout.trim() || "未取到 PR 链接" });
    });
  });
}
