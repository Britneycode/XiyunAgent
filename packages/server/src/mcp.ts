import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDef } from "../../runtime/src/index.ts";

// ---- MCP 客户端(B3 / D-025)----
// 用户级配置 ~/.xiyun/mcp.json(格式同 claude_desktop_config.json,另支持远程 http / sse),
// 项目级配置 <ws>/.mcp.json(Claude Code 格式,首次使用前需要用户在设置里批准)。
// 工具名统一为 mcp__<server>__<tool>,字符限定 [a-zA-Z0-9_-],超长时截断并加短哈希。

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOL_NAME = 64;
const STDERR_TAIL = 8 * 1024;
const MAX_RESULT = 30_000;

export type McpStatus = "connected" | "connecting" | "error" | "disabled";

export interface McpServerConfig {
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // 远程
  type?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpToolInfo {
  name: string; // 规范化后的名字(mcp__server__tool)
  originalName: string;
  server: string;
  description: string;
  inputSchema: object;
}

interface Connection {
  client: Client;
  status: McpStatus;
  error?: string;
  stderr: string;
  tools: McpToolInfo[];
}

export const userMcpFile = () => join(homedir(), ".xiyun", "mcp.json");
export const trustFile = () => join(homedir(), ".xiyun", "mcp-trust.json");
export const projectMcpFile = (workspace: string) => join(workspace, ".mcp.json");

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function loadUserConfig(): McpConfig {
  return readJson<McpConfig>(userMcpFile(), { mcpServers: {} });
}

export function saveUserConfig(cfg: McpConfig): void {
  writeJson(userMcpFile(), cfg);
}

export function loadProjectConfig(workspace: string): McpConfig {
  if (!workspace) return { mcpServers: {} };
  return readJson<McpConfig>(projectMcpFile(workspace), { mcpServers: {} });
}

// 项目级配置的信任状态:按工作区路径记录,内容变化后需要重新批准
type TrustMap = Record<string, string>; // workspace -> 配置内容哈希

export function isProjectTrusted(workspace: string): boolean {
  const cfg = loadProjectConfig(workspace);
  if (!Object.keys(cfg.mcpServers).length) return true; // 没有项目级配置就不需要信任
  const map = readJson<TrustMap>(trustFile(), {});
  return map[workspace] === configHash(cfg);
}

export function trustProject(workspace: string): void {
  const map = readJson<TrustMap>(trustFile(), {});
  map[workspace] = configHash(loadProjectConfig(workspace));
  writeJson(trustFile(), map);
}

export function revokeProjectTrust(workspace: string): void {
  const map = readJson<TrustMap>(trustFile(), {});
  delete map[workspace];
  writeJson(trustFile(), map);
}

const configHash = (cfg: McpConfig) => createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 16);

// 合并用户级与项目级(项目级同名覆盖用户级);项目级未获信任时忽略
export function effectiveConfig(workspace: string): { cfg: McpConfig; projectPending: boolean } {
  const user = loadUserConfig();
  const project = loadProjectConfig(workspace);
  const hasProject = Object.keys(project.mcpServers).length > 0;
  const trusted = !hasProject || isProjectTrusted(workspace);
  const merged: McpConfig = { mcpServers: { ...user.mcpServers } };
  if (trusted) Object.assign(merged.mcpServers, project.mcpServers);
  return { cfg: merged, projectPending: hasProject && !trusted };
}

// 工具名规范化:限定字符集,超过 64 时截断并加 8 位哈希
export function normalizeToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = createHash("sha1").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
}

// Windows 下 npx / npm 需要 cmd /c 包一层,否则 spawn 找不到 .cmd
function wrapCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args };
  if (!/^(npx|npm|pnpm|yarn|bunx)$/i.test(command)) return { command, args };
  return { command: "cmd", args: ["/c", command, ...args] };
}

export class McpManager {
  private conns = new Map<string, Connection>(); // key = `${workspace}\0${server}`
  private inflight = new Map<string, Promise<Connection | null>>();

  private key(workspace: string, server: string) {
    return `${workspace}\0${server}`;
  }

