import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCommand } from "./tools.ts";

// ---- 工具权限(F7 / B1,D-024)----
// 规则与 Claude Code 的 settings.json 兼容:{ "permissions": { "allow": [...], "ask": [...], "deny": [...] } }。
// 读取顺序:~/.claude/settings.json、~/.xiyun/settings.json、<ws>/.claude/settings.json、
// <ws>/.claude/settings.local.json、<ws>/.xiyun/settings.json;各文件的规则合并。
// 判定:deny > ask > allow > 内置默认(读类允许、写类询问、bash 按 classifyCommand、MCP 询问)。
// 规则写法:
//   Bash               所有命令
//   Bash(npm run *)    通配(* 匹配任意字符;末尾的 " *" 也匹配不带参数的命令本身)
//   Bash(npm test:*)   前缀(Claude Code 旧写法)
//   Read / Edit / Write(src/**)   工作区相对路径的 glob(** 跨目录,* 不跨 /);Edit 同时覆盖 Write
//   mcp__github / mcp__github__* / mcp__github__create_issue

export type Decision = "allow" | "ask" | "deny";

export interface PermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

// 工具在权限规则里的名字
export type PermKind = "Bash" | "Read" | "Edit" | "Write" | "Mcp";

export interface PermRequest {
  kind: PermKind;
  tool: string; // 原始工具名(MCP 为 mcp__server__tool)
  command?: string; // Bash
  path?: string; // Read / Edit / Write:工作区相对路径
}

export interface PermVerdict {
  decision: Decision;
  reason: string;
  rule?: string; // 命中的规则
}

export const PROJECT_SETTINGS = ".xiyun/settings.json";

function readRules(file: string): PermissionRules {
  const out: PermissionRules = { allow: [], ask: [], deny: [] };
  try {
    if (!existsSync(file)) return out;
    const j = JSON.parse(readFileSync(file, "utf8")) as { permissions?: Record<string, unknown> };
    const p = j?.permissions ?? {};
    for (const k of ["allow", "ask", "deny"] as const) {
      const v = p[k];
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
    }
  } catch {
    // 格式错误的设置文件忽略,不影响其他来源
  }
  return out;
}

export function loadPermissions(workspace: string, o: { homeDir?: string } = {}): PermissionRules {
  const files = [
    ...(o.homeDir ? [join(o.homeDir, ".claude", "settings.json"), join(o.homeDir, ".xiyun", "settings.json")] : []),
    ...(workspace
      ? [join(workspace, ".claude", "settings.json"), join(workspace, ".claude", "settings.local.json"), join(workspace, PROJECT_SETTINGS)]
      : []),
  ];
  const out: PermissionRules = { allow: [], ask: [], deny: [] };
  for (const f of files) {
    const r = readRules(f);
    for (const k of ["allow", "ask", "deny"] as const) for (const x of r[k]) if (!out[k].includes(x)) out[k].push(x);
  }
  return out;
}

// "本项目始终允许":规则写入 <ws>/.xiyun/settings.json 的 permissions.allow(保留文件里的其他字段)
export function addAllowRule(workspace: string, rule: string): void {
  const file = join(workspace, PROJECT_SETTINGS);
  let j: Record<string, unknown> = {};
  try {
    if (existsSync(file)) j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`${PROJECT_SETTINGS} 不是合法 JSON,请先修正`);
  }
  const perms = (j.permissions && typeof j.permissions === "object" ? j.permissions : {}) as Record<string, unknown>;
  const allow = Array.isArray(perms.allow) ? (perms.allow as unknown[]).filter((x) => typeof x === "string") : [];
  if (!allow.includes(rule)) allow.push(rule);
  j.permissions = { ...perms, allow };
  mkdirSync(join(workspace, ".xiyun"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`, "utf8");
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

// Bash 规则体 → 是否匹配一条(子)命令
export function matchCommand(pattern: string, command: string): boolean {
  const cmd = command.trim().replace(/\s+/g, " ");
  const p = pattern.trim().replace(/\s+/g, " ");
  if (!p || p === "*") return true;
  if (p.endsWith(":*")) return cmd.startsWith(p.slice(0, -2).trimEnd());
  // 末尾 " *" 同时匹配不带参数的命令本身:Bash(npm test *) 放行 npm test
  if (p.endsWith(" *") && cmd === p.slice(0, -2)) return true;
  const re = new RegExp(`^${p.split("*").map(escapeRe).join(".*")}$`);
  return re.test(cmd);
}

// 路径 glob:** 跨目录,* 不跨 /;以 / 结尾或不带通配的目录名匹配其下所有文件
export function matchPath(pattern: string, path: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  let p = norm(pattern.trim());
  const f = norm(path);
  if (!p || p === "**") return true;
  if (p.endsWith("/")) p += "**";
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*" && p[i + 1] === "*") {
      re += p[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += p[i + 2] === "/" ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`).test(f) || (!/[*?]/.test(p) && f.startsWith(`${p}/`));
}

