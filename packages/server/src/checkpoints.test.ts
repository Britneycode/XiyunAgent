import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { CheckpointStore } from "./checkpoints.ts";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

const mkStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "xiyun-cp-"));
  const ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  return { dir, ws, store: new CheckpointStore({ dataDir: dir, skipGuards: true }) };
};

describe.skipIf(!gitAvailable)("CheckpointStore", () => {
  it("相同内容只生成一个快照", async () => {
    const { dir, ws, store } = mkStore();
    writeFileSync(join(ws, "a.txt"), "v1");
    const a = await store.snapshot(ws, "first");
    expect(a).toBeTruthy();
    const b = await store.snapshot(ws, "again");
    expect(b?.sha).toBe(a!.sha);
    expect(b?.reused).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("bash 生成的文件也能回退", async () => {
    const { dir, ws, store } = mkStore();
    writeFileSync(join(ws, "a.txt"), "v1");
    const snap = await store.snapshot(ws, "before");
    writeFileSync(join(ws, "b.txt"), "created by tool");
    expect(existsSync(join(ws, "b.txt"))).toBe(true);
    expect(await store.restore(ws, snap!.sha)).toBe(true);
    expect(existsSync(join(ws, "b.txt"))).toBe(false);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v1");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("回退后修改过的文件恢复原内容", async () => {
    const { dir, ws, store } = mkStore();
    writeFileSync(join(ws, "a.txt"), "original");
    const snap = await store.snapshot(ws, "before");
    writeFileSync(join(ws, "a.txt"), "modified");
    await store.restore(ws, snap!.sha);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("original");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("被忽略的目录不受影响", async () => {
    const { dir, ws, store } = mkStore();
    mkdirSync(join(ws, "node_modules"), { recursive: true });
    writeFileSync(join(ws, "node_modules", "dep.js"), "dep");
    writeFileSync(join(ws, "a.txt"), "v1");
    const snap = await store.snapshot(ws, "before");
    writeFileSync(join(ws, "node_modules", "dep.js"), "changed");
    await store.restore(ws, snap!.sha);
    // node_modules 不在快照里,回退不会删它
    expect(existsSync(join(ws, "node_modules", "dep.js"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("用户自己的 .git 不受影响", async () => {
    const { dir, ws, store } = mkStore();
    spawnSync("git", ["init", "--quiet"], { cwd: ws });
    writeFileSync(join(ws, "a.txt"), "v1");
    spawnSync("git", ["add", "-A"], { cwd: ws });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: ws });
    const before = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ws }).stdout.toString().trim();

    await store.snapshot(ws, "snap");
    // 快照本身不应改动用户仓库的 HEAD,也不应把文件写进用户索引
    expect(spawnSync("git", ["rev-parse", "HEAD"], { cwd: ws }).stdout.toString().trim()).toBe(before);
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: ws }).stdout.toString().trim()).toBe("");

    // 之后用户自己改文件,工作区脏是用户改的,与快照无关
    writeFileSync(join(ws, "a.txt"), "v2");
    await store.snapshot(ws, "snap2");
    expect(spawnSync("git", ["rev-parse", "HEAD"], { cwd: ws }).stdout.toString().trim()).toBe(before);
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: ws }).stdout.toString().trim()).toBe("M a.txt");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("撤销回退:先拍 pre-rewind 快照再还原", async () => {
    const { dir, ws, store } = mkStore();
    writeFileSync(join(ws, "a.txt"), "v1");
    const snap = await store.snapshot(ws, "before");
    writeFileSync(join(ws, "a.txt"), "v2");
    // 回退前拍一个 undo 快照
    const undo = await store.snapshot(ws, "pre-rewind");
    await store.restore(ws, snap!.sha);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v1");
    // 撤销回退
    await store.restore(ws, undo!.sha);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v2");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("diffFiles 列出改动", async () => {
    const { dir, ws, store } = mkStore();
    writeFileSync(join(ws, "a.txt"), "v1");
    const snap = await store.snapshot(ws, "before");
    writeFileSync(join(ws, "a.txt"), "v2");
    writeFileSync(join(ws, "b.txt"), "new");
    const files = await store.diffFiles(ws, snap!.sha);
    expect(files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("工作区是根目录或 home 时关闭快照", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xiyun-cp-"));
    const store = new CheckpointStore({ dataDir: dir });
    // 不传 skipGuards:home 目录应被拒绝
    const reason = await store.ensure(process.env.USERPROFILE ?? process.env.HOME ?? "/");
    expect(reason).toBeTruthy();
    expect(await store.snapshot(process.env.USERPROFILE ?? process.env.HOME ?? "/", "x")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