  private async connect(workspace: string, server: string, cfg: McpServerConfig): Promise<Connection | null> {
    if (cfg.disabled) {
      this.conns.set(this.key(workspace, server), { client: null as unknown as Client, status: "disabled", stderr: "", tools: [] });
      return null;
    }
    const client = new Client({ name: "xiyun-agent", version: "0.1.0" }, { capabilities: {} });
    const conn: Connection = { client, status: "connecting", stderr: "", tools: [] };
    this.conns.set(this.key(workspace, server), conn);

    let transport;
    try {
      if (cfg.type === "http" || cfg.type === "sse") {
        if (!cfg.url) throw new Error("缺少 url");
        const opts = { requestInit: cfg.headers ? { headers: cfg.headers } : undefined };
        if (cfg.type === "http") {
          transport = new StreamableHTTPClientTransport(new URL(cfg.url), opts);
        } else {
          transport = new SSEClientTransport(new URL(cfg.url), opts);
        }
      } else {
        if (!cfg.command) throw new Error("缺少 command");
        const w = wrapCommand(cfg.command, cfg.args ?? []);
        transport = new StdioClientTransport({
          command: w.command,
          args: w.args,
          env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
          ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
          stderr: "pipe",
        });
        // 保留 stderr 尾部用于排错
        const stderrStream = (transport as unknown as { stderr?: NodeJS.ReadableStream | null }).stderr;
        stderrStream?.on("data", (d: Buffer) => {
          conn.stderr = `${conn.stderr}${d.toString("utf8")}`.slice(-STDERR_TAIL);
        });
      }

      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => setTimeout(() => reject(new Error("连接超时(30s)")), CONNECT_TIMEOUT_MS)),
      ]);
      conn.status = "connected";
      conn.tools = await this.listTools(conn, server);
      // 服务器增删工具时刷新缓存
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          conn.tools = await this.listTools(conn, server);
        } catch {
          // 刷新失败保留旧列表
        }
      });
      return conn;
    } catch (e) {
      // http 失败时回退到 sse 一次
      if (cfg.type === "http" && cfg.url) {
        try {
          const fallback = new SSEClientTransport(new URL(cfg.url), {
            requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
          });
          await client.connect(fallback);
          conn.status = "connected";
          conn.tools = await this.listTools(conn, server);
          return conn;
        } catch {
          // 继续走下面的错误处理
        }
      }
      conn.status = "error";
      conn.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  private async listTools(conn: Connection, server: string): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (;;) {
      const r = await conn.client.listTools(cursor ? { cursor } : {});
      for (const t of r.tools) {
        out.push({
          name: normalizeToolName(server, t.name),
          originalName: t.name,
          server,
          description: t.description ?? "",
          inputSchema: (t.inputSchema as object) ?? { type: "object", properties: {} },
        });
      }
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  // 惰性连接:首次需要工具时才启动
  async ensure(workspace: string, server: string, cfg: McpServerConfig): Promise<Connection | null> {
    const k = this.key(workspace, server);
    const existing = this.conns.get(k);
    if (existing?.status === "connected") return existing;
    if (existing?.status === "disabled") return null;
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const p = this.connect(workspace, server, cfg).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  // 该工作区所有可用服务器的工具定义
  async tools(workspace: string): Promise<McpToolInfo[]> {
    const { cfg } = effectiveConfig(workspace);
    const out: McpToolInfo[] = [];
    for (const [name, sc] of Object.entries(cfg.mcpServers)) {
      const conn = await this.ensure(workspace, name, sc);
      if (conn) out.push(...conn.tools);
    }
    return out;
  }

  async callTool(workspace: string, server: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const { cfg } = effectiveConfig(workspace);
    const sc = cfg.mcpServers[server];
    if (!sc) throw new Error(`MCP 服务器不存在:${server}`);
    const conn = await this.ensure(workspace, server, sc);
    if (!conn) throw new Error(`MCP 服务器未连接:${server}`);

    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("调用超时(120s)")), CALL_TIMEOUT_MS));
    const abort = new Promise<never>((_, reject) => {
      if (signal?.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      else signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
    const r = await Promise.race([
      conn.client.callTool({ name: toolName, arguments: args }),
      timeout,
      abort,
    ]);
    const content = (r as { content?: unknown[] }).content ?? [];
    const parts: string[] = [];
    for (const c of content as Array<Record<string, unknown>>) {
      if (c.type === "text") parts.push(String(c.text ?? ""));
      else if (c.type === "image") parts.push(`[图片 ${String(c.mimeType ?? "")}]`);
      else if (c.type === "resource") {
        const res = c.resource as { text?: string; uri?: string } | undefined;
        parts.push(res?.text ?? res?.uri ?? "[资源]");
      } else parts.push(`[${String(c.type)}]`);
    }
    const text = parts.join("\n");
    return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n...[已截断]` : text;
  }

  // 状态总览(设置页与接口用)
  async status(workspace: string): Promise<Array<{ name: string; status: McpStatus; tools: number; error?: string; stderr?: string }>> {
    const { cfg, projectPending } = effectiveConfig(workspace);
    const out = [];
    for (const [name, sc] of Object.entries(cfg.mcpServers)) {
      const conn = await this.ensure(workspace, name, sc);
      const c = this.conns.get(this.key(workspace, name));
      out.push({
        name,
        status: conn?.status ?? c?.status ?? "connecting",
        tools: conn?.tools.length ?? 0,
        ...(conn?.error || c?.error ? { error: conn?.error ?? c?.error } : {}),
        ...(c?.stderr ? { stderr: c.stderr } : {}),
      });
    }
    void projectPending;
    return out;
  }

  async toolList(workspace: string): Promise<Array<{ server: string; name: string; description: string }>> {
    const tools = await this.tools(workspace);
    return tools.map((t) => ({ server: t.server, name: t.name, description: t.description }));
  }

  async restart(workspace: string, server: string): Promise<boolean> {
    const k = this.key(workspace, server);
    const old = this.conns.get(k);
    if (old?.client) await old.client.close().catch(() => {});
    this.conns.delete(k);
    const { cfg } = effectiveConfig(workspace);
    const sc = cfg.mcpServers[server];
    if (!sc) return false;
    return (await this.ensure(workspace, server, sc))?.status === "connected";
  }

  async closeAll(): Promise<void> {
    for (const c of this.conns.values()) {
      if (c.client) await c.client.close().catch(() => {});
    }
    this.conns.clear();
  }
}

// 把 MCP 工具转成 AgentTool 可用的定义(权限类型由 agent 侧按 mcp__ 前缀判定)
export function toToolDef(t: McpToolInfo): ToolDef {
  return { name: t.name, description: t.description || `MCP 工具 ${t.originalName}`, parameters: t.inputSchema };
}

// Claude Desktop 配置位置
export function claudeDesktopConfigPath(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

export interface ImportPreview {
  available: boolean;
  path: string;
  servers: Array<{ name: string; conflict: boolean }>;
}

// 从 Claude Desktop 导入预览:同名只列冲突,不覆盖
export function previewClaudeDesktopImport(): ImportPreview {
  const path = claudeDesktopConfigPath();
  const src = readJson<McpConfig>(path, { mcpServers: {} });
  const mine = loadUserConfig();
  const names = Object.keys(src.mcpServers ?? {});
  return {
    available: names.length > 0,
    path,
    servers: names.map((name) => ({ name, conflict: name in mine.mcpServers })),
  };
}

export function applyClaudeDesktopImport(names: string[]): { imported: number; skipped: number } {
  const src = readJson<McpConfig>(claudeDesktopConfigPath(), { mcpServers: {} });
  const mine = loadUserConfig();
  let imported = 0;
  let skipped = 0;
  for (const name of names) {
    const sc = src.mcpServers?.[name];
    if (!sc) {
      skipped += 1;
      continue;
    }
    if (name in mine.mcpServers) {
      skipped += 1;
      continue;
    }
    mine.mcpServers[name] = sc;
    imported += 1;
  }
  saveUserConfig(mine);
  return { imported, skipped };
}
