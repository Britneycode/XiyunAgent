import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// 工作区边界:所有文件访问必须落在 workspace 目录内。
export function assertInside(workspace: string, target: string): string {
  const w = resolve(workspace);
  const t = resolve(workspace, target);
  if (t !== w && !t.startsWith(w + sep)) throw new Error(`path outside workspace: ${target}`);
  return t;
}

const PROJECT_RULE_FILES = ["AGENTS.md", "CLAUDE.md"];

// 规则层(决策 D-004 第一层),按 全局 → 模式 → 项目 顺序拼接,项目规则最后优先级最高。
export function loadRuleFiles(workspace: string, opts: { dataDir?: string; mode?: string } = {}): string {
  const parts: string[] = [];
  if (opts.dataDir) {
    const globalFile = join(opts.dataDir, "rules", "global.md");
    if (existsSync(globalFile)) parts.push(`## 全局规则\n${readFileSync(globalFile, "utf8")}`);
    if (opts.mode) {
      const modeFile = join(opts.dataDir, "rules", `${opts.mode}.md`);
      if (existsSync(modeFile)) parts.push(`## 模式规则(${opts.mode})\n${readFileSync(modeFile, "utf8")}`);
    }
  }
  for (const name of PROJECT_RULE_FILES) {
    const p = assertInside(workspace, name);
    if (existsSync(p)) parts.push(`## ${name}\n${readFileSync(p, "utf8")}`);
  }
  return parts.join("\n\n");
}
