import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addAllowRule, decide, loadPermissions, matchCommand, matchPath, splitCommand, suggestRule,
  type PermRequest, type PermissionRules,
} from "./permissions.ts";

const ws = () => mkdtempSync(join(tmpdir(), "xiyun-perm-"));
const bash = (command: string): PermRequest => ({ kind: "Bash", tool: "bash", command });
const read = (path: string): PermRequest => ({ kind: "Read", tool: "read_file", path });
const edit = (path: string): PermRequest => ({ kind: "Edit", tool: "edit_file", path });
const write = (path: string): PermRequest => ({ kind: "Write", tool: "write_file", path });
const mcp = (tool: string): PermRequest => ({ kind: "Mcp", tool });
const rules = (o: Partial<PermissionRules> = {}): PermissionRules => ({ allow: [], ask: [], deny: [], ...o });

describe("matchCommand", () => {
  it("通配匹配", () => {
    expect(matchCommand("npm run *", "npm run build")).toBe(true);
    expect(matchCommand("npm run *", "npm run test --watch")).toBe(true);
    expect(matchCommand("npm run *", "npm install")).toBe(false);
  });

  it("末尾 \" *\" 也匹配不带参数的命令本身", () => {
    expect(matchCommand("npm test *", "npm test")).toBe(true);
    expect(matchCommand("npm test *", "npm test --watch")).toBe(true);
  });

  it("前缀写法 (旧格式)", () => {
    expect(matchCommand("npm test:*", "npm test:unit")).toBe(true);
    expect(matchCommand("npm test:*", "npm test")).toBe(true);
    expect(matchCommand("npm test:*", "npm run test")).toBe(false);
  });

  it("不带通配时精确匹配", () => {
    expect(matchCommand("git status", "git status")).toBe(true);
    expect(matchCommand("git status", "git status --short")).toBe(false);
  });
});

describe("matchPath", () => {
  it("** 跨目录,* 不跨 /", () => {
    expect(matchPath("src/**", "src/a/b/c.ts")).toBe(true);
    expect(matchPath("src/*", "src/a.ts")).toBe(true);
    expect(matchPath("src/*", "src/a/b.ts")).toBe(false);
  });

  it("目录名匹配其下所有文件", () => {
    expect(matchPath("src", "src/a.ts")).toBe(true);
    expect(matchPath("src/", "src/a/b.ts")).toBe(true);
  });

  it("反斜杠路径归一化", () => {
    expect(matchPath("src/**", "src\\a\\b.ts")).toBe(true);
  });
});

