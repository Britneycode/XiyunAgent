import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";
import {
  classifyCommand, detectShells, gitCommit, gitPreview, gitStatusEntries,
  readTool, shellExec, writeTool,
} from "./tools.ts";

describe("classifyCommand", () => {
  it("只读与测试命令免确认", () => {
    expect(classifyCommand("git status")).toBe("safe");
    expect(classifyCommand("git diff HEAD")).toBe("safe");
    expect(classifyCommand("pnpm test")).toBe("safe");
    expect(classifyCommand("ls -la")).toBe("safe");
  });
  it("写操作类命令需要确认", () => {
    expect(classifyCommand("git push origin main")).toBe("confirm");
    expect(classifyCommand("pnpm install")).toBe("confirm");
  });
  it("危险命令直接拒绝", () => {
    expect(classifyCommand("rm -rf /")).toBe("deny");
    expect(classifyCommand("format C:")).toBe("deny");
    expect(classifyCommand("Remove-Item ./x -Recurse -Force")).toBe("deny");
    expect(classifyCommand("shutdown /s")).toBe("deny");
  });
  it("R-007:带工作区外路径/绝对路径的读命令升级为 confirm", () => {
    expect(classifyCommand("cat D:/other/package.json")).toBe("confirm");
    expect(classifyCommand("cat /c/Windows/win.ini")).toBe("confirm");
    expect(classifyCommand("type ..\\secret.txt")).toBe("confirm");
    expect(classifyCommand("cat ~/.ssh/config")).toBe("confirm");
    expect(classifyCommand("cat README.md")).toBe("safe"); // 相对路径仍免确认
  });
});

