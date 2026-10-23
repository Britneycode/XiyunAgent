import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import {
  applyClaudeDesktopImport, effectiveConfig, isProjectTrusted, loadUserConfig, McpManager, normalizeToolName,
  previewClaudeDesktopImport, revokeProjectTrust, saveUserConfig, trustProject, type McpConfig,
} from "./mcp.ts";
import { decide } from "./permissions.ts";

const fixture = join(import.meta.dirname, "..", "fixtures", "mcp-echo-server.mjs");
const userFile = join(homedir(), ".xiyun", "mcp.json");
const trust = join(homedir(), ".xiyun", "mcp-trust.json");

// 备份并恢复用户级配置文件,避免测试污染真实配置
let backup: { user: string | null; trust: string | null } = { user: null, trust: null };
const readIf = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);

beforeEach(() => {
  backup = { user: readIf(userFile), trust: readIf(trust) };
  mkdirSync(join(homedir(), ".xiyun"), { recursive: true });
});
afterEach(() => {
  if (backup.user === null) rmSync(userFile, { force: true });
  else writeFileSync(userFile, backup.user);
  if (backup.trust === null) rmSync(trust, { force: true });
  else writeFileSync(trust, backup.trust);
});

describe("normalizeToolName", () => {
  it("拼成 mcp__server__tool 并清洗非法字符", () => {
    expect(normalizeToolName("github", "create_issue")).toBe("mcp__github__create_issue");
    expect(normalizeToolName("my server", "do.it")).toBe("mcp__my_server__do_it");
  });

  it("超过 64 字符时截断并加短哈希", () => {
    const name = normalizeToolName("s".repeat(40), "t".repeat(40));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/_[0-9a-f]{8}$/);
    // 不同原名不应撞名
    expect(name).not.toBe(normalizeToolName("s".repeat(40), "t".repeat(41)));
  });
});

describe("配置与信任", () => {
  const ws = () => mkdtempSync(join(tmpdir(), "xiyun-mcp-ws-"));

  it("用户级与项目级合并,项目级同名覆盖", () => {
    saveUserConfig({ mcpServers: { a: { command: "node" }, b: { command: "node" } } });
    const dir = ws();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { b: { command: "bun" }, c: { command: "node" } } }));
    trustProject(dir);
    const { cfg } = effectiveConfig(dir);
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["a", "b", "c"]);
    expect(cfg.mcpServers.b!.command).toBe("bun");
    rmSync(dir, { recursive: true, force: true });
  });

  it("项目级未信任时被忽略", () => {
    saveUserConfig({ mcpServers: {} });
    const dir = ws();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "rm" } } }));
    expect(isProjectTrusted(dir)).toBe(false);
    const { cfg, projectPending } = effectiveConfig(dir);
    expect(projectPending).toBe(true);
    expect(cfg.mcpServers).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });

  it("信任后配置变更需要重新批准", () => {
    const dir = ws();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "node" } } }));
    trustProject(dir);
    expect(isProjectTrusted(dir)).toBe(true);
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "sh" } } }));
    expect(isProjectTrusted(dir)).toBe(false);
    revokeProjectTrust(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("没有项目级配置时视为已信任", () => {
    const dir = ws();
    expect(isProjectTrusted(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("MCP 规则", () => {
  it("mcp__x__* 与具体工具名都能放行", () => {
    const rules = { allow: ["mcp__github__*"], ask: [], deny: [] };
    expect(decide(rules, { kind: "Mcp", tool: "mcp__github__create_issue" }).decision).toBe("allow");
    expect(decide(rules, { kind: "Mcp", tool: "mcp__gitlab__create_issue" }).decision).toBe("ask");
    const exact = { allow: ["mcp__github__create_issue"], ask: [], deny: [] };
    expect(decide(exact, { kind: "Mcp", tool: "mcp__github__create_issue" }).decision).toBe("allow");
    expect(decide(exact, { kind: "Mcp", tool: "mcp__github__delete_issue" }).decision).toBe("ask");
  });
});

describe("Claude Desktop 导入", () => {
  it("同名只列冲突,不覆盖", () => {
    // 用一个临时文件模拟 Claude Desktop 配置不可行(路径固定),这里只验证冲突判定逻辑
    saveUserConfig({ mcpServers: { existing: { command: "node" } } });
    const preview = previewClaudeDesktopImport();
    expect(Array.isArray(preview.servers)).toBe(true);
    for (const s of preview.servers) expect(typeof s.conflict).toBe("boolean");
    // 应用时已存在的名字应被跳过
    const r = applyClaudeDesktopImport(["existing"]);
    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(1);
  });
});

describe("stdio 端到端", () => {
  it("列出工具并调用 echo / add", async () => {
    saveUserConfig({ mcpServers: { echo: { command: process.execPath, args: [fixture] } } });
    const m = new McpManager();
    const workspace = mkdtempSync(join(tmpdir(), "xiyun-mcp-e2e-"));
    try {
      const tools = await m.tools(workspace);
      expect(tools.map((t) => t.name).sort()).toEqual(["mcp__echo__add", "mcp__echo__echo"]);
      expect(await m.callTool(workspace, "echo", "echo", { text: "hi" })).toBe("echo: hi");
      expect(await m.callTool(workspace, "echo", "add", { a: 2, b: 3 })).toBe("5");
    } finally {
      await m.closeAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it("服务器不存在时调用报错", async () => {
    saveUserConfig({ mcpServers: {} });
    const m = new McpManager();
    const workspace = mkdtempSync(join(tmpdir(), "xiyun-mcp-e2e-"));
    await expect(m.callTool(workspace, "nope", "x", {})).rejects.toThrow(/不存在/);
    rmSync(workspace, { recursive: true, force: true });
  });

  it("disabled 的服务器不连接", async () => {
    saveUserConfig({ mcpServers: { echo: { command: process.execPath, args: [fixture], disabled: true } } });
    const m = new McpManager();
    const workspace = mkdtempSync(join(tmpdir(), "xiyun-mcp-e2e-"));
    expect(await m.tools(workspace)).toEqual([]);
    const st = await m.status(workspace);
    expect(st[0]!.status).toBe("disabled");
    await m.closeAll();
    rmSync(workspace, { recursive: true, force: true });
  }, 30_000);
});

describe("配置校验", () => {
  it("保存的配置能原样读回", () => {
    const cfg: McpConfig = { mcpServers: { a: { command: "node", args: ["x.js"], env: { K: "v" } } } };
    saveUserConfig(cfg);
    expect(loadUserConfig()).toEqual(cfg);
  });
});
