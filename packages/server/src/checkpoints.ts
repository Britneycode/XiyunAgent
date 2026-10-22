import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { promisify } from "node:util";

// ---- 工作区快照(L1 / D-025)----
// 每个工作区一个影子仓库 <dataDir>/checkpoints/<sha1(realpath(ws)) 前 16 位>.git,
// 全部用 --git-dir / --work-tree 操作,不碰用户自己的 .git。
// 快照 = add -A + write-tree;内容没变就复用 HEAD。回退用 read-tree -u --reset。

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const MAX_FILES = 20_000; // 文件数超过后关闭快照(遍历太慢)
const MAX_SNAPSHOTS = 200;
const MAX_AGE_DAYS = 30;

// 不纳入快照的目录(与仓库自身的 .gitignore 无关:影子仓库只记源码)
const EXCLUDES = [".git/", "node_modules/", ".xiyun-wt/", "dist/", "build/", ".next/", "target/", ".xiyun/"];

export interface SnapshotInfo {
  sha: string;
  reused: boolean;
}

export interface CheckpointStoreOptions {
  dataDir: string;
  // 测试可注入:跳过"home / 根目录"与文件数检查
  skipGuards?: boolean;
}

// 快照被关闭的原因(工作区过大 / 是 home 或根目录);null 表示可用
export type DisabledReason = string | null;

function gitDirFor(dataDir: string, workspace: string): string {
  const real = resolve(workspace);
  const key = createHash("sha1").update(real).digest("hex").slice(0, 16);
  return join(dataDir, "checkpoints", `${key}.git`);
}