describe("文件工具(PathGuard)", () => {
  const ws = mkdtempSync(join(tmpdir(), "xiyun-tools-"));
  it("工作区内读写正常", () => {
    writeTool(ws, "sub/a.txt", "hello");
    expect(readTool(ws, "sub/a.txt")).toBe("hello");
  });
  it("工作区外路径被拒绝", () => {
    expect(() => readTool(ws, "../outside.txt")).toThrow("outside workspace");
    expect(() => writeTool(ws, "..\\evil.txt", "x")).toThrow("outside workspace");
  });
  it("收尾清理", () => {
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("shellExec", () => {
  const ws = process.cwd();
  it("能探测到至少一个 shell 并执行安全命令", async () => {
    const shells = detectShells();
    expect(shells.length).toBeGreaterThan(0);
    const r = await shellExec({ workspace: ws, command: "echo ponytail-ok" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ponytail-ok");
    expect(r.cwd).toBe(ws);
  });
  it("危险命令即使有 confirmed 也被拒绝", async () => {
    await expect(shellExec({ workspace: ws, command: "rm -rf /", confirmed: true })).rejects.toThrow("危险命令");
  });
  it("非白名单命令未确认时报 needsConfirm", async () => {
    await expect(shellExec({ workspace: ws, command: "git push" })).rejects.toMatchObject({ needsConfirm: true });
  });
  it("git commit 必须 confirmed", async () => {
    await expect(gitCommit({ workspace: ws, message: "x" })).rejects.toMatchObject({ needsConfirm: true });
  });

  it("onData 逐块回调输出(F7)", async () => {
    const chunks: string[] = [];
    const r = await shellExec({
      workspace: ws,
      command: "echo streaming-ok",
      onData: (chunk, stream) => {
        if (stream === "stdout") chunks.push(chunk);
      },
    });
    expect(r.exitCode).toBe(0);
    expect(chunks.join("")).toContain("streaming-ok");
  });

  it("输出只保留最后 200KB", async () => {
    // 生成 300KB 输出,尾部标记应保留、头部应被丢弃
    const cmd = process.platform === "win32"
      ? "powershell -NoProfile -Command \"'x' * 300000; 'TAIL-MARK'\""
      : "python3 -c \"print('x'*300000); print('TAIL-MARK')\"";
    const r = await shellExec({ workspace: ws, command: cmd, confirmed: true, timeoutMs: 60_000 });
    expect(r.stdout.length).toBeLessThanOrEqual(200 * 1024);
    expect(r.stdout).toContain("TAIL-MARK");
  }, 60_000);

  it("signal 中断时结束进程树并以 AbortError 拒绝", async () => {
    const ac = new AbortController();
    const p = shellExec({
      workspace: ws,
      command: process.platform === "win32" ? "powershell -NoProfile -Command \"Start-Sleep 30\"" : "sleep 30",
      confirmed: true,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 150);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  }, 20_000);

  it("空闲超时结束命令", async () => {
    const r = await shellExec({
      workspace: ws,
      command: process.platform === "win32" ? "powershell -NoProfile -Command \"Start-Sleep 5\"" : "sleep 5",
      confirmed: true,
      idleMs: 200,
      timeoutMs: 20_000,
    });
    expect(r.timedOut).toBe(true);
  }, 20_000);
});

// ---- 阶段 2:Git 提交范围 ----

// 临时 git 仓库夹具。git 不可用由 describe.skipIf 处理;git 可用但建仓失败直接抛错,
// 避免用例静默通过。
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "xiyun-git-"));
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  const ok = (args: string[]) => {
    const r = run(args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败:${r.stderr || r.status}`);
  };
  ok(["init"]);
  ok(["config", "user.email", "t@xiyun.test"]);
  ok(["config", "user.name", "xiyun-test"]);
  ok(["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "a.txt"), "a1\n", "utf8");
  writeFileSync(join(dir, "b.txt"), "b1\n", "utf8");
  ok(["add", "-A"]);
  ok(["commit", "-m", "init"]);
  return dir;
}

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const gitLog = (dir: string) =>
  spawnSync("git", ["log", "--pretty=%s", "-1"], { cwd: dir, encoding: "utf8", windowsHide: true }).stdout.trim();
const gitShowFiles = (dir: string) =>
  spawnSync("git", ["show", "--name-only", "--pretty=", "HEAD"], { cwd: dir, encoding: "utf8", windowsHide: true })
    .stdout.trim().split("\n").filter(Boolean);
const gitStatus = (dir: string) =>
  spawnSync("git", ["status", "--porcelain=v1"], { cwd: dir, encoding: "utf8", windowsHide: true }).stdout;

describe.skipIf(!gitAvailable)("Git 提交范围(阶段 2)", () => {
  it("选择性提交只包含选中文件", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a2\n", "utf8");
    writeFileSync(join(dir, "b.txt"), "b2\n", "utf8");
    const r = await gitCommit({ workspace: dir, message: "only a", files: ["a.txt"], confirmed: true });
    expect(r.exitCode).toBe(0);
    expect(gitShowFiles(dir)).toEqual(["a.txt"]);
    expect(gitLog(dir)).toBe("only a");
    // b.txt 仍是未提交的工作区改动
    const entries = await gitStatusEntries(dir);
    expect(entries.map((e) => e.path)).toEqual(["b.txt"]);
    expect(entries[0].unstaged).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("已有暂存内容与新选择文件并存时 preview 的 cachedStat 非空", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a2\n", "utf8");
    writeFileSync(join(dir, "b.txt"), "b2\n", "utf8");
    spawnSync("git", ["add", "--", "a.txt"], { cwd: dir, windowsHide: true }); // 用户手动暂存 a
    const p = await gitPreview(dir);
    expect(p.cachedStat).not.toBe("");
    expect(p.cachedStat).toContain("a.txt");
    expect(p.diffStat).toContain("b.txt");
    const a = p.files.find((f) => f.path === "a.txt");
    const b = p.files.find((f) => f.path === "b.txt");
    expect(a).toMatchObject({ staged: true, unstaged: false, untracked: false });
    expect(b).toMatchObject({ staged: false, unstaged: true, untracked: false });
    // server 不剥离用户已有暂存:只选 b.txt 提交时,a.txt 会随暂存区一并进入提交。
    const r = await gitCommit({ workspace: dir, message: "add b", files: ["b.txt"], confirmed: true });
    expect(r.exitCode).toBe(0);
    expect(gitShowFiles(dir).sort()).toEqual(["a.txt", "b.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("未跟踪文件标记为 untracked", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "new.txt"), "n\n", "utf8");
    const entries = await gitStatusEntries(dir);
    expect(entries.find((e) => e.path === "new.txt")).toMatchObject({ x: "?", y: "?", untracked: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("rename 只取新路径(porcelain -z 双路径格式)", async () => {
    const dir = makeRepo();
    spawnSync("git", ["mv", "a.txt", "renamed.txt"], { cwd: dir, windowsHide: true });
    const entries = await gitStatusEntries(dir);
    expect(entries.map((e) => e.path)).toContain("renamed.txt");
    expect(entries.some((e) => e.path === "a.txt")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("空 files 抛错且不改变状态", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a2\n", "utf8");
    await expect(gitCommit({ workspace: dir, message: "x", files: [], confirmed: true })).rejects.toThrow("未选择提交文件");
    await expect(gitCommit({ workspace: dir, message: "x", confirmed: true })).rejects.toThrow("未选择提交文件");
    expect(gitLog(dir)).toBe("init");
    rmSync(dir, { recursive: true, force: true });
  });

  it("未 confirmed 抛 needsConfirm", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a2\n", "utf8");
    await expect(gitCommit({ workspace: dir, message: "x", files: ["a.txt"] })).rejects.toMatchObject({
      needsConfirm: true,
    });
    expect(gitLog(dir)).toBe("init");
    rmSync(dir, { recursive: true, force: true });
  });

  it("取消提交后 Git 状态保持不变", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a2\n", "utf8");
    writeFileSync(join(dir, "new.txt"), "n\n", "utf8");
    const before = gitStatus(dir);
    // 取消 = 前端不发起提交;这里验证未确认路径不会写任何东西
    await expect(gitCommit({ workspace: dir, message: "x", files: ["a.txt"] })).rejects.toMatchObject({
      needsConfirm: true,
    });
    expect(gitStatus(dir)).toBe(before);
    expect(gitLog(dir)).toBe("init");
    rmSync(dir, { recursive: true, force: true });
  });

  it("路径含 ../ 或绝对路径抛错", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a2\n", "utf8");
    await expect(gitCommit({ workspace: dir, message: "x", files: ["../evil.txt"], confirmed: true })).rejects.toThrow(
      "工作区相对路径",
    );
    await expect(gitCommit({ workspace: dir, message: "x", files: ["/etc/passwd"], confirmed: true })).rejects.toThrow(
      "工作区相对路径",
    );
    await expect(gitCommit({ workspace: dir, message: "x", files: ["C:/evil.txt"], confirmed: true })).rejects.toThrow(
      "工作区相对路径",
    );
    expect(gitLog(dir)).toBe("init");
    rmSync(dir, { recursive: true, force: true });
  });

  it("提交失败(路径不存在)不产生提交且不改暂存区", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a2\n", "utf8");
    await expect(
      gitCommit({ workspace: dir, message: "x", files: ["a.txt", "missing.txt"], confirmed: true }),
    ).rejects.toThrow("git add 失败");
    expect(gitLog(dir)).toBe("init");
    // git add 在 pathspec 失败时是原子的:a.txt 不应被暂存
    const entries = await gitStatusEntries(dir);
    expect(entries.find((e) => e.path === "a.txt")).toMatchObject({ staged: false, unstaged: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("空提交(无可提交内容)由 git 返回非零退出码", async () => {
    const dir = makeRepo();
    const r = await gitCommit({ workspace: dir, message: "empty", files: ["a.txt"], confirmed: true });
    expect(r.exitCode).not.toBe(0);
    expect(gitLog(dir)).toBe("init");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---- 阶段 3:/tools/git/diff 错误处理 ----

// tools.test.ts 原本只测纯函数,这里按 app.data.test.ts 的方式构造 app
function setup() {
  const db = openDb(":memory:");
  return { app: createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-data-")))), db };
}

describe("/tools/git/diff", () => {
  it("git diff 在非 git 目录返回 400 而非 500", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xiyun-nogit-"));
    const { app } = setup();
    const res = await app.request("/tools/git/diff", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: dir }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
    rmSync(dir, { recursive: true, force: true });
  });
});
