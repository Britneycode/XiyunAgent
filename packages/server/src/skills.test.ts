import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillStore, validateManifest } from "./skills.ts";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, description TEXT NOT NULL DEFAULT '', modes TEXT NOT NULL DEFAULT '[]', roles TEXT NOT NULL DEFAULT '[]', memory_scopes TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL, warnings TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
  `);
  const dataDir = mkdtempSync(join(tmpdir(), "xiyun-skill-"));
  return { store: new SkillStore(db, dataDir), cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

function makeSkill(dir: string, manifest: Record<string, unknown>, body = "按模板输出。") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "SKILL.md"), body);
}

describe("validateManifest", () => {
  it("校验 id/name/version", () => {
    expect(validateManifest({ id: "req-analysis", name: "需求分析", version: 1 }).id).toBe("req-analysis");
    expect(() => validateManifest({ id: "Bad ID", name: "x", version: 1 })).toThrow("无效 skill id");
    expect(() => validateManifest({ id: "ok", name: "", version: 1 })).toThrow("缺少 name");
    expect(() => validateManifest({ id: "ok", name: "x", version: 0 })).toThrow("version");
  });
});

describe("SkillStore", () => {
  it("导入不自动启用;启用后注入,禁用后立即不再注入", () => {
    const { store, cleanup } = setup();
    const src = mkdtempSync(join(tmpdir(), "xiyun-skill-src-"));
    makeSkill(src, { id: "s1", name: "S1", version: 1 });
    const s = store.import(src);
    expect(s.enabled).toBe(false);
    expect(store.promptFor("chat")).toBe(""); // 未启用不注入
    store.setEnabled("s1", true);
    expect(store.promptFor("chat")).toContain("按模板输出");
    store.setEnabled("s1", false);
    expect(store.promptFor("chat")).toBe(""); // 禁用立即生效
    cleanup();
    rmSync(src, { recursive: true, force: true });
  });

  it("模式与角色限制", () => {
    const { store, cleanup } = setup();
    const src = mkdtempSync(join(tmpdir(), "xiyun-skill-src-"));
    makeSkill(src, { id: "s2", name: "S2", version: 1, modes: ["work"], roles: ["researcher"] });
    store.import(src);
    store.setEnabled("s2", true);
    expect(store.promptFor("work", "researcher")).toContain("按模板输出");
    expect(store.promptFor("chat", "researcher")).toBe(""); // 模式不匹配
    expect(store.promptFor("work", "coder")).toBe(""); // 角色不匹配
    expect(store.promptFor("work")).toBe(""); // main 不在 roles 内
    cleanup();
    rmSync(src, { recursive: true, force: true });
  });

  it("升级(同 id 重导入)保留启用状态;非文档文件进 warnings", () => {
    const { store, cleanup } = setup();
    const src = mkdtempSync(join(tmpdir(), "xiyun-skill-src-"));
    makeSkill(src, { id: "s3", name: "S3", version: 1 }, "v1 内容");
    writeFileSync(join(src, "run.exe"), "x"); // 静态检查应捕获
    store.import(src);
    store.setEnabled("s3", true);
    expect(store.get("s3")!.warnings[0]).toContain("run.exe");
    makeSkill(src, { id: "s3", name: "S3", version: 2 }, "v2 内容");
    const up = store.import(src);
    expect(up.version).toBe(2);
    expect(up.enabled).toBe(true); // 升级不覆盖用户启用状态
    expect(store.promptFor("chat")).toContain("v2 内容");
    cleanup();
    rmSync(src, { recursive: true, force: true });
  });

  it("缺 SKILL.md 拒绝导入", () => {
    const { store, cleanup } = setup();
    const src = mkdtempSync(join(tmpdir(), "xiyun-skill-src-"));
    writeFileSync(join(src, "skill.json"), JSON.stringify({ id: "bad", name: "B", version: 1 }));
    expect(() => store.import(src)).toThrow("SKILL.md");
    cleanup();
    rmSync(src, { recursive: true, force: true });
  });
});
