import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatBlock, ChatMessage, ProviderProtocol, ToolCall, ToolDecision, ToolStatus, TokenUsage } from "@xiyun/shared";
import type { ChatProvider, ProviderEvent, ToolDef } from "../../runtime/src/index.ts";
import { addAllowRule, decide, loadPermissions, suggestRule, type PermRequest, type PermissionRules } from "./permissions.ts";
import { assertInside } from "./workspace.ts";
import { gitExec, listTool, shellExec, ToolError, writeTool } from "./tools.ts";

// ---- Agent 工具循环(B1 / F7,D-024)----
// Code / Work 模式把工具定义下发给模型,模型发起调用后在这里执行,结果回传给模型继续下一步。
// 写操作和非白名单命令先经权限规则判定,需要确认时挂起等待用户在界面上选择。

export interface ToolCtx {
  workspace: string;
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export interface ToolOutcome {
  text: string;
  display?: string;
  isError?: boolean;
  exitCode?: number;
}

export interface AgentTool {
  def: ToolDef;
  perm(args: Record<string, unknown>): PermRequest;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome>;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024; // read_file 拒绝大于 10MB 的文件
const MAX_LINE_CHARS = 2000; // 单行超过后截断,避免压缩后的代码撑爆上下文
const MAX_GREP_BYTES = 1024 * 1024; // grep 跳过大于 1MB 的文件
const MAX_TOOL_TEXT = 30_000; // 回传给模型的工具结果上限
const MAX_RESULT_DISPLAY = 10_000; // 界面展示用的结果上限

const arg = (args: Record<string, unknown>, k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
const numArg = (args: Record<string, unknown>, k: string, dflt: number) => {
  const v = args[k];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
};

// 二进制判定:前 8KB 含 NUL
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "target", ".xiyun-wt"]);

// 结果过长时保留开头 40% 与结尾 60%(工具输出和文件内容都是尾部更重要)
export function truncateMiddle(text: string, limit = MAX_TOOL_TEXT): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  return `${text.slice(0, head)}\n\n...[已截断 ${text.length - limit} 字符]...\n\n${text.slice(-tail)}`;
}

// ---- 工具实现 ----

