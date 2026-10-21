import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter, toList, toText } from "./frontmatter.ts";

// 工作区边界:所有文件访问必须落在 workspace 目录内。
export function assertInside(workspace: string, target: string): string {
  const w = resolve(workspace);
  const t = resolve(workspace, target);
  if (t !== w && !t.startsWith(w + sep)) throw new Error(`path outside workspace: ${target}`);
  return t;
}

// ---- 规则层(决策 D-004 第一层;D-019 扩展兼容生态格式)----
// 顺序 = 优先级从低到高:全局 -> 模式 -> 用户级(仅 Code) -> 项目根 -> 按需规则(.mdc / applyTo)
// -> 目录级 AGENTS.md / CLAUDE.md(由浅到深) -> CLAUDE.local.md。后出现的规则优先级更高。

const ROOT_RULE_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".github/copilot-instructions.md"];
const NESTED_RULE_FILES = ["AGENTS.md", "CLAUDE.md"];
// 带 frontmatter 的按需规则目录:Cursor(globs / alwaysApply)与 Copilot(applyTo)
const SCOPED_RULE_DIRS = [
  { dir: ".cursor/rules", ext: ".mdc" },
  { dir: ".github/instructions", ext: ".instructions.md" },
];
const MAX_SCOPED_FILES = 50;
const MAX_IMPORT_DEPTH = 5;
const FILE_CAP = 20_000; // 单个规则文件字符上限
const TOTAL_CAP = 60_000; // 规则层总字符上限
const MAX_READ_BYTES = 1_000_000;

export type RuleOptions = {
  dataDir?: string;
  mode?: string;
  homeDir?: string; // 提供且 mode === "code" 时加载 ~/.claude/CLAUDE.md
  files?: string[]; // 本轮引用的文件(工作区相对或绝对路径),用于匹配 globs 与目录级规则
};

// glob -> 正则:支持 **、*、?、{a,b};不含 "/" 的模式按任意目录匹配(*.ts 等价 **/*.ts)
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
  if (g.endsWith("/")) g += "**";
  if (!g.includes("/")) g = `**/${g}`;
  let re = "";
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      depth++;
      re += "(?:";
    } else if (ch === "}" && depth > 0) {
      depth--;
      re += ")";
    } else if (ch === "," && depth > 0) re += "|";
    else re += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const matchGlob = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

// 软链接可能指向工作区外:按真实路径再判一次
function realInside(root: string, p: string): boolean {
  try {
    const r = realpathSync(root);
    const t = realpathSync(p);
    return t === r || t.startsWith(r + sep);
  } catch {
    return false;
  }
}

function readText(p: string): string | null {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

const cap = (text: string, limit = FILE_CAP): string =>
  text.length > limit ? `${text.slice(0, limit)}\n...(已截断,原文 ${text.length} 字)` : text;

const toPosix = (p: string): string => p.split(sep).join("/");

// 剔除代码块与行内代码后,找出 @path 引用(Claude Code 的导入语法)
export function findImports(text: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const plain = line.replace(/`[^`]*`/g, " ");
    for (const m of plain.matchAll(/(?:^|[\s(\[])@((?:~\/|\.{1,2}\/)?[A-Za-z0-9_.\-/~]+)/g)) {
      const p = m[1]!.replace(/[.,;:!?)\]}'"]+$/, "");
      if (p && /[A-Za-z0-9]/.test(p) && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

type Ctx = { homeDir?: string; seenFiles: Set<string>; seenHashes: Set<string> };

// 展开 @导入:相对引用按所在文件目录解析,~/ 按 homeDir 解析;解析结果必须仍在 root 内。
function expandImports(text: string, file: string, root: string, ctx: Ctx, depth: number): string {
  if (depth >= MAX_IMPORT_DEPTH) return "";
  const parts: string[] = [];
  for (const ref of findImports(text)) {
    let target: string;
    if (ref.startsWith("~/")) {
      if (!ctx.homeDir) continue;
      target = resolve(ctx.homeDir, ref.slice(2));
    } else target = resolve(dirname(file), ref);
    if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) continue; // 越界导入一律忽略
    if (ctx.seenFiles.has(target) || !realInside(root, target)) continue;
    const content = readText(target);
    if (content === null) continue;
    ctx.seenFiles.add(target);
    const nested = expandImports(content, target, root, ctx, depth + 1);
    parts.push(`### 导入:${toPosix(relative(root, target)) || ref}\n${cap(content.trim())}${nested ? `\n\n${nested}` : ""}`);
  }
  return parts.join("\n\n");
}

type Part = { title: string; text: string };