// 统计文件数(粗略,遇到 MAX_FILES 就停)
function countFiles(root: string, limit = MAX_FILES): number {
  let n = 0;
  const walk = (dir: string, depth: number) => {
    if (n >= limit || depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (n >= limit) return;
      if (e.isDirectory()) {
        if (!EXCLUDES.some((x) => x.startsWith(`${e.name}/`)) && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) n++;
    }
  };
  walk(root, 0);
  return n;
}

export class CheckpointStore {
  private dataDir: string;
  private skipGuards: boolean;
  private ready = new Map<string, boolean>(); // workspace -> 影子仓库已初始化
  private disabled = new Map<string, DisabledReason>();

  constructor(opts: CheckpointStoreOptions) {
    this.dataDir = opts.dataDir;
    this.skipGuards = opts.skipGuards === true;
  }

  // bare 仓库:只给 --git-dir,不带 --work-tree(git 不允许 init 时同时指定两者)
  private async gitBare(workspace: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    const gitDir = gitDirFor(this.dataDir, workspace);
    return this.runGit([`--git-dir=${gitDir}`, ...args]);
  }

  // 工作树命令:同时给 --git-dir 与 --work-tree
  private async git(workspace: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    const gitDir = gitDirFor(this.dataDir, workspace);
    return this.runGit([`--git-dir=${gitDir}`, `--work-tree=${resolve(workspace)}`, ...args]);
  }

  private async runGit(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const r = await run("git", argv, { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      return { stdout: r.stdout, stderr: r.stderr, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "", code: err.code ?? 1 };
    }
  }

  // 首次使用前初始化影子仓库;返回是否可用
  async ensure(workspace: string): Promise<DisabledReason> {
    if (this.disabled.has(workspace)) return this.disabled.get(workspace) ?? null;
    if (this.ready.get(workspace)) return null;
    if (!workspace || !existsSync(workspace)) {
      this.disabled.set(workspace, "工作区不存在");
      return this.disabled.get(workspace) ?? null;
    }
    if (!this.skipGuards) {
      const real = resolve(workspace);
      if (real === resolve(homedir()) || parse(real).root === real) {
        this.disabled.set(workspace, "工作区是用户主目录或磁盘根目录,已关闭快照");
        return this.disabled.get(workspace) ?? null;
      }
      if (countFiles(real) >= MAX_FILES) {
        this.disabled.set(workspace, `文件数超过 ${MAX_FILES},已关闭快照`);
        return this.disabled.get(workspace) ?? null;
      }
    }
    const gitDir = gitDirFor(this.dataDir, workspace);
    mkdirSync(join(this.dataDir, "checkpoints"), { recursive: true });
    const init = await this.gitBare(workspace, ["init", "--bare", "--quiet"]);
    if (init.code !== 0) {
      this.disabled.set(workspace, `快照仓库初始化失败:${init.stderr.trim().slice(0, 200)}`);
      return this.disabled.get(workspace) ?? null;
    }
    // 影子仓库不跟随用户的换行配置,避免 Windows 上 CRLF 造成内容漂移
    await this.gitBare(workspace, ["config", "core.autocrlf", "false"]);
    await this.gitBare(workspace, ["config", "user.name", "xiyun"]);
    await this.gitBare(workspace, ["config", "user.email", "xiyun@localhost"]);
    const excludeFile = join(gitDir, "info", "exclude");
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(excludeFile, `${EXCLUDES.join("\n")}\n`, "utf8");
    this.ready.set(workspace, true);
    return null;
  }

  // 拍快照:内容与 HEAD 相同就复用 HEAD,否则 commit-tree + update-ref
  async snapshot(workspace: string, label: string): Promise<SnapshotInfo | null> {
    if (await this.ensure(workspace)) return null;
    const add = await this.git(workspace, ["add", "-A"]);
    if (add.code !== 0) return null;
    const tree = await this.git(workspace, ["write-tree"]);
    if (tree.code !== 0) return null;
    const treeSha = tree.stdout.trim();

    const head = await this.git(workspace, ["rev-parse", "-q", "--verify", "HEAD"]);
    const headSha = head.code === 0 ? head.stdout.trim() : "";
    if (headSha) {
      const headTree = await this.git(workspace, ["rev-parse", `${headSha}^{tree}`]);
      if (headTree.code === 0 && headTree.stdout.trim() === treeSha) return { sha: headSha, reused: true };
    }
    const commit = await this.git(workspace, [
      "commit-tree", treeSha, ...(headSha ? ["-p", headSha] : []),
      "-m", label.slice(0, 200) || "snapshot",
    ]);
    if (commit.code !== 0) return null;
    const sha = commit.stdout.trim();
    const update = await this.git(workspace, ["update-ref", "HEAD", sha]);
    return update.code === 0 ? { sha, reused: false } : null;
  }

  // 回退到指定快照。返回是否成功。
  // read-tree -u --reset 只覆盖/恢复快照里的文件,不会删除快照之后新增的文件,
  // 所以先算出"当前工作区有、目标树没有"的路径逐个删掉;被忽略的目录(如 node_modules)不在快照里,不受影响。
  async restore(workspace: string, sha: string): Promise<boolean> {
    if (await this.ensure(workspace)) return false;
    const exists = await this.git(workspace, ["cat-file", "-e", `${sha}^{commit}`]);
    if (exists.code !== 0) return false;

    // 先把当前工作区拍进索引,才能准确比较差异
    await this.git(workspace, ["add", "-A"]);
    const toDelete = await this.git(workspace, ["diff", "--name-only", "--diff-filter=D", "--no-renames", sha]);
    // 用 --diff-filter 找的是"目标有、当前没有";反过来要找"当前有、目标没有":
    const removed = await this.git(workspace, ["diff", "--name-only", "--diff-filter=A", "--no-renames", sha]);
    void toDelete;
    const r = await this.git(workspace, ["read-tree", "-u", "--reset", sha]);
    if (r.code !== 0) return false;
    for (const p of removed.stdout.split("\n").map((x) => x.trim()).filter(Boolean)) {
      try {
        rmSync(join(workspace, p), { force: true });
      } catch {
        // 单个文件删除失败不影响其余
      }
    }
    return true;
  }

  // 快照与当前工作区之间的改动文件(供确认对话框列出将要还原的文件)
  async diffFiles(workspace: string, from: string): Promise<Array<{ status: string; path: string }>> {
    if (await this.ensure(workspace)) return [];
    // 先刷新索引,让工作区的新增/修改都能被比较到
    await this.git(workspace, ["add", "-A"]);
    const r = await this.git(workspace, ["diff", "--name-status", "--no-renames", from]);
    if (r.code !== 0) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [status, ...rest] = l.split(/\s+/);
        return { status: status ?? "M", path: rest.join(" ") };
      });
  }

  async diffText(workspace: string, from: string): Promise<string> {
    if (await this.ensure(workspace)) return "";
    await this.git(workspace, ["add", "-A"]);
    const r = await this.git(workspace, ["diff", from]);
    return r.code === 0 ? r.stdout : "";
  }

  // 清理:超过 30 天或数量超过 200 时 gc;启动时调用
  async prune(workspace: string): Promise<void> {
    if (await this.ensure(workspace)) return;
    const count = await this.git(workspace, ["rev-list", "--count", "HEAD"]);
    const n = Number(count.stdout.trim()) || 0;
    if (n > MAX_SNAPSHOTS) {
      // 保留最近 MAX_SNAPSHOTS 个:把更早的提交串成一个新的根
      const list = await this.git(workspace, ["rev-list", "--reverse", "HEAD"]);
      const shas = list.stdout.split("\n").filter(Boolean);
      const keep = shas.slice(-MAX_SNAPSHOTS);
      if (keep.length) await this.git(workspace, ["update-ref", "HEAD", keep[0]!]);
    }
    await this.git(workspace, ["gc", "--prune", `--prune=${MAX_AGE_DAYS}.days.ago`, "--quiet"]);
  }
}