describe("splitCommand", () => {
  it("按 && || ; | 拆分", () => {
    expect(splitCommand("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("引号内的分隔符不拆", () => {
    expect(splitCommand(`echo "a && b"`)).toEqual([`echo "a && b"`]);
  });

  it("重定向不拆", () => {
    expect(splitCommand("npm run build 2>&1")).toEqual(["npm run build 2>&1"]);
    expect(splitCommand("npm run build &> log")).toEqual(["npm run build &> log"]);
  });
});

describe("decide", () => {
  it("优先级 deny > ask > allow > 默认", () => {
    const r = rules({ deny: ["Bash(rm *)"], ask: ["Bash(git *)"], allow: ["Bash(git status)"] });
    expect(decide(r, bash("rm -rf x")).decision).toBe("deny");
    expect(decide(r, bash("git status")).decision).toBe("ask"); // ask 优先于 allow
    expect(decide(rules({ allow: ["Bash(git status)"] }), bash("git status")).decision).toBe("allow");
  });

  it("危险命令不能被 allow 覆盖", () => {
    const r = rules({ allow: ["Bash", "Bash(rm *)"] });
    const v = decide(r, bash("rm -rf /"));
    expect(v.decision).toBe("deny");
  });

  it("复合命令里任一子命令未被允许时结果为 ask", () => {
    const r = rules({ allow: ["Bash(npm test *)"] });
    expect(decide(r, bash("npm test && curl http://x")).decision).toBe("ask");
  });

  it("复合命令里任一子命令命中拒绝规则则整条拒绝", () => {
    const r = rules({ allow: ["Bash"], deny: ["Bash(rm *)"] });
    expect(decide(r, bash("npm test && rm -rf dist")).decision).toBe("deny");
  });

  it("读类默认允许,写类默认询问", () => {
    expect(decide(rules(), read("a.ts")).decision).toBe("allow");
    expect(decide(rules(), edit("a.ts")).decision).toBe("ask");
    expect(decide(rules(), write("a.ts")).decision).toBe("ask");
  });

  it("MCP 默认询问,规则可放行", () => {
    expect(decide(rules(), mcp("mcp__github__create_issue")).decision).toBe("ask");
    expect(decide(rules({ allow: ["mcp__github"] }), mcp("mcp__github__create_issue")).decision).toBe("allow");
    expect(decide(rules({ allow: ["mcp__github__*"] }), mcp("mcp__github__create_issue")).decision).toBe("allow");
    expect(decide(rules({ allow: ["mcp__github__create_issue"] }), mcp("mcp__github__delete_issue")).decision).toBe("ask");
  });

  it("Edit 规则同时覆盖 Write", () => {
    const r = rules({ allow: ["Edit(src/**)"] });
    expect(decide(r, edit("src/a.ts")).decision).toBe("allow");
    expect(decide(r, write("src/a.ts")).decision).toBe("allow");
    expect(decide(r, edit("lib/a.ts")).decision).toBe("ask");
  });
});

describe("loadPermissions", () => {
  it("多个设置文件合并", () => {
    const dir = ws();
    const home = join(dir, "home");
    const proj = join(dir, "proj");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(proj, ".claude"), { recursive: true });
    mkdirSync(join(proj, ".xiyun"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: ["Bash(curl *)"] } }));
    writeFileSync(join(proj, ".xiyun", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } }));

    const r = loadPermissions(proj, { homeDir: home });
    expect(r.allow).toContain("Bash(ls)");
    expect(r.ask).toContain("Bash(curl *)");
    expect(r.deny).toContain("Bash(rm *)");
    rmSync(dir, { recursive: true, force: true });
  });

  it("格式错误的设置文件被忽略,不影响其他来源", () => {
    const dir = ws();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(dir, ".xiyun"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{ not json");
    writeFileSync(join(dir, ".xiyun", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    expect(loadPermissions(dir).allow).toEqual(["Bash(ls)"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("addAllowRule", () => {
  it("写入 .xiyun/settings.json 并保留其他字段", () => {
    const dir = ws();
    mkdirSync(join(dir, ".xiyun"), { recursive: true });
    writeFileSync(join(dir, ".xiyun", "settings.json"), JSON.stringify({ other: 1, permissions: { deny: ["Bash(rm *)"] } }));
    addAllowRule(dir, "Bash(npm run build *)");
    const j = JSON.parse(readFileSync(join(dir, ".xiyun", "settings.json"), "utf8")) as {
      other: number; permissions: { allow: string[]; deny: string[] };
    };
    expect(j.other).toBe(1);
    expect(j.permissions.allow).toEqual(["Bash(npm run build *)"]);
    expect(j.permissions.deny).toEqual(["Bash(rm *)"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("重复写入不产生重复项", () => {
    const dir = ws();
    addAllowRule(dir, "Bash(ls)");
    addAllowRule(dir, "Bash(ls)");
    expect(loadPermissions(dir).allow).toEqual(["Bash(ls)"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("suggestRule", () => {
  it("Bash 取到子命令", () => {
    expect(suggestRule(bash("npm run build --prod"))).toBe("Bash(npm run build *)");
    expect(suggestRule(bash("git status"))).toBe("Bash(git status *)");
  });

  it("编辑文件取到目录", () => {
    expect(suggestRule(edit("src/a.ts"))).toBe("Edit(src/**)");
    expect(suggestRule(edit("a.ts"))).toBe("Edit(a.ts)");
  });

  it("MCP 用工具名本身", () => {
    expect(suggestRule(mcp("mcp__github__create_issue"))).toBe("mcp__github__create_issue");
  });
});