function walkScoped(root: string, dir: string, ext: string, out: string[], depth = 0): void {
  if (depth > 4 || out.length >= MAX_SCOPED_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_SCOPED_FILES) return;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkScoped(root, p, ext, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
  }
}

export function loadRuleFiles(workspace: string, opts: RuleOptions = {}): string {
  const root = resolve(workspace);
  const ctx: Ctx = { homeDir: opts.homeDir, seenFiles: new Set(), seenHashes: new Set() };
  const parts: Part[] = [];
  const index: string[] = []; // 未自动加载、可按需读取的规则

  // 读取一个规则文件:去重(同一路径 / 同样内容只注入一次)+ 展开 @导入 + 单文件截断
  const add = (title: string, file: string, fileRoot: string, transform?: (t: string) => string | null) => {
    const abs = resolve(file);
    if (ctx.seenFiles.has(abs) || !existsSync(abs) || !realInside(fileRoot, abs)) return;
    const raw = readText(abs);
    if (raw === null) return;
    const text = transform ? transform(raw) : raw;
    if (text === null || !text.trim()) return;
    const hash = createHash("sha1").update(text.trim()).digest("hex");
    ctx.seenFiles.add(abs);
    if (ctx.seenHashes.has(hash)) return;
    ctx.seenHashes.add(hash);
    const imports = expandImports(text, abs, fileRoot, ctx, 0);
    parts.push({ title, text: `${cap(text.trim())}${imports ? `\n\n${imports}` : ""}` });
  };

  if (opts.dataDir) {
    add("全局规则", join(opts.dataDir, "rules", "global.md"), opts.dataDir);
    if (opts.mode) add(`模式规则(${opts.mode})`, join(opts.dataDir, "rules", `${opts.mode}.md`), opts.dataDir);
  }
  if (opts.homeDir && opts.mode === "code") add("用户规则(~/.claude/CLAUDE.md)", join(opts.homeDir, ".claude", "CLAUDE.md"), opts.homeDir);

  for (const name of ROOT_RULE_FILES) add(name, assertInside(root, name), root);

  // 引用文件统一成工作区相对的 posix 路径;越界的直接丢弃
  const files: string[] = [];
  for (const f of opts.files ?? []) {
    if (typeof f !== "string" || !f.trim()) continue;
    const abs = isAbsolute(f) ? resolve(f) : resolve(root, f);
    if (!abs.startsWith(root + sep)) continue;
    const rel = toPosix(relative(root, abs));
    if (!files.includes(rel)) files.push(rel);
  }

  for (const { dir, ext } of SCOPED_RULE_DIRS) {
    const found: string[] = [];
    walkScoped(root, join(root, dir), ext, found);
    for (const file of found) {
      const rel = toPosix(relative(root, file));
      add(rel, file, root, (raw) => {
        const { data, body } = parseFrontmatter(raw);
        const globs = [...toList(data.globs), ...toList(data.applyTo)];
        const always = data.alwaysApply === true || globs.some((g) => g === "**" || g === "**/*");
        const hit = always ? null : globs.find((g) => files.some((f) => matchGlob(g, f)));
        if (always) return body;
        if (hit) return `(匹配 ${hit})\n${body}`;
        const desc = toText(data.description);
        if (desc) index.push(`- ${rel}:${desc}`);
        return null;
      });
    }
  }

  // 目录级规则:引用文件所在目录到工作区根之间的每一层(不含根),由浅到深
  const dirs: string[] = [];
  for (const f of files) {
    const segs = f.split("/").slice(0, -1);
    for (let i = 1; i <= segs.length; i++) {
      const d = segs.slice(0, i).join("/");
      if (!dirs.includes(d)) dirs.push(d);
    }
  }
  dirs.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const d of dirs) for (const name of NESTED_RULE_FILES) add(`${d}/${name}`, join(root, d, name), root);

  add("CLAUDE.local.md", join(root, "CLAUDE.local.md"), root);

  if (index.length) parts.push({ title: "按需规则(未自动加载,相关时用工具读取)", text: index.join("\n") });

  // 总量上限:超出时保留靠前的部分并说明被省略的文件
  const out: string[] = [];
  const dropped: string[] = [];
  let total = 0;
  for (const p of parts) {
    const block = `## ${p.title}\n${p.text}`;
    if (total + block.length > TOTAL_CAP) {
      dropped.push(p.title);
      continue;
    }
    out.push(block);
    total += block.length + 2;
  }
  if (dropped.length) out.push(`(规则总长度超过 ${TOTAL_CAP} 字,已省略:${dropped.join("、")})`);
  return out.join("\n\n");
}