const readFileTool: AgentTool = {
  def: {
    name: "read_file",
    description: "读取工作区内文件的内容,输出带行号。可用 offset/limit 分段读取大文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区相对路径" },
        offset: { type: "number", description: "起始行号,从 1 开始,默认 1" },
        limit: { type: "number", description: "读取行数,默认 2000" },
      },
      required: ["path"],
    },
  },
  perm: (a) => ({ kind: "Read", tool: "read_file", path: arg(a, "path") }),
  async run(a, ctx) {
    const rel = arg(a, "path");
    const abs = assertInside(ctx.workspace, rel);
    if (!existsSync(abs)) throw new ToolError(`文件不存在:${rel}`);
    const st = statSync(abs);
    if (st.isDirectory()) throw new ToolError(`${rel} 是目录,请用 list_files`);
    if (st.size > MAX_FILE_BYTES) throw new ToolError(`文件过大(${st.size}B,上限 10MB),请用 bash 分段查看`);
    const buf = readFileSync(abs);
    if (looksBinary(buf)) throw new ToolError(`${rel} 是二进制文件,无法按文本读取`);
    const lines = buf.toString("utf8").split(/\r?\n/);
    const offset = Math.max(1, numArg(a, "offset", 1));
    const limit = numArg(a, "limit", 2000);
    const end = Math.min(lines.length, offset - 1 + limit);
    const out: string[] = [];
    for (let i = offset - 1; i < end; i++) {
      const raw = lines[i] ?? "";
      const text = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}...[本行已截断]` : raw;
      out.push(`${String(i + 1).padStart(6, " ")}\t${text}`);
    }
    const more = end < lines.length ? `\n\n(共 ${lines.length} 行,已显示到第 ${end} 行;用 offset=${end + 1} 继续读取)` : `\n\n(共 ${lines.length} 行)`;
    return { text: out.join("\n") + more };
  },
};

const listFilesTool: AgentTool = {
  def: {
    name: "list_files",
    description: "列出工作区内的文件(相对路径),跳过依赖与构建目录。",
    parameters: { type: "object", properties: { path: { type: "string", description: "子目录,默认 ." } } },
  },
  perm: () => ({ kind: "Read", tool: "list_files" }),
  async run(a, ctx) {
    const sub = arg(a, "path") || ".";
    const files = listTool(ctx.workspace, sub);
    const capped = files.length >= 500 ? "\n\n(已截断,只显示前 500 条)" : "";
    return { text: files.join("\n") + capped };
  },
};

const grepTool: AgentTool = {
  def: {
    name: "grep",
    description: "在工作区内按正则搜索文件内容,输出 路径:行号: 内容。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "限定子目录,默认整个工作区" },
        glob: { type: "string", description: "文件名过滤,如 *.ts" },
        ignore_case: { type: "boolean", description: "忽略大小写" },
        max_results: { type: "number", description: "最多返回条数,默认 100" },
      },
      required: ["pattern"],
    },
  },
  perm: () => ({ kind: "Read", tool: "grep" }),
  async run(a, ctx) {
    const pattern = arg(a, "pattern");
    if (!pattern) throw new ToolError("缺少 pattern");
    let re: RegExp;
    try {
      re = new RegExp(pattern, a.ignore_case ? "i" : "");
    } catch (e) {
      throw new ToolError(`正则无效:${e instanceof Error ? e.message : String(e)}`);
    }
    const max = numArg(a, "max_results", 100);
    const glob = arg(a, "glob");
    const globRe = glob ? new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`) : null;
    const root = assertInside(ctx.workspace, arg(a, "path") || ".");
    const hits: string[] = [];
    const walk = (dir: string, rel: string) => {
      if (hits.length >= max) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= max) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), r);
          continue;
        }
        if (!e.isFile()) continue;
        if (globRe && !globRe.test(e.name)) continue;
        const abs = join(dir, e.name);
        try {
          if (statSync(abs).size > MAX_GREP_BYTES) continue;
          const buf = readFileSync(abs);
          if (looksBinary(buf)) continue;
          const lines = buf.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < max; i++) {
            const line = lines[i]!;
            if (!re.test(line)) continue;
            hits.push(`${r}:${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)}...` : line}`);
          }
        } catch {
          // 单个文件读取失败不影响整体搜索
        }
      }
    };
    walk(root, "");
    if (!hits.length) return { text: "(没有匹配)" };
    const capped = hits.length >= max ? `\n\n(已截断,只显示前 ${max} 条)` : "";
    return { text: hits.join("\n") + capped };
  },
};

// 编辑:先按原文精确替换。CRLF 文件先统一成 LF 再匹配,写回时保持原文件的换行风格
const editFileTool: AgentTool = {
  def: {
    name: "edit_file",
    description: "在文件中精确替换一段文本。old_string 必须与文件内容完全一致(不要带行号前缀)。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区相对路径" },
        old_string: { type: "string", description: "要被替换的原文;为空且文件不存在时新建" },
        new_string: { type: "string", description: "替换后的内容" },
        replace_all: { type: "boolean", description: "替换所有匹配,默认只替换唯一一处" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  perm: (a) => ({ kind: "Edit", tool: "edit_file", path: arg(a, "path") }),
  async run(a, ctx) {
    const rel = arg(a, "path");
    const oldStr = String(a.old_string ?? "");
    const newStr = String(a.new_string ?? "");
    const replaceAll = a.replace_all === true;
    const abs = assertInside(ctx.workspace, rel);
    const exists = existsSync(abs);

    // 新建:old_string 为空且文件不存在
    if (!oldStr && !exists) {
      writeTool(ctx.workspace, rel, newStr);
      return { text: `已新建 ${rel}(${newStr.split(/\r?\n/).length} 行)`, display: `+ ${rel}` };
    }
    if (!exists) throw new ToolError(`文件不存在:${rel}(新建请把 old_string 留空)`);
    if (!oldStr) throw new ToolError("old_string 不能为空(整体覆盖请用 write_file)");

    const buf = readFileSync(abs);
    if (looksBinary(buf)) throw new ToolError(`${rel} 是二进制文件,无法编辑`);
    const original = buf.toString("utf8");
    const crlf = original.includes("\r\n");
    const normalized = crlf ? original.replace(/\r\n/g, "\n") : original;
    const target = oldStr.replace(/\r\n/g, "\n");

    const count = normalized.split(target).length - 1;
    if (count === 0) {
      throw new ToolError(
        `在 ${rel} 中找不到 old_string。请确认:1) 不要带 read_file 的行号前缀;2) 缩进与空白完全一致;3) 内容没有被其他修改改动过。`,
      );
    }
    if (count > 1 && !replaceAll) {
      throw new ToolError(`old_string 在 ${rel} 中出现 ${count} 次,不唯一。请补充更多上下文使其唯一,或设置 replace_all=true。`);
    }
    const next = replaceAll ? normalized.split(target).join(newStr) : normalized.replace(target, newStr);
    const out = crlf ? next.replace(/\n/g, "\r\n") : next;
    writeTool(ctx.workspace, rel, out);

    const removed = replaceAll ? count * target.split("\n").length : target.split("\n").length;
    const added = replaceAll ? count * newStr.split("\n").length : newStr.split("\n").length;
    const diff = [
      ...target.split("\n").slice(0, 20).map((l) => `- ${l}`),
      ...newStr.split("\n").slice(0, 20).map((l) => `+ ${l}`),
    ].join("\n");
    return {
      text: `已修改 ${rel}(${replaceAll ? `${count} 处` : "1 处"},-${removed} +${added} 行)`,
      display: diff,
    };
  },
};

const writeFileTool: AgentTool = {
  def: {
    name: "write_file",
    description: "新建文件或整体覆盖已有文件。小范围修改请优先用 edit_file。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区相对路径" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
  },
  perm: (a) => ({ kind: "Write", tool: "write_file", path: arg(a, "path") }),
  async run(a, ctx) {
    const rel = arg(a, "path");
    const content = String(a.content ?? "");
    const existed = existsSync(assertInside(ctx.workspace, rel));
    const r = writeTool(ctx.workspace, rel, content);
    const lines = content.split(/\r?\n/).length;
    return {
      text: `${existed ? "已覆盖" : "已新建"} ${r.path}(${lines} 行,${r.bytes}B)`,
      display: `${existed ? "~" : "+"} ${r.path}`,
    };
  },
};

const bashTool: AgentTool = {
  def: {
    name: "bash",
    description: "在工作区执行 shell 命令并返回输出。写操作与非常用命令可能需要用户确认。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        timeout_ms: { type: "number", description: "超时毫秒数,默认 10 分钟" },
      },
      required: ["command"],
    },
  },
  perm: (a) => ({ kind: "Bash", tool: "bash", command: arg(a, "command") }),
  async run(a, ctx) {
    const command = arg(a, "command");
    // 权限已在外层判定;这里传 confirmed 只表示"已经过规则检查",不代表跳过规则
    const r = await shellExec({
      workspace: ctx.workspace,
      command,
      confirmed: true,
      ...(a.timeout_ms ? { timeoutMs: numArg(a, "timeout_ms", 600_000) } : {}),
      signal: ctx.signal,
      onData: (chunk) => ctx.onOutput?.(chunk),
    });
    const parts = [`exit code: ${r.exitCode}${r.timedOut ? " (超时)" : ""}`];
    if (r.stdout) parts.push(r.stdout);
    if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
    return {
      text: parts.join("\n"),
      ...(r.stderr && !r.stdout ? { display: r.stderr } : {}),
      isError: r.exitCode !== 0,
      exitCode: r.exitCode,
    };
  },
};

const gitStatusTool: AgentTool = {
  def: {
    name: "git_status",
    description: "查看当前仓库的 git 状态(等价于 git status --short --branch)。",
    parameters: { type: "object", properties: {} },
  },
  perm: () => ({ kind: "Read", tool: "git_status" }),
  async run(_a, ctx) {
    const r = await gitExec(ctx.workspace, ["status", "--short", "--branch"]);
    return { text: r.stdout.trim() || "(工作区干净)" };
  },
};

const gitDiffTool: AgentTool = {
  def: {
    name: "git_diff",
    description: "查看改动内容。staged 为真时看已暂存的部分。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "限定文件或目录" },
        staged: { type: "boolean", description: "只看已暂存的改动" },
      },
    },
  },
  perm: () => ({ kind: "Read", tool: "git_diff" }),
  async run(a, ctx) {
    const args = ["diff"];
    if (a.staged === true) args.push("--cached");
    const p = arg(a, "path");
    if (p) args.push("--", p);
    const r = await gitExec(ctx.workspace, args);
    return { text: r.stdout.trim() || "(没有改动)" };
  },
};

export const ALL_TOOLS: AgentTool[] = [
  readFileTool, listFilesTool, grepTool, editFileTool, writeFileTool, bashTool, gitStatusTool, gitDiffTool,
];

// B3:MCP 工具转成 AgentTool。权限类型为 Mcp,默认需要确认;
// 规则形如 mcp__github__* / mcp__github__create_issue 由 permissions.ts 处理
export function mcpAgentTools(
  tools: Array<{ name: string; originalName: string; server: string; description: string; inputSchema: object }>,
  call: (server: string, toolName: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>,
): AgentTool[] {
  return tools.map((t) => ({
    def: { name: t.name, description: t.description || `MCP 工具 ${t.originalName}`, parameters: t.inputSchema },
    perm: () => ({ kind: "Mcp" as const, tool: t.name }),
    async run(args, ctx) {
      const text = await call(t.server, t.originalName, args, ctx.signal);
      return { text };
    },
  }));
}

const READONLY_NAMES = new Set(["read_file", "list_files", "grep", "git_status", "git_diff"]);

// 按会话模式下发工具:code 全部,work 只读,chat 不给
export function toolsForMode(mode: string, all: AgentTool[] = ALL_TOOLS): AgentTool[] {
  if (mode === "code") return all;
  if (mode === "work") return all.filter((t) => READONLY_NAMES.has(t.def.name));
  return [];
}

export function toolByName(name: string, all: AgentTool[] = ALL_TOOLS): AgentTool | undefined {
  return all.find((t) => t.def.name === name);
}

// ---- BlockBuilder:块状态与事件 ----

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

const OUTPUT_FLUSH_MS = 80; // 流式输出合并节流

export class BlockBuilder {
  readonly blocks: ChatBlock[] = [];
  private open: { kind: "text" | "thinking" | "tool"; id: string; text: string; t0: number; idx: number } | null = null;
  private seq = 0;
  private emit: (obj: unknown) => void;
  private pending = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(emit: (obj: unknown) => void) {
    this.emit = emit;
  }

  send(obj: unknown): void {
    this.emit(obj);
  }

  closeOpen(): void {
    const b = this.open;
    if (!b) return;
    this.open = null;
    if (b.kind === "thinking") {
      const block: ChatBlock = { id: b.id, kind: "thinking", text: b.text, durationMs: Date.now() - b.t0 };
      this.blocks[b.idx] = block;
      this.send({ type: "block_end", id: b.id, block });
    } else if (b.kind === "text") {
      const block: ChatBlock = { id: b.id, kind: "text", text: b.text };
      this.blocks[b.idx] = block;
      this.send({ type: "block_end", id: b.id, block });
    }
  }

  text(): { text: string; id: string; idx: number } {
    if (this.open?.kind === "text") return this.open;
    this.closeOpen();
    this.seq += 1;
    const block: ChatBlock = { id: `t${this.seq}`, kind: "text", text: "" };
    const idx = this.blocks.push(block) - 1;
    this.open = { kind: "text", id: block.id, text: "", t0: Date.now(), idx };
    this.send({ type: "block", id: block.id, block: { kind: "text" } });
    return this.open;
  }

  appendText(delta: string): void {
    const o = this.text();
    o.text += delta;
    const cur = this.blocks[o.idx];
    if (cur?.kind === "text") cur.text = o.text;
    this.send({ delta, id: o.id });
  }

  thinking(delta: string): void {
    if (this.open?.kind !== "thinking") {
      this.closeOpen();
      this.seq += 1;
      const id = `r${this.seq}`;
      const idx = this.blocks.push({ id, kind: "thinking", text: "" }) - 1;
      this.open = { kind: "thinking", id, text: "", t0: Date.now(), idx };
      this.send({ type: "block", id, block: { kind: "thinking" } });
    }
    this.open.text += delta;
    const cur = this.blocks[this.open.idx];
    if (cur?.kind === "thinking") cur.text = this.open.text;
    this.send({ type: "block_delta", id: this.open.id, delta });
  }

  // 新增工具块。id 由调用方给(已做跨步去重),避免各协议重复的 call_0 冲突
  addTool(id: string, name: string): ToolBlock {
    this.closeOpen();
    const block: ToolBlock = { id, kind: "tool", name, rawArgs: "", status: "pending" };
    this.blocks.push(block);
    this.open = { kind: "tool", id, text: "", t0: Date.now(), idx: this.blocks.length - 1 };
    this.send({ type: "block", id, block: { kind: "tool", name, status: "pending" } });
    return block;
  }

  tool(id: string): ToolBlock | undefined {
    return this.blocks.find((b): b is ToolBlock => b.kind === "tool" && b.id === id);
  }

  appendArgs(id: string, delta: string): void {
    const b = this.tool(id);
    if (b) b.rawArgs += delta;
    this.send({ type: "block_delta", id, delta });
  }

  // 状态变化后发一次快照;前端按 id 覆盖,同一块可以发多次
  update(id: string): void {
    const b = this.tool(id);
    if (!b) return;
    if (this.open?.kind === "tool" && this.open.id === id) this.open = null;
    this.send({ type: "block_end", id, block: b });
  }

  setStatus(id: string, status: ToolStatus, patch: Partial<ToolBlock> = {}): void {
    const b = this.tool(id);
    if (!b) return;
    Object.assign(b, patch, { status });
    this.update(id);
  }

  // 流式输出:按 80ms 合并,避免高频小分片刷爆事件缓存
  output(id: string, chunk: string): void {
    const b = this.tool(id);
    if (!b) return;
    b.output = `${b.output ?? ""}${chunk}`.slice(-64 * 1024);
    this.pending.set(id, `${this.pending.get(id) ?? ""}${chunk}`);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const [bid, delta] of this.pending) this.send({ type: "tool_output", id: bid, delta });
      this.pending.clear();
    }, OUTPUT_FLUSH_MS);
    this.timer.unref?.();
  }

  flushOutput(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [bid, delta] of this.pending) this.send({ type: "tool_output", id: bid, delta });
    this.pending.clear();
  }

  // 中断收尾:未结束的工具标成已中断
  closeUnfinished(note = "已中断"): void {
    for (const b of this.blocks) {
      if (b.kind !== "tool") continue;
      if (b.status === "pending" || b.status === "awaiting" || b.status === "running") {
        b.status = "error";
        b.note = note;
        this.send({ type: "block_end", id: b.id, block: b });
      }
    }
    this.open = null;
  }

  textOf(): string {
    return this.blocks
      .filter((b): b is Extract<ChatBlock, { kind: "text" }> => b.kind === "text")
      .map((b) => b.text)
      .join("");
  }
}

// 工具调用的单行摘要,下一轮装历史时附在 assistant 内容后
export function toolDigest(blocks: ChatBlock[]): string {
  const tools = blocks.filter((b): b is ToolBlock => b.kind === "tool");
  if (!tools.length) return "";
  return tools
    .map((b) => {
      const a = (b.args ?? {}) as Record<string, unknown>;
      const target = typeof a.path === "string" ? a.path : typeof a.command === "string" ? a.command : "";
      const status = b.status === "success" ? "" : ` [${b.status}]`;
      return `${b.name}${target ? ` ${target.slice(0, 120)}` : ""}${status}`;
    })
    .join("; ");
}

// ---- 运行循环 ----

export interface ConfirmRequest {
  blockId: string;
  name: string;
  args: Record<string, unknown>;
  rule: string;
  reason: string;
}

export interface RunAgentOptions {
  provider: ChatProvider;
  messages: ChatMessage[];
  tools: AgentTool[];
  workspace: string;
  signal: AbortSignal;
  builder: BlockBuilder;
  homeDir?: string;
  maxSteps?: number;
  confirm?: (req: ConfirmRequest) => Promise<ToolDecision>;
  // 子任务没有确认通道时的兜底:返回 allow / deny
  policy?: (req: ConfirmRequest) => ToolDecision;
  onToolEnd?: (info: { name: string; status: ToolStatus; args: Record<string, unknown>; exitCode?: number }) => void;
  // L1:写操作或非只读命令执行前拍快照,返回的 sha 记到工具块上
  beforeWrite?: (info: { name: string; args: Record<string, unknown> }) => Promise<string | null>;
  // L5:跨厂商回退链。只在首步、尚无任何输出时生效,按顺序尝试下一个模型。
  fallbacks?: ChatProvider[];
  onFallback?: (info: { from: string; to: string; reason: string }) => void;
}

// 可以换模型重试的错误:限流、配额、服务端 5xx、网络中断。
// 400 / 413 / 上下文超长不换:换一家也救不回来,还会掩盖真实原因。
const NON_RETRYABLE_RE = /(400|413|context.{0,24}(length|window|too long)|maximum context|too many tokens)/i;
const RETRYABLE_RE =
  /(429|5\d\d|rate.?limit|quota|overloaded|too many requests|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network)/i;

export function isRetryableModelError(msg: string): boolean {
  if (NON_RETRYABLE_RE.test(msg)) return false;
  return RETRYABLE_RE.test(msg);
}

export interface RunAgentResult {
  finishReason: string | null;
  usage: TokenUsage | null;
  steps: number;
  finalText: string;
  // 实际完成本次运行的模型(发生回退时与传入的不同),用于落库模型名与记账
  provider: ChatProvider;
}

// 各协议的工具调用 id 跨步可能重复(Gemini 每步都是 call_0),块 id 与回传模型的 wireId 分开
let blockSeq = 0;

interface PendingCall {
  blockId: string;
  wireId: string;
  name: string;
  argsText: string;
}

export async function runAgent(o: RunAgentOptions): Promise<RunAgentResult> {
  const maxSteps = o.maxSteps ?? 30;
  const messages = [...o.messages];
  const toolDefs = o.tools.map((t) => t.def);
  let usage: TokenUsage | null = null;
  let steps = 0;
  let finishReason: string | null = null;
  let finalText = "";
  let sawAnyOutput = false;
  let useTools = toolDefs.length > 0;
  let retriedWithoutTools = false;
  // L5:当前生效的模型与尚未尝试的回退链
  let provider = o.provider;
  const fallbacks = [...(o.fallbacks ?? [])];

  for (let step = 0; step < maxSteps; step++) {
    if (o.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    steps += 1;

    const calls: PendingCall[] = [];
    const rawParts: Array<{ protocol: ProviderProtocol; content: unknown }> = [];
    let stepText = "";
    let stepUsage: TokenUsage | null = null;
    let stepFinish: string | null = null;

    // 每步都按当前 provider 取流:回退后从下一步起走新模型
    const cur = provider;
    const iter = cur.streamEvents
      ? cur.streamEvents(messages, { signal: o.signal, ...(useTools ? { tools: toolDefs } : {}) })
      : (async function* (): AsyncIterable<ProviderEvent> {
          for await (const d of cur.streamChat(messages, { signal: o.signal })) yield { type: "text", delta: d };
        })();

    // 与中断竞速:Provider 不响应 signal 时也能立即收尾落库,不把流挂死
    const interrupted = new Promise<{ aborted: true }>((resolve) => {
      const onAbort = () => resolve({ aborted: true });
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener("abort", onAbort, { once: true });
    });
    const it = iter[Symbol.asyncIterator]();

    try {
      for (;;) {
        const step = o.signal.aborted ? ({ aborted: true } as const) : await Promise.race([it.next(), interrupted]);
        if ("aborted" in step) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (step.done) break;
        const ev = step.value;
        switch (ev.type) {
          case "text":
            o.builder.appendText(ev.delta);
            stepText += ev.delta;
            sawAnyOutput = true;
            break;
          case "thinking":
            o.builder.thinking(ev.delta);
            sawAnyOutput = true;
            break;
          case "tool_start": {
            blockSeq += 1;
            const blockId = `tc${blockSeq}`;
            o.builder.addTool(blockId, ev.name);
            calls.push({ blockId, wireId: ev.id, name: ev.name, argsText: "" });
            break;
          }
          case "tool_args": {
            const c = calls.find((x) => x.wireId === ev.id);
            if (c) {
              c.argsText += ev.delta;
              o.builder.appendArgs(c.blockId, ev.delta);
            }
            break;
          }
          case "tool_end": {
            const c = calls.find((x) => x.wireId === ev.id);
            if (c) {
              c.argsText = ev.args;
              const b = o.builder.tool(c.blockId);
              if (b) b.rawArgs = ev.args;
            }
            break;
          }
          case "raw":
            rawParts.push({ protocol: ev.protocol, content: ev.content });
            break;
          case "usage":
            stepUsage = ev.usage;
            break;
          case "finish":
            stepFinish = ev.reason;
            break;
        }
      }
    } catch (e) {
      // 中断后不再消费 Provider;主动关闭迭代器,让上游连接释放
      if (o.signal.aborted) void it.return?.();
      // 首步、尚无输出、带了工具却报 400/422:网关不支持 function calling,去掉工具重试一次
      const msg = e instanceof Error ? e.message : String(e);
      if (step === 0 && !sawAnyOutput && useTools && !retriedWithoutTools && /400|422/.test(msg)) {
        retriedWithoutTools = true;
        useTools = false;
        steps -= 1;
        step = -1; // 回到第 0 步重来
        continue;
      }
      // L5:首步、尚无输出时按回退链换模型;已出过内容就不再换,避免半截回答拼接两个模型
      if (step === 0 && !sawAnyOutput && fallbacks.length && isRetryableModelError(msg)) {
        const from = provider.config.model || provider.config.id;
        const next = fallbacks.shift()!;
        const to = next.config.model || next.config.id;
        provider = next;
        // 新模型的工具能力可能不同:没有 streamEvents 就当纯对话
        if (!next.streamEvents) useTools = false;
        o.onFallback?.({ from, to, reason: msg.slice(0, 200) });
        steps -= 1;
        step = -1;
        continue;
      }
      throw e;
    }

    o.builder.closeOpen();
    finishReason = stepFinish;

    // 累计用量:多步求和,单步保持原样(旧测试精确比较单步)
    if (stepUsage) {
      usage = usage
        ? {
            promptTokens: usage.promptTokens + stepUsage.promptTokens,
            completionTokens: usage.completionTokens + stepUsage.completionTokens,
            totalTokens: usage.totalTokens + stepUsage.totalTokens,
            ...((usage.cachedTokens ?? 0) + (stepUsage.cachedTokens ?? 0) > 0
              ? { cachedTokens: (usage.cachedTokens ?? 0) + (stepUsage.cachedTokens ?? 0) }
              : {}),
            ...((usage.reasoningTokens ?? 0) + (stepUsage.reasoningTokens ?? 0) > 0
              ? { reasoningTokens: (usage.reasoningTokens ?? 0) + (stepUsage.reasoningTokens ?? 0) }
              : {}),
          }
        : stepUsage;
      usage.steps = steps;
      usage.contextTokens = stepUsage.promptTokens + stepUsage.completionTokens;
      o.builder.send({ type: "usage", usage });
    }

    // 没有工具调用:本步结束
    if (!calls.length) {
      finalText = stepText;
      break;
    }

    // 本步有工具调用:先把 assistant 消息(含 toolCalls 与 raw)压进请求
    const parsed = calls.map((c) => {
      let args: Record<string, unknown> = {};
      let argsError: string | undefined;
      try {
        const v = JSON.parse(c.argsText || "{}") as unknown;
        if (v && typeof v === "object" && !Array.isArray(v)) args = v as Record<string, unknown>;
        else argsError = "参数必须是 JSON 对象";
      } catch (e) {
        argsError = e instanceof Error ? e.message : "参数解析失败";
      }
      return { ...c, args, argsError };
    });

    // 没有下发工具却收到调用:保持旧行为(卡片 pending + 兜底文字)
    if (!useTools) {
      for (const c of parsed) {
        const b = o.builder.tool(c.blockId);
        if (b) {
          b.rawArgs = c.argsText;
          if (c.argsError) {
            b.argsError = c.argsError;
            b.status = "error";
          } else {
            b.args = c.args;
            b.status = "pending";
          }
          o.builder.update(c.blockId);
        }
      }
      // 仅在没有正文时补兜底文字,保证 content 非空(与旧行为一致)
      if (!stepText.trim()) {
        const note = "（模型请求调用工具，当前会话未开放工具。）";
        o.builder.appendText(note);
        stepText += note;
      }
      finalText = stepText;
      finishReason = stepFinish ?? "tool_calls";
      break;
    }

    const toolCalls: ToolCall[] = parsed.map((c) => ({ id: c.wireId, name: c.name, args: c.argsText }));
    const raw = rawParts.length === 1 ? rawParts[0] : undefined;
    messages.push({
      role: "assistant",
      content: stepText,
      toolCalls,
      ...(raw ? { raw } : {}),
    });

    const rules = loadPermissions(o.workspace, { homeDir: o.homeDir ?? homedir() });
    for (const c of parsed) {
      const tool = toolByName(c.name, o.tools);
      if (c.argsError) {
        o.builder.setStatus(c.blockId, "error", { argsError: c.argsError, note: "参数无效", result: `参数无效:${c.argsError}` });
        messages.push({ role: "tool", toolCallId: c.wireId, toolName: c.name, content: `参数无效:${c.argsError}`, toolError: true });
        o.onToolEnd?.({ name: c.name, status: "error", args: {} });
        continue;
      }
      if (!tool) {
        const note = `未知工具:${c.name}`;
        o.builder.setStatus(c.blockId, "error", { note, result: note });
        messages.push({ role: "tool", toolCallId: c.wireId, toolName: c.name, content: note, toolError: true });
        o.onToolEnd?.({ name: c.name, status: "error", args: c.args });
        continue;
      }
      // target 由服务端填写(工作区 + 校验过的路径)
      const target: ToolBlock["target"] = { workspace: o.workspace };
      const p = c.args.path;
      if (typeof p === "string") {
        try {
          assertInside(o.workspace, p);
          target.path = p;
        } catch {
          // 越界路径不填 target.path
        }
      }
      const b = o.builder.tool(c.blockId);
      if (b) {
        b.args = c.args;
        b.target = target;
        o.builder.update(c.blockId);
      }

      const req = tool.perm(c.args);
      const verdict = decide(rules, req);

      if (verdict.decision === "deny") {
        const note = `已拒绝:${verdict.reason}`;
        o.builder.setStatus(c.blockId, "rejected", { note, result: note });
        messages.push({ role: "tool", toolCallId: c.wireId, toolName: c.name, content: note, toolError: true });
        o.onToolEnd?.({ name: c.name, status: "rejected", args: c.args });
        continue;
      }

      if (verdict.decision === "ask") {
        const rule = suggestRule(req);
        const reason = verdict.reason;
        if (o.confirm) {
          o.builder.setStatus(c.blockId, "awaiting", { rule, reason });
          let decision: ToolDecision;
          try {
            decision = await o.confirm({ blockId: c.blockId, name: c.name, args: c.args, rule, reason });
          } catch {
            decision = "deny";
          }
          if (decision === "deny") {
            const note = "用户拒绝了该操作,不要重复尝试,询问用户希望怎么做";
            o.builder.setStatus(c.blockId, "rejected", { note, result: note, rule: undefined, reason: undefined });
            messages.push({ role: "tool", toolCallId: c.wireId, toolName: c.name, content: note, toolError: true });
            o.onToolEnd?.({ name: c.name, status: "rejected", args: c.args });
            continue;
          }
          if (decision === "always") {
            try {
              addAllowRule(o.workspace, rule);
            } catch (e) {
              // 规则写入失败不阻塞本次执行,但要在结果里告知
              const warn = e instanceof Error ? e.message : String(e);
              o.builder.setStatus(c.blockId, "running", { note: `规则写入失败:${warn}` });
            }
          }
          o.builder.setStatus(c.blockId, "running", { rule: undefined, reason: undefined });
        } else if (o.policy) {
          const decision = o.policy({ blockId: c.blockId, name: c.name, args: c.args, rule, reason });
          if (decision === "deny") {
            const note = "当前环境无法交互确认,已拒绝该操作";
            o.builder.setStatus(c.blockId, "rejected", { note, result: note });
            messages.push({ role: "tool", toolCallId: c.wireId, toolName: c.name, content: note, toolError: true });
            o.onToolEnd?.({ name: c.name, status: "rejected", args: c.args });
            continue;
          }
          o.builder.setStatus(c.blockId, "running", { rule: undefined, reason: undefined });
        } else {
          const note = "当前环境无法确认该操作,已跳过";
          o.builder.setStatus(c.blockId, "rejected", { note, result: note });
          messages.push({ role: "tool", toolCallId: c.wireId, toolName: c.name, content: note, toolError: true });
          o.onToolEnd?.({ name: c.name, status: "rejected", args: c.args });
          continue;
        }
      } else {
        o.builder.setStatus(c.blockId, "running");
      }

      // L1:写类工具与可能改文件的命令执行前拍快照
      const WRITE_TOOLS = new Set(["edit_file", "write_file"]);
      if (o.beforeWrite && (WRITE_TOOLS.has(c.name) || c.name === "bash")) {
        try {
          const sha = await o.beforeWrite({ name: c.name, args: c.args });
          if (sha) {
            const tb = o.builder.tool(c.blockId);
            if (tb) {
              tb.checkpoint = sha;
              o.builder.update(c.blockId);
            }
          }
        } catch {
          // 快照失败不阻塞工具执行
        }
      }

      const t0 = Date.now();
      try {
        const outcome = await tool.run(c.args, {
          workspace: o.workspace,
          signal: o.signal,
          onOutput: (chunk) => o.builder.output(c.blockId, chunk),
        });
        o.builder.flushOutput();
        const text = truncateMiddle(outcome.text);
        o.builder.setStatus(c.blockId, outcome.isError ? "error" : "success", {
          result: truncateMiddle(outcome.display ?? outcome.text, MAX_RESULT_DISPLAY),
          output: undefined,
          exitCode: outcome.exitCode,
          durationMs: Date.now() - t0,
        });
        messages.push({ role: "tool", toolCallId: c.wireId, toolName: c.name, content: text, ...(outcome.isError ? { toolError: true } : {}) });
        o.onToolEnd?.({ name: c.name, status: outcome.isError ? "error" : "success", args: c.args, exitCode: outcome.exitCode });
      } catch (e) {
        o.builder.flushOutput();
        if (o.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const msg = e instanceof Error ? e.message : String(e);
        o.builder.setStatus(c.blockId, "error", { result: msg, output: undefined, durationMs: Date.now() - t0 });
        messages.push({ role: "tool", toolCallId: c.wireId, toolName: c.name, content: `执行失败:${msg}`, toolError: true });
        o.onToolEnd?.({ name: c.name, status: "error", args: c.args });
      }
    }

    // 达到上限时给出继续提示
    if (step === maxSteps - 1) {
      const note = `\n\n(已达到单轮工具调用上限 ${maxSteps} 步,回复"继续"可接着执行)`;
      o.builder.appendText(note);
      stepText += note;
    }
    finalText = stepText;
  }

  return { finishReason, usage, steps, finalText, provider };
}
