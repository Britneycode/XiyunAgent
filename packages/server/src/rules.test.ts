import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter, toList } from "./frontmatter.ts";
import { findImports, globToRegExp, loadRuleFiles, matchGlob } from "./workspace.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "xy-rules-"));
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe("frontmatter", () => {
  test("标量、布尔、行内列表、块列表、块标量;嵌套映射忽略", () => {
    const { data, body } = parseFrontmatter(
      [
        "---",
        "name: My Skill",
        'description: "做 A 和 B"',
        "alwaysApply: false",
        "globs: [src/**/*.ts, '*.md']",
        "tags:",
        "  - a",
        "  - b",
        "long: |",
        "  第一行",
        "  第二行",
        "metadata:",
        "  author: x",
        "---",
        "正文",
      ].join("\n"),
    );
    expect(data.name).toBe("My Skill");
    expect(data.description).toBe("做 A 和 B");
    expect(data.alwaysApply).toBe(false);
    expect(data.globs).toEqual(["src/**/*.ts", "*.md"]);
    expect(data.tags).toEqual(["a", "b"]);
    expect(data.long).toBe("第一行\n第二行");
    expect(data.author).toBeUndefined();
    expect(body).toBe("正文");
  });

  test("无 frontmatter 原样返回;逗号分隔的 globs 拆成列表", () => {
    expect(parseFrontmatter("# 标题\n内容")).toEqual({ data: {}, body: "# 标题\n内容" });
    expect(toList(parseFrontmatter("---\nglobs: src/*.ts, test/*.ts\n---\n").data.globs)).toEqual(["src/*.ts", "test/*.ts"]);
  });
});

