import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { SkillInfo, SkillManifest } from "@xiyun/shared";

// ---- 阶段 6:Skill 系统 ----
// Skill = 声明式目录:skill.json + SKILL.md。导入不自动启用;启用后才注入提示词。
// ZIP 用系统 tar 解压(Windows 10+ 自带),不引入新依赖。
// 可执行插件沙箱未实现:memoryScopes 等权限字段当前只做校验、展示和存储。

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// 声明式 Skill 只允许文档类文件;出现可执行文件记入 warnings(不阻止导入,启用前用户可见)。
const SAFE_FILE_RE = /\.(md|txt|json|yaml|yml|csv)$/i;

export function validateManifest(raw: unknown): SkillManifest {
  const m = raw as Partial<SkillManifest>;
  if (!m || typeof m !== "object") throw new Error("skill.json 不是有效 JSON 对象");
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) throw new Error(`无效 skill id:${String(m.id)}`);
  if (typeof m.name !== "string" || !m.name.trim()) throw new Error("缺少 name");
  if (typeof m.version !== "number" || m.version < 1) throw new Error("version 必须是 ≥1 的数字");
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return {
    id: m.id, name: m.name.trim(), version: m.version,
    description: typeof m.description === "string" ? m.description : "",
    modes: strArr(m.modes), roles: strArr(m.roles), memoryScopes: strArr(m.memoryScopes),
  };
}

type SkillRow = {
  id: string; name: string; version: number; description: string; modes: string; roles: string;
  memory_scopes: string; enabled: number; path: string; warnings: string; created_at: string;
};

const toSkill = (r: SkillRow): SkillInfo => ({
  id: r.id, name: r.name, version: r.version, description: r.description,
  modes: JSON.parse(r.modes), roles: JSON.parse(r.roles), memoryScopes: JSON.parse(r.memory_scopes),
  enabled: r.enabled === 1, path: r.path, warnings: JSON.parse(r.warnings), createdAt: r.created_at,
});

export class SkillStore {
  private db: DatabaseSync;
  private root: string; // data/skills/
  constructor(db: DatabaseSync, dataDir: string) {
    this.db = db;
    this.root = join(dataDir, "skills");
    mkdirSync(this.root, { recursive: true });
  }

  list(): SkillInfo[] {
    return (this.db.prepare("SELECT * FROM skills ORDER BY created_at").all() as SkillRow[]).map(toSkill);
  }

  get(id: string): SkillInfo | undefined {
    const r = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
    return r ? toSkill(r) : undefined;
  }

  // 静态检查:返回 warnings(不阻断导入)。
  private inspect(dir: string): string[] {
    const warnings: string[] = [];
    for (const f of readdirSync(dir)) {
      if (f === "skill.json" || f === "SKILL.md") continue;
      if (!SAFE_FILE_RE.test(f)) warnings.push(`包含非文档文件:${f}`);
    }
    return warnings;
  }

  // 导入目录或 ZIP;同 id 重新导入 = 升级,保留启用状态(不覆盖用户配置)。
  import(sourcePath: string): SkillInfo {
    const src = resolve(sourcePath);
    if (!existsSync(src)) throw new Error(`路径不存在:${sourcePath}`);
    let dir = src;
    let extracted = "";
    if (/\.zip$/i.test(src)) {
      // ZIP:先解压到临时目录再校验,找不到 manifest 就清理。
      // win32 优先用 System32 的 bsdtar;PATH 上的 GNU tar 会把 D:/... 当远程主机
      // (Cannot connect to D: resolve failed),退化时加 --force-local。
      const SYS_TAR = "C:/Windows/System32/tar.exe";
      const tar = process.platform === "win32" && existsSync(SYS_TAR) ? SYS_TAR : "tar";
      extracted = join(this.root, `.tmp-${randomUUID()}`);
      mkdirSync(extracted, { recursive: true });
      const args = tar === "tar" ? ["--force-local", "-xf", src, "-C", extracted] : ["-xf", src, "-C", extracted];
      const r = spawnSync(tar, args, { stdio: "pipe" });
      if (r.status !== 0) {
        rmSync(extracted, { recursive: true, force: true });
        throw new Error(`ZIP 解压失败:${r.stderr?.toString().slice(0, 200) || "tar error"}`);
      }
      // 兼容 ZIP 内多套一层目录的情况
      dir = existsSync(join(extracted, "skill.json"))
        ? extracted
        : join(extracted, readdirSync(extracted)[0] ?? "");
    }
    try {
      if (!existsSync(join(dir, "SKILL.md"))) throw new Error("缺少 SKILL.md");
      const manifest = validateManifest(JSON.parse(readFileSync(join(dir, "skill.json"), "utf8")));
      const dest = join(this.root, manifest.id);
      const existing = this.get(manifest.id);
      rmSync(dest, { recursive: true, force: true });
      cpSync(dir, dest, { recursive: true });
      const warnings = this.inspect(dest);
      const enabled = existing?.enabled ? 1 : 0; // 升级保留启用状态
      this.db
        .prepare(
          `INSERT INTO skills (id, name, version, description, modes, roles, memory_scopes, enabled, path, warnings, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, description=excluded.description,
             modes=excluded.modes, roles=excluded.roles, memory_scopes=excluded.memory_scopes,
             path=excluded.path, warnings=excluded.warnings`,
        )
        .run(
          manifest.id, manifest.name, manifest.version, manifest.description ?? "",
          JSON.stringify(manifest.modes), JSON.stringify(manifest.roles), JSON.stringify(manifest.memoryScopes),
          enabled, dest, JSON.stringify(warnings), new Date().toISOString(),
        );
      return this.get(manifest.id)!;
    } finally {
      if (extracted) rmSync(extracted, { recursive: true, force: true });
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE skills SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  remove(id: string): void {
    const s = this.get(id);
    this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    if (s && s.path.startsWith(this.root)) rmSync(s.path, { recursive: true, force: true });
  }

  // 匹配:启用 + 模式匹配(modes 空 = 全模式)+ 角色匹配(roles 空 = 所有角色,含主对话 "main")。
  // 返回拼接的 SKILL.md 正文,注入 system prompt。
  promptFor(mode: string, role = "main"): string {
    const parts: string[] = [];
    for (const s of this.list()) {
      if (!s.enabled) continue;
      if (s.modes.length > 0 && !s.modes.includes(mode)) continue;
      if (s.roles.length > 0 && !s.roles.includes(role)) continue;
      const file = join(s.path, "SKILL.md");
      if (existsSync(file))
        parts.push(`## Skill:${s.name}(v${s.version})\n${readFileSync(file, "utf8").slice(0, 8000)}`);
    }
    return parts.join("\n\n");
  }
}