// 规则 "Name(body)" 拆成名字与规则体;不带括号的规则体为 undefined(匹配该工具全部调用)
function parseRule(rule: string): { name: string; body?: string } {
  const m = /^([A-Za-z0-9_*-]+)\s*(?:\((.*)\))?$/s.exec(rule.trim());
  return m ? { name: m[1]!, ...(m[2] !== undefined ? { body: m[2] } : {}) } : { name: rule.trim() };
}

const READ_NAMES = new Set(["Read", "Grep", "Glob", "LS"]);

function ruleMatches(rule: string, req: PermRequest, subcommand?: string): boolean {
  const { name, body } = parseRule(rule);
  if (req.kind === "Mcp") {
    if (!name.startsWith("mcp__")) return false;
    if (name.endsWith("*")) return req.tool.startsWith(name.slice(0, -1));
    return req.tool === name || req.tool.startsWith(`${name}__`);
  }
  if (req.kind === "Bash") {
    if (name !== "Bash") return false;
    return body === undefined || matchCommand(body, subcommand ?? req.command ?? "");
  }
  const fits =
    req.kind === "Read" ? READ_NAMES.has(name) : req.kind === "Edit" ? name === "Edit" : name === "Edit" || name === "Write";
  if (!fits) return false;
  return body === undefined || (req.path !== undefined && matchPath(body, req.path));
}

// 复合命令拆成子命令(&& || ; | 换行),引号内的分隔符不拆
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
    } else if (ch === ";" || ch === "|" || ch === "\n" || (ch === "&" && command[i - 1] !== ">" && command[i + 1] !== ">")) {
      // 2>&1、&> 是重定向,不是后台执行
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function decide(rules: PermissionRules, req: PermRequest): PermVerdict {
  if (req.kind === "Bash") {
    const command = req.command ?? "";
    if (classifyCommand(command) === "deny") return { decision: "deny", reason: "危险命令,始终拒绝" };
    const parts = splitCommand(command);
    for (const part of parts.length ? parts : [command]) {
      if (classifyCommand(part) === "deny") return { decision: "deny", reason: "危险命令,始终拒绝" };
      const hit = rules.deny.find((r) => ruleMatches(r, req, part));
      if (hit) return { decision: "deny", reason: `命中拒绝规则 ${hit}`, rule: hit };
    }
    let firstAsk: PermVerdict | null = null;
    for (const part of parts) {
      const ask = rules.ask.find((r) => ruleMatches(r, req, part));
      if (ask) return { decision: "ask", reason: `命中询问规则 ${ask}`, rule: ask };
      if (rules.allow.some((r) => ruleMatches(r, req, part))) continue;
      if (classifyCommand(part) === "safe") continue;
      firstAsk ??= { decision: "ask", reason: `命令需要确认:${part}` };
    }
    if (firstAsk) return firstAsk;
    const allowHit = parts.map((p) => rules.allow.find((r) => ruleMatches(r, req, p))).find(Boolean);
    return allowHit ? { decision: "allow", reason: `命中允许规则 ${allowHit}`, rule: allowHit } : { decision: "allow", reason: "只读 / 测试命令" };
  }
  const deny = rules.deny.find((r) => ruleMatches(r, req));
  if (deny) return { decision: "deny", reason: `命中拒绝规则 ${deny}`, rule: deny };
  const ask = rules.ask.find((r) => ruleMatches(r, req));
  if (ask) return { decision: "ask", reason: `命中询问规则 ${ask}`, rule: ask };
  const allow = rules.allow.find((r) => ruleMatches(r, req));
  if (allow) return { decision: "allow", reason: `命中允许规则 ${allow}`, rule: allow };
  if (req.kind === "Read") return { decision: "allow", reason: "只读" };
  if (req.kind === "Mcp") return { decision: "ask", reason: "MCP 工具默认需要确认" };
  return { decision: "ask", reason: req.kind === "Write" ? "写入文件需要确认" : "修改文件需要确认" };
}

// 包管理 / 构建工具:规则取到子命令(npm run build → Bash(npm run build *))
const TWO_WORD = new Set(["npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "git", "docker", "make", "uv", "pip", "pip3", "python", "python3", "node", "deno", "dotnet", "mvn", "gradle", "kubectl"]);

// "本项目始终允许"写入的规则建议
export function suggestRule(req: PermRequest): string {
  if (req.kind === "Mcp") return req.tool;
  if (req.kind === "Bash") {
    const parts = splitCommand(req.command ?? "");
    const target = parts.find((p) => classifyCommand(p) !== "safe") ?? parts[0] ?? "";
    const words = target.split(/\s+/).filter(Boolean);
    let n = 1;
    if (TWO_WORD.has(words[0] ?? "")) n = words[1] === "run" || words[1] === "exec" || words[1] === "-m" ? 3 : 2;
    const prefix = words.slice(0, Math.min(n, words.length)).filter((w) => !w.startsWith("-") || words.indexOf(w) === 0);
    return `Bash(${prefix.join(" ")} *)`;
  }
  const p = (req.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const dir = p.includes("/") ? p.slice(0, p.indexOf("/")) : "";
  return dir ? `Edit(${dir}/**)` : p ? `Edit(${p})` : "Edit";
}