describe("glob", () => {
  test("**、*、?、{a,b} 与无目录模式", () => {
    expect(matchGlob("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
    expect(matchGlob("src/**/*.ts", "src/c.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/a/c.ts")).toBe(false);
    expect(matchGlob("*.tsx", "apps/web/App.tsx")).toBe(true);
    expect(matchGlob("**/*.{ts,tsx}", "a/b.tsx")).toBe(true);
    expect(matchGlob("file?.md", "file1.md")).toBe(true);
    expect(matchGlob("docs/", "docs/x/y.md")).toBe(true);
    expect(globToRegExp("a.b").test("aXb")).toBe(false); // . 被转义
  });
});

describe("findImports", () => {
  test("忽略代码块、行内代码、邮箱;去掉结尾标点", () => {
    const text = [
      "参见 @docs/style.md。以及 @./a.md, 还有 (@~/notes.md)",
      "邮箱 me@example.com 不算",
      "`@inline.md` 不算",
      "```",
      "@fenced.md",
      "```",
    ].join("\n");
    expect(findImports(text)).toEqual(["docs/style.md", "./a.md", "~/notes.md"]);
  });
});

describe("loadRuleFiles", () => {
  test("兼容 .cursorrules 与 copilot-instructions", () => {
    const w = tmp();
    put(w, ".cursorrules", "cursor 旧规则");
    put(w, ".github/copilot-instructions.md", "copilot 规则");
    const rules = loadRuleFiles(w);
    expect(rules).toContain("## .cursorrules\ncursor 旧规则");
    expect(rules).toContain("## .github/copilot-instructions.md\ncopilot 规则");
  });

  test(".mdc:alwaysApply 总是加载,globs 只在引用文件匹配时加载,其余进按需索引", () => {
    const w = tmp();
    put(w, ".cursor/rules/base.mdc", "---\nalwaysApply: true\n---\n总是生效");
    put(w, ".cursor/rules/ts.mdc", "---\nglobs: src/**/*.ts\nalwaysApply: false\n---\nTS 规则");
    put(w, ".cursor/rules/sub/db.mdc", "---\ndescription: 数据库迁移约定\n---\nDB 规则");
    put(w, ".github/instructions/py.instructions.md", "---\napplyTo: \"**/*.py\"\n---\nPY 规则");
    const none = loadRuleFiles(w);
    expect(none).toContain("总是生效");
    expect(none).not.toContain("---");
    expect(none).not.toContain("TS 规则");
    expect(none).not.toContain("PY 规则");
    expect(none).toContain("- .cursor/rules/sub/db.mdc:数据库迁移约定");
    expect(none).not.toContain("DB 规则");
    const hit = loadRuleFiles(w, { files: ["src/a/b.ts", join(w, "tools", "x.py")] });
    expect(hit).toContain("(匹配 src/**/*.ts)\nTS 规则");
    expect(hit).toContain("PY 规则");
  });

  test("目录级规则按引用文件由浅到深加载,CLAUDE.local.md 最后", () => {
    const w = tmp();
    put(w, "AGENTS.md", "根规则");
    put(w, "CLAUDE.local.md", "本地规则");
    put(w, "packages/AGENTS.md", "包规则");
    put(w, "packages/server/CLAUDE.md", "服务端规则");
    put(w, "apps/AGENTS.md", "前端规则");
    const rules = loadRuleFiles(w, { files: ["packages/server/src/app.ts"] });
    const order = ["根规则", "包规则", "服务端规则", "本地规则"].map((s) => rules.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rules).not.toContain("前端规则"); // 未引用 apps/ 下的文件
    expect(rules).toContain("## packages/server/CLAUDE.md");
  });

  test("@导入:展开、递归、防环;越界导入被忽略", () => {
    const w = tmp();
    const outside = tmp();
    put(outside, "secret.md", "机密");
    put(w, "CLAUDE.md", `见 @docs/a.md 和 @../${outside.split(/[\\/]/).pop()}/secret.md`);
    put(w, "docs/a.md", "A 内容 @b.md");
    put(w, "docs/b.md", "B 内容 @a.md");
    const rules = loadRuleFiles(w);
    expect(rules).toContain("### 导入:docs/a.md\nA 内容");
    expect(rules).toContain("### 导入:docs/b.md\nB 内容");
    expect(rules.match(/A 内容/g)).toHaveLength(1); // 环被截断
    expect(rules).not.toContain("机密");
  });

  test("内容相同的规则文件只注入一次", () => {
    const w = tmp();
    put(w, "AGENTS.md", "同一份规则");
    put(w, "CLAUDE.md", "同一份规则\n");
    expect(loadRuleFiles(w).match(/同一份规则/g)).toHaveLength(1);
  });

  test("用户级 ~/.claude/CLAUDE.md 只在 Code 模式加载,且排在项目规则前", () => {
    const w = tmp();
    const home = tmp();
    put(home, ".claude/CLAUDE.md", "用户偏好 @~/extra.md");
    put(home, "extra.md", "用户导入");
    put(w, "AGENTS.md", "项目规则");
    const code = loadRuleFiles(w, { mode: "code", homeDir: home });
    expect(code).toContain("用户偏好");
    expect(code).toContain("用户导入");
    expect(code.indexOf("用户偏好")).toBeLessThan(code.indexOf("项目规则"));
    expect(loadRuleFiles(w, { mode: "chat", homeDir: home })).not.toContain("用户偏好");
  });

  test("项目规则不能通过 ~/ 导入用户目录文件", () => {
    const w = tmp();
    const home = tmp();
    put(home, "id_rsa", "私钥");
    put(w, "AGENTS.md", "项目 @~/id_rsa");
    expect(loadRuleFiles(w, { mode: "code", homeDir: home })).not.toContain("私钥");
  });

  test("单文件截断与总量上限", () => {
    const w = tmp();
    put(w, "AGENTS.md", "a".repeat(25_000));
    put(w, "CLAUDE.md", "b".repeat(19_000));
    put(w, ".cursorrules", "c".repeat(19_000));
    put(w, "CLAUDE.local.md", "d".repeat(19_000));
    const rules = loadRuleFiles(w);
    expect(rules).toContain("已截断,原文 25000 字");
    expect(rules).toContain("已省略:CLAUDE.local.md");
    expect(rules.length).toBeLessThan(62_000);
  });
});
