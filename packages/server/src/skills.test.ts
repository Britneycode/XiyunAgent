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

describe("SKILL.md 格式兼容(D-019)", () => {
  it("只有 SKILL.md 时从 frontmatter 合成 manifest,正文注入时去掉 frontmatter", () => {
    const { store, cleanup } = setup();
    const src = join(mkdtempSync(join(tmpdir(), "xiyun-skill-src-")), "pdf-tools");
    mkdirSync(join(src, "scripts"), { recursive: true });
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: PDF Processing\ndescription: Extract text and tables from PDF files\nmetadata:\n  author: x\n---\n# PDF\n按页提取。",
    );
    writeFileSync(join(src, "scripts", "extract.py"), "print(1)");
    writeFileSync(join(src, "reference.md"), "参考");
    const s = store.import(src);
    expect(s).toMatchObject({ id: "pdf-processing", name: "PDF Processing", version: 1, description: "Extract text and tables from PDF files" });
    expect(s.warnings).toEqual(["包含非文档文件:scripts/extract.py"]); // 递归检查子目录
    store.setEnabled(s.id, true);
    const prompt = store.promptFor("chat");
    expect(prompt).toContain("## Skill:PDF Processing(v1)\n# PDF\n按页提取。");
    expect(prompt).not.toContain("description:");
    cleanup();
  });

  it("中文名无法生成 id 时回退到目录名", () => {
    const { store, cleanup } = setup();
    const src = join(mkdtempSync(join(tmpdir(), "xiyun-skill-src-")), "req-analysis");
    mkdirSync(src);
    writeFileSync(join(src, "SKILL.md"), "---\nname: 需求分析\n---\n正文");
    expect(store.import(src)).toMatchObject({ id: "req-analysis", name: "需求分析" });
    cleanup();
  });

  it("启用的 Skill 超出预算时:索引 + 相关 Skill 全文", () => {
    const { store, cleanup } = setup();
    const root = mkdtempSync(join(tmpdir(), "xiyun-skill-src-"));
    const defs = [
      ["weekly-report", "周报生成", "根据本周任务生成周报"],
      ["sql-review", "SQL Review", "review sql migration scripts for safety"],
      ["meeting-notes", "会议纪要", "整理会议录音和纪要"],
    ];
    for (const [id, name, desc] of defs) {
      const dir = join(root, id!);
      mkdirSync(dir);
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n${name}正文 ` + "x".repeat(5000));
      store.setEnabled(store.import(dir).id, true);
    }
    const idx = store.promptFor("chat", "main", "今天天气");
    expect(idx).toContain("- 周报生成(weekly-report):根据本周任务生成周报");
    expect(idx).toContain("- SQL Review(sql-review):");
    expect(idx).not.toContain("周报生成正文"); // 无关:只给索引
    const zh = store.promptFor("chat", "main", "帮我写一份本周的周报");
    expect(zh).toContain("周报生成正文");
    expect(zh).not.toContain("会议纪要正文");
    const en = store.promptFor("chat", "main", "please review this migration");
    expect(en).toContain("SQL Review正文");
    const named = store.promptFor("chat", "main", "用 meeting-notes 处理");
    expect(named).toContain("会议纪要正文");
    cleanup();
  });
});
