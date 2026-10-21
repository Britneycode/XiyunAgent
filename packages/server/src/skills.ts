import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { SkillInfo, SkillManifest } from "@xiyun/shared";
import { parseFrontmatter, toList, toText } from "./frontmatter.ts";

// ---- 阶段 6:Skill 系统 ----
// Skill = 声明式目录:skill.json + SKILL.md。导入不自动启用;启用后才注入提示词。
// ZIP 用系统 tar 解压(Windows 10+ 自带),不引入新依赖。
// 可执行插件沙箱未实现:memoryScopes 等权限字段当前只做校验、展示和存储。
// D-019:兼容只有 SKILL.md(YAML frontmatter 写 name / description)的社区 Skill,
// 导入时从 frontmatter 合成 manifest;启用的 Skill 过多时改为"索引 + 相关 Skill 全文"的渐进注入。

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

const slug = (v: string): string =>
  v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");

// 没有 skill.json 时,从 SKILL.md 的 frontmatter 合成 manifest(Anthropic / 社区 Skill 格式)。
// id 依次尝试 slug(name)、slug(目录名),都不合法(如纯中文名)时用名称哈希。
export function manifestFromSkillMd(text: string, fallbackName: string): SkillManifest {
  const { data } = parseFrontmatter(text);
  const name = toText(data.name) || fallbackName.trim() || "skill";
  const id =
    [slug(toText(data.name)), slug(fallbackName)].find((v) => ID_RE.test(v)) ??
    `skill-${createHash("sha1").update(name).digest("hex").slice(0, 8)}`;
  const version = Number.parseInt(toText(data.version), 10);
  return validateManifest({
    id, name, version: Number.isFinite(version) && version >= 1 ? version : 1,
    description: toText(data.description),
    modes: toList(data.modes), roles: toList(data.roles), memoryScopes: [],
  });
}

const stripFrontmatter = (text: string): string => parseFrontmatter(text).body.trim();

// 渐进注入的相关性:显式提到名称 / id 直接命中;否则按 ASCII 词(≥3 字符)与中文二元组的重合数打分
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "use", "when", "you", "your"]);
function terms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) if (!STOP.has(w)) out.add(w);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? [])
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  return out;
}

export function skillRelevance(query: string, skill: { id: string; name: string; description?: string }): number {
  const q = query.toLowerCase();
  if (!q.trim()) return 0;
  if (q.includes(skill.id.toLowerCase()) || (skill.name.length >= 2 && q.includes(skill.name.toLowerCase()))) return 100;
  const target = terms(`${skill.name} ${skill.id.replace(/-/g, " ")} ${skill.description ?? ""}`);
  let score = 0;
  for (const t of terms(query)) if (target.has(t)) score++;
  return score;
}

const BODY_CAP = 8000; // 单个 Skill 正文上限
const INLINE_BUDGET = 12_000; // 全部正文不超过该值时全量注入,否则渐进注入
const MIN_SCORE = 2;

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
  // 递归检查子目录(社区 Skill 常带 scripts/、references/),最多 4 层、200 个条目。
  private inspect(dir: string): string[] {
    const warnings: string[] = [];
    let seen = 0;
    const walk = (d: string, depth: number) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        if (++seen > 200) {
          if (seen === 201) warnings.push("文件过多,仅检查前 200 个");
          return;
        }
        const p = join(d, f.name);
        const rel = relative(dir, p).split("\\").join("/");
        if (f.isDirectory()) {
          if (depth < 4) walk(p, depth + 1);
          continue;
        }
        if (rel === "skill.json" || rel === "SKILL.md") continue;
        if (!SAFE_FILE_RE.test(f.name)) warnings.push(`包含非文档文件:${rel}`);
      }
    };
    walk(dir, 0);
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
      // 兼容 ZIP 内多套一层目录的情况(忽略 macOS 打包的 __MACOSX 与隐藏目录)
      const atRoot = existsSync(join(extracted, "skill.json")) || existsSync(join(extracted, "SKILL.md"));
      const inner = readdirSync(extracted).find(
        (n) => n !== "__MACOSX" && !n.startsWith(".") && statSync(join(extracted, n)).isDirectory(),
      );
      dir = atRoot || !inner ? extracted : join(extracted, inner);
    }
    try {
      if (!existsSync(join(dir, "SKILL.md"))) throw new Error("缺少 SKILL.md");
      // 有 skill.json 用它;只有 SKILL.md 时从 frontmatter 合成(名称兜底:目录名 / ZIP 文件名)
      const skillMd = readFileSync(join(dir, "SKILL.md"), "utf8");
      const fallbackName = dir === extracted ? basename(src).replace(/\.zip$/i, "") : basename(dir);
      const manifest = existsSync(join(dir, "skill.json"))
        ? validateManifest(JSON.parse(readFileSync(join(dir, "skill.json"), "utf8")))
        : manifestFromSkillMd(skillMd, fallbackName);
      if (!manifest.description) manifest.description = toText(parseFrontmatter(skillMd).data.description);
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
  // 正文(去掉 frontmatter)总长不超过 INLINE_BUDGET 时全部注入;否则渐进注入:
  // 先给出全部 Skill 的"名称:描述"索引,再只附上与 query 相关的 Skill 全文(按相关度,受预算限制)。
  promptFor(mode: string, role = "main", query = ""): string {
    const items: Array<{ s: SkillInfo; body: string }> = [];
    for (const s of this.list()) {
      if (!s.enabled) continue;
      if (s.modes.length > 0 && !s.modes.includes(mode)) continue;
      if (s.roles.length > 0 && !s.roles.includes(role)) continue;
      const file = join(s.path, "SKILL.md");
      if (existsSync(file)) items.push({ s, body: stripFrontmatter(readFileSync(file, "utf8")).slice(0, BODY_CAP) });
    }
    const full = (it: { s: SkillInfo; body: string }) => `## Skill:${it.s.name}(v${it.s.version})\n${it.body}`;
    const all = items.map(full);
    if (all.join("\n\n").length <= INLINE_BUDGET) return all.join("\n\n");

    const index = [
      "以下 Skill 已启用。与当前任务相关的已附完整说明;其余只列名称和用途,若某个明显适用,可提示用户在消息中点名该 Skill 以加载完整说明。",
      ...items.map((it) => `- ${it.s.name}(${it.s.id}):${(it.s.description || it.body.split("\n")[0] || "").slice(0, 200)}`),
    ].join("\n");
    let budget = INLINE_BUDGET - index.length;
    const picked: string[] = [];
    const ranked = items
      .map((it) => ({ it, score: skillRelevance(query, it.s) }))
      .filter((x) => x.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score);
    for (const { it } of ranked) {
      const block = full(it);
      if (block.length > budget) continue;
      picked.push(block);
      budget -= block.length + 2;
    }
    return [index, ...picked].join("\n\n");
  }
}
