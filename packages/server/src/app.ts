import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { estimateTokens, modelsOf, pricingOf, type AgentRole, type ChatBlock, type ChatMessage, type ProviderConfig, type SessionMeta, type TaskStatus, type TokenUsage, type ToolDecision } from "@xiyun/shared";
import type { ChatProvider, ProviderEvent, ToolDef } from "../../runtime/src/index.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";
import { assertInside, loadRuleFiles } from "./workspace.ts";
import { extractMemories } from "./extract.ts";
import { runMemoryTool } from "./memchat.ts";
import { WorkStore } from "./docs.ts";
import { SkillStore } from "./skills.ts";
import { MAX_GROUP_TASKS, Scheduler, TaskEventBus, TaskStore } from "./tasks.ts";
import { cheapestPriced, UsageLedger, type UsageGroupBy } from "./usage.ts";
import {
  createPullRequest, mergeBranch, pushBranch, remoteUrl, removeWorktree,
} from "./worktree.ts";
import { detectShells, gitCommit, gitPreview, listTool, readTool, shellExec, writeTool } from "./tools.ts";
import { DATA_DIR, backupDb } from "./db.ts";
import { DEFAULT_TITLE, generateTitle, heuristicTitle } from "./title.ts";
import { RunRegistry, type Run } from "./runs.ts";
import { searchMessages } from "./search.ts";
import { ancestors, ensureTree, loadTree, pathIds, setHeadId, siblingsOf, switchHead } from "./tree.ts";
import {
  contextBudget, fileHash, IMAGE_TOKENS, MESSAGE_OVERHEAD, planHistory, summarize, summaryBatch, withAttachments,
  withRefContext, type PathMessage,
} from "./context.ts";
import { AttachmentError, AttachmentStore, MAX_PER_MESSAGE, TEXT_INJECT_CHARS } from "./attachments.ts";
import { parseExternal, type ExternalConversation, type ExternalSource } from "./external.ts";
import { BlockBuilder, mcpAgentTools, runAgent, toolDigest, toolsForMode } from "./agent.ts";
import { CheckpointStore } from "./checkpoints.ts";
import {
  applyClaudeDesktopImport, effectiveConfig, isProjectTrusted, loadProjectConfig, loadUserConfig, McpManager,
  previewClaudeDesktopImport, revokeProjectTrust, saveUserConfig, trustProject,
} from "./mcp.ts";
import { addAllowRule, decide, loadPermissions, suggestRule } from "./permissions.ts";
import { convertToText, isConvertible } from "./convert.ts";
import { MemoryJobRunner } from "./memory-jobs.ts";

const now = () => new Date().toISOString();

// opts.chatProvider 仅用于测试注入;缺省仍走 ProviderStore。
export function createApp(
  db: DatabaseSync,
  memory: MemoryStore,
  providers: ProviderStore,
  // titleProvider:会话自动命名用的模型;summaryProvider:早先消息的滚动摘要(F4)。缺省同记忆提取(测试可注入)
  opts?: {
    chatProvider?: () => ChatProvider;
    titleProvider?: () => ChatProvider | undefined;
    summaryProvider?: () => ChatProvider | undefined;
    // 记忆提取用的模型(测试可注入);缺省按 memory 角色 → main → 激活顺序取
    memoryProvider?: () => ChatProvider | undefined;
    dataDir?: string; // 附件存放目录的上级(缺省 DATA_DIR;测试用临时目录)
    // L1:工作区快照。缺省按 dataDir 建;测试可注入 skipGuards 跳过 home / 根目录与文件数检查
    checkpoints?: CheckpointStore;
  },
) {
  const app = new Hono();
  // CORS 白名单:只放行本机来源(localhost/127.0.0.1/[::1] 的 http(s),覆盖 vite 5173 与桌面渲染器)。
  // 无 Origin 头(非浏览器/curl/Electron 主进程)不写 ACAO 也照常放行;外部来源与 "null"(file:// 沙箱页面)
  // 返回 undefined,响应不含 Access-Control-Allow-Origin,预检同样不通过,由浏览器拦截。
  app.use("*", cors({ origin: (o) => (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o) ? o : undefined) }));

  const taskStore = new TaskStore(db);
  // L5:成本账本(主对话 + 子任务共用一个库)
  const usageLedger = new UsageLedger(db);
  // B2:附件。启动时清理一天前上传、但没有随任何消息发出的附件
  const attachments = new AttachmentStore(db, opts?.dataDir ?? DATA_DIR);
  // L1:工作区快照(影子仓库,不碰用户的 .git)
  const checkpoints = opts?.checkpoints ?? new CheckpointStore({ dataDir: opts?.dataDir ?? DATA_DIR });
  // B3:MCP 客户端(惰性连接,首次用到工具时才启动)
  const mcp = new McpManager();
  try {
    attachments.prune();
  } catch {
    // 清理失败不影响启动
  }
  const work = new WorkStore(db);
  const skills = new SkillStore(db, DATA_DIR);
  // L4:任务事件总线,供 GET /tasks/:id/events 实时推送
  const taskEvents = new TaskEventBus();
  const scheduler = new Scheduler({
    store: taskStore,
    memory,
    registry: () => providers.registry(),
    skillsFor: (mode, role, query) => skills.promptFor(mode, role, query),
    // L5:子任务用量同样记账
    usage: (entry) => usageLedger.record(entry),
    onEvent: (type, payload) => {
      const r = db
        .prepare("INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)")
        .run(type, JSON.stringify(payload), now());
      // L4:任务事件同步推给订阅者(前端可实时看每步工具与状态变化)
      const taskId = (payload as { taskId?: string } | null)?.taskId;
      if (taskId) taskEvents.publish(taskId, { id: Number(r.lastInsertRowid), type, payload, createdAt: now() });
    },
  });
  // 启动恢复:上次中断的 queued/running 任务重新拉起。
  const recovered = scheduler.recover();
  if (recovered > 0)
    db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('task.recovered', ?, ?)").run(
      JSON.stringify({ count: recovered }), now(),
    );

  // F1:生成运行注册表。生成在后台执行,HTTP 连接只是订阅者
  const runs = new RunRegistry();
  // 把 Run 的事件写给当前连接:先回放 after 之后的事件再实时推送,Run 结束即关闭;连接断开只取消订阅。
  // SSE 写按序入队、不阻塞:客户端停止读取时 writeSSE 会一直挂着,断开后不再等待队列。
  const streamRun = (c: Context, run: Run, after = 0) =>
    streamSSE(c, async (stream) => {
      let queue: Promise<unknown> = Promise.resolve();
      let end!: () => void;
      const ended = new Promise<void>((r) => (end = r));
      const gone = () => end();
      stream.onAbort(gone);
      if (c.req.raw.signal.aborted) gone();
      c.req.raw.signal.addEventListener("abort", gone, { once: true });
      const unsub = run.subscribe(
        (e) => {
          queue = queue.then(() => stream.writeSSE({ id: String(e.seq), data: e.data })).catch(() => {});
        },
        gone,
        after,
      );
      await ended;
      unsub();
      if (!c.req.raw.signal.aborted) await queue;
    });

  // 会话最近活动时间:新消息落库时刷新,列表据此排序
  const touchSession = (id: string) => db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), id);

  // 记忆提取专用 Provider:memory 角色优先,回退 main/激活。未配置则不提取。
  const memoryProvider = () =>
    opts?.memoryProvider?.() ??
    providers.registry().byRole("memory") ??
    providers.registry().byRole("main") ??
    providers.activeProvider();

  // 回复完成后异步提取候选记忆,不阻塞 SSE;失败只记事件(R-004:低置信度只进候选区)。
  const queueExtract = (sessionId: string, mode: string, workspace: string) => {
    const provider = memoryProvider();
    if (!provider) return;
    // 只看当前分支的最近 12 条(F6)
    const history = rowsByIds(pathIds(loadTree(db, sessionId)).slice(-12)).map(
      (r) => ({ role: r.role, content: r.content }) as ChatMessage,
    );
    const existingFacts = memory.list().map((f) => f.content);
    void extractMemories({ provider, memory, history, sessionId, mode, workspace, existingFacts })
      .then((n) => {
        if (n > 0)
          db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('memory.extract', ?, ?)").run(
            JSON.stringify({ sessionId, candidates: n }), now(),
          );
      })
      .catch((e) => {
        db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('memory.extract.failed', ?, ?)").run(
          JSON.stringify({ sessionId, error: e instanceof Error ? e.message : String(e) }), now(),
        );
      });
  };

  // F4:滚动摘要。本轮有早先消息超出预算未带入、且摘要还没覆盖到它们时,后台把未覆盖的部分并入摘要。
  // 一次最多处理 SUMMARY_INPUT_CHARS,剩余的在之后几轮继续补齐;同一会话同时只跑一个
  const summarizing = new Set<string>();
  const queueSummary = (
    sessionId: string,
    dropped: PathMessage[],
    prev: { summary: string | null; summary_upto_id: number | null } | null,
  ) => {
    const from = prev?.summary_upto_id ?? 0;
    const pending = dropped.filter((m) => m.id > from);
    if (!pending.length || summarizing.has(sessionId)) return;
    const provider = opts?.summaryProvider ? opts.summaryProvider() : memoryProvider();
    if (!provider) return;
    const batch = summaryBatch(pending);
    const upto = batch[batch.length - 1]!.id;
    summarizing.add(sessionId);
    void summarize(provider, prev?.summary ?? "", batch)
      .then((text) => {
        if (!text) return;
        db.prepare("UPDATE sessions SET summary = ?, summary_upto_id = ? WHERE id = ?").run(text, upto, sessionId);
        db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('context.summary', ?, ?)").run(
          JSON.stringify({ sessionId, upto, messages: batch.length }), now(),
        );
      })
      .catch(() => {})
      .finally(() => summarizing.delete(sessionId));
  };

  app.get("/health", (c) => c.json({ ok: true }));

  // ---- Provider 配置(apiKey 不回显明文)----
  app.get("/providers", (c) => c.json(providers.listMasked()));
  app.post("/providers", async (c) => {
    const p = (await c.req.json()) as ProviderConfig;
    providers.upsert({ ...p, id: p.id || randomUUID() });
    return c.json({ ok: true });
  });
  app.delete("/providers/:id", (c) => {
    providers.removeProvider(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/providers/:id/activate", (c) => {
    providers.setActive(c.req.param("id"));
    return c.json({ ok: true });
  });
  // 连通性探测:发 1-token 请求验证 baseUrl/apiKey/model 可用,返回耗时。
  app.post("/providers/:id/probe", async (c) => {
    const p = providers.probeProvider(c.req.param("id"), c.req.query("model"));
    if (!p) return c.json({ error: "provider not found" }, 404);
    const t0 = Date.now();
    try {
      let got = "";
      for await (const d of p.streamChat([{ role: "user", content: "ping" }])) {
        got = d;
        break;
      }
      return c.json({ ok: true, latencyMs: Date.now() - t0, model: p.config.model });
    } catch (e) {
      return c.json({ ok: false, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : "probe failed" });
    }
  });

  // ---- L5:用量账本与设置 ----
  // groupBy:day|session|provider|model;from/to 为 ISO 日期(含端点)
  app.get("/usage", (c) => {
    const raw = c.req.query("groupBy") ?? "day";
    const groupBy: UsageGroupBy = raw === "session" || raw === "provider" || raw === "model" ? raw : "day";
    const { rows, total } = usageLedger.summary(groupBy, c.req.query("from"), c.req.query("to"));
    const s = providers.settings();
    return c.json({
      groupBy, rows, total,
      currency: s.currency ?? "USD",
      budget: s.dailyBudget ?? null,
      spentToday: usageLedger.spentToday(),
    });
  });
  app.get("/settings", (c) => c.json(providers.settings()));
  app.patch("/settings", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { dailyBudget?: number | null; currency?: string };
    return c.json(providers.updateSettings(b));
  });

  // 拉取服务商的模型列表(设置页"获取模型");失败返回可读错误
  app.get("/providers/:id/models", async (c) => {
    const p = providers.probeProvider(c.req.param("id"));
    if (!p) return c.json({ error: "provider not found" }, 404);
    if (!p.listModels) return c.json({ error: "该协议不支持获取模型列表" }, 400);
    try {
      return c.json({ models: (await p.listModels(AbortSignal.timeout(15_000))).sort() });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "获取失败" }, 502);
    }
  });

  // ---- 会话 ----
  // archived 查询参数:缺省/0 只返回未归档;1 只返回已归档;all 返回全部。
  // limit/offset 分页(默认全部返回,前端按需传);hasMore 指示是否还有下一页。
  app.get("/sessions", (c) => {
    const archived = c.req.query("archived") ?? "0";
    const limit = c.req.query("limit") ? Math.min(Number(c.req.query("limit")), 200) : null;
    const offset = Number(c.req.query("offset")) || 0;
    const where = archived === "all" ? "" : "WHERE archived = ?";
    const args = archived === "all" ? [] : [archived === "1" ? 1 : 0];
    const total = (db.prepare(`SELECT COUNT(*) c FROM sessions ${where}`).get(...args) as { c: number }).c;
    // 按最近活动排序:有新消息的会话浮到最前(D-019)
    const sql =
      `SELECT * FROM sessions ${where} ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC` +
      (limit ? " LIMIT ? OFFSET ?" : "");
    const rows = (limit
      ? db.prepare(sql).all(...args, limit, offset)
      : db.prepare(sql).all(...args)) as Array<Record<string, string | number>>;
    const live = runs.running();
    const list = rows.map((r) => ({
      id: r.id, title: r.title, mode: r.mode, workspace: r.workspace,
      createdAt: r.created_at, updatedAt: r.updated_at || r.created_at, archived: Number(r.archived) === 1,
      running: live.has(String(r.id)),
      providerId: (r.provider_id as string | null) ?? null, model: (r.model as string | null) ?? null,
    }));
    // 兼容旧前端:无 limit 时返回数组;有 limit 时返回 { list, total, hasMore }
    return limit ? c.json({ list, total, hasMore: offset + rows.length < total }) : c.json(list);
  });
  app.post("/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<SessionMeta>;
    const s: SessionMeta = {
      id: randomUUID(),
      title: body.title || "新会话",
      mode: body.mode || "chat",
      workspace: body.workspace || process.cwd(),
      createdAt: now(),
    };
    s.updatedAt = s.createdAt;
    db.prepare("INSERT INTO sessions (id, title, mode, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      s.id, s.title, s.mode, s.workspace, s.createdAt, s.updatedAt,
    );
    return c.json(s);
  });
  app.delete("/sessions/:id", (c) => {
    const run = runs.active(c.req.param("id"));
    if (run) runs.cancel(run.id); // 删除会话时停止其后台生成
    const used = (db.prepare("SELECT blocks FROM messages WHERE session_id = ? AND blocks LIKE '%\"attachmentId\"%'").all(c.req.param("id")) as Array<{ blocks: string }>)
      .flatMap((r) => attachmentBlocksOf(r.blocks).map((a) => a.attachmentId));
    db.prepare("DELETE FROM sessions WHERE id = ?").run(c.req.param("id"));
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(c.req.param("id"));
    // 附件不再被其他会话引用时一并删除
    if (used.length) attachments.prune({ ids: [...new Set(used)] });
    return c.json({ ok: true });
  });
  // 损坏的 blocks JSON 按纯文本降级为 undefined,不让整个接口 500
  const parseBlocks = (raw: string | null) => {
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? (v as ChatBlock[]) : undefined;
    } catch {
      return undefined;
    }
  };

  // usage 同理:非对象或缺字段时视为未返回
  const parseUsage = (raw: string | null): TokenUsage | undefined => {
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw) as Partial<TokenUsage> | null;
      return v && typeof v.promptTokens === "number" && typeof v.completionTokens === "number"
        ? (v as TokenUsage)
        : undefined;
    } catch {
      return undefined;
    }
  };

  // ---- 消息树(F6)----
  type MsgRow = {
    id: number; role: string; content: string; blocks: string | null; aborted: number; usage: string | null;
    error: string | null; model: string | null; parent_id: number | null; ref_context: string | null;
    ctx_trim: string | null; created_at: string; checkpoint_sha: string | null;
  };
  // 按给定顺序取消息(路径上的 id);缺失的跳过
  const rowsByIds = (ids: number[]): MsgRow[] => {
    if (!ids.length) return [];
    const rows = db
      .prepare(
        `SELECT id, role, content, blocks, aborted, usage, error, model, parent_id, ref_context, ctx_trim, checkpoint_sha, created_at
         FROM messages WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as unknown as MsgRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  };
  // L2:导入历史的批量记忆提取作业(一次一个会话,支持暂停 / 恢复 / 取消)。
  // 放在 rowsByIds 之后:作业执行时才会取历史,声明顺序不影响。
  const memoryJobs = new MemoryJobRunner({
    db,
    memory,
    provider: memoryProvider,
    historyFor: (sessionId) => {
      // 只要当前分支的 user / assistant 正文,取最近 200 条,避免长会话一次性塞爆上下文
      const ids = pathIds(loadTree(db, sessionId)).slice(-200);
      return rowsByIds(ids)
        .filter((r) => r.role === "user" || r.role === "assistant")
        .map((r) => ({ role: r.role as "user" | "assistant", content: r.content, id: r.id }));
    },
    // 至少 2 轮(2 条 user)才值得提取
    shouldProcess: (sessionId) =>
      (db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ? AND role = 'user'").get(sessionId) as { c: number }).c >= 2,
  });
  const parseTrim = (raw: string | null): ChatMessage["trim"] => {
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw) as { dropped?: unknown; summary?: unknown } | null;
      return v && typeof v.dropped === "number" && v.dropped > 0 ? { dropped: v.dropped, summary: v.summary === true } : undefined;
    } catch {
      return undefined;
    }
  };
  const refBlocksOf = (raw: string | null) =>
    (parseBlocks(raw) ?? []).filter((b): b is Extract<ChatBlock, { kind: "ref" }> => b.kind === "ref");
  const attachmentBlocksOf = (raw: string | null) =>
    (parseBlocks(raw) ?? []).filter((b): b is Extract<ChatBlock, { kind: "attachment" }> => b.kind === "attachment");
  // 文本附件的正文(带标题、单个截断);文件丢失时注明
  const attachmentText = (list: Array<Extract<ChatBlock, { kind: "attachment" }>>) =>
    list
      .filter((a) => a.type === "text")
      .map((a) => {
        let text: string;
        try {
          const raw = attachments.text(a.attachmentId);
          text = raw.length > TEXT_INJECT_CHARS ? `${raw.slice(0, TEXT_INJECT_CHARS)}\n…(已截断,原文 ${raw.length} 字)` : raw;
        } catch {
          text = "(附件文件已丢失)";
        }
        return `## 附件:${a.name}\n${text}`;
      })
      .join("\n\n");
  const readImages = (ids: string[]) =>
    ids.flatMap((id) => {
      const meta = attachments.get(id);
      if (!meta || meta.kind !== "image") return [];
      try {
        return [{ mime: meta.mime, data: attachments.read(id).toString("base64") }];
      } catch {
        return [];
      }
    });
  const toPathMessage = (r: MsgRow): PathMessage => {
    // B1:assistant 消息把工具调用摘要附在正文后,否则下一轮模型不知道上一轮做过什么
    const digest = r.role === "assistant" ? toolDigest(parseBlocks(r.blocks) ?? []) : "";
    return {
      id: r.id,
      role: r.role as PathMessage["role"],
      content: digest ? `${r.content}\n\n[上一步工具调用] ${digest}` : r.content,
      refContext: r.ref_context,
      refs: r.role === "user" ? refBlocksOf(r.blocks) : undefined,
      attachments: r.role === "user" ? attachmentBlocksOf(r.blocks) : undefined,
      usage: parseUsage(r.usage),
    };
  };
  // 当前分支的消息(会话展示用),带父消息与兄弟版本
  const listPath = (sessionId: string): ChatMessage[] => {
    const tree = loadTree(db, sessionId);
    return rowsByIds(pathIds(tree)).map((r) => ({
      id: r.id,
      role: r.role as ChatMessage["role"],
      content: r.content,
      blocks: parseBlocks(r.blocks),
      aborted: r.aborted ? true : undefined,
      usage: parseUsage(r.usage),
      error: r.error ?? undefined,
      model: r.model ?? undefined,
      parentId: tree.linear ? undefined : (tree.parent.get(r.id) ?? null),
      siblings: siblingsOf(tree, r.id),
      trim: parseTrim(r.ctx_trim),
      checkpointSha: r.checkpoint_sha ?? undefined,
    }));
  };

  app.get("/sessions/:id/messages", (c) => c.json(listPath(c.req.param("id"))));
  // L2:单个会话的元信息(记忆页「查看出处」要按 id 定位会话)
  app.get("/sessions/:id", (c) => {
    const r = db.prepare("SELECT * FROM sessions WHERE id = ?").get(c.req.param("id")) as
      | { id: string; title: string; mode: string; workspace: string; created_at: string; updated_at: string | null; archived: number }
      | undefined;
    if (!r) return c.json({ error: "会话不存在" }, 404);
    return c.json({
      id: r.id, title: r.title, mode: r.mode, workspace: r.workspace,
      createdAt: r.created_at, updatedAt: r.updated_at || r.created_at,
      archived: Number(r.archived) === 1,
    });
  });
  // 切换分支:messageId 已在当前路径上则不变,否则切到它所在分支的最新末端;返回切换后的消息列表
  app.post("/sessions/:id/head", async (c) => {
    const sessionId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { messageId?: unknown };
    if (typeof body.messageId !== "number") return c.json({ error: "缺少 messageId" }, 400);
    if (runs.active(sessionId)?.status === "running") return c.json({ error: "该会话正在生成,请等待完成或先停止" }, 409);
    const head = switchHead(db, sessionId, body.messageId);
    if (head == null) return c.json({ error: "message not found" }, 404);
    return c.json({ headId: head, messages: listPath(sessionId) });
  });
  // L1:回退到某条消息。code=true 还原工作区到该消息的快照(先拍 pre-rewind 以便撤销);
  // chat=true 把对话 head 退到该消息的父消息,并返回原消息文本供前端填回输入框。
  app.post("/sessions/:id/rewind", async (c) => {
    const sessionId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { messageId?: unknown; code?: unknown; chat?: unknown };
    if (typeof body.messageId !== "number") return c.json({ error: "缺少 messageId" }, 400);
    if (runs.active(sessionId)?.status === "running") return c.json({ error: "该会话正在生成,请等待完成或先停止" }, 409);
    const session = db.prepare("SELECT workspace FROM sessions WHERE id = ?").get(sessionId) as { workspace: string } | undefined;
    if (!session) return c.json({ error: "session not found" }, 404);
    const row = db.prepare("SELECT id, role, content, parent_id, checkpoint_sha FROM messages WHERE id = ? AND session_id = ?").get(
      body.messageId, sessionId,
    ) as { id: number; role: string; content: string; parent_id: number | null; checkpoint_sha: string | null } | undefined;
    if (!row) return c.json({ error: "message not found" }, 404);

    let undoSha: string | null = null;
    if (body.code === true) {
      if (!row.checkpoint_sha) return c.json({ error: "该消息没有代码快照" }, 400);
      if (!session.workspace) return c.json({ error: "会话没有工作区" }, 400);
      // 先拍当前状态,供"撤销回退"
      const undo = await checkpoints.snapshot(session.workspace, "pre-rewind");
      if (!undo) return c.json({ error: "快照不可用(工作区过大或未初始化)" }, 409);
      const ok = await checkpoints.restore(session.workspace, row.checkpoint_sha);
      if (!ok) return c.json({ error: "还原失败" }, 500);
      undoSha = undo.sha;
      auditTool("checkpoint.rewind", { sessionId, messageId: row.id, to: row.checkpoint_sha, undo: undoSha });
    }
    if (body.chat === true) {
      // 直接设 head 为该消息的父消息(而不是 switchHead——它在消息已在路径上时不会回退)。
      // 该消息及其后的内容仍在库里,只是不在当前路径上,之后可用版本切换找回。
      setHeadId(db, sessionId, row.parent_id ?? null);
    }
    return c.json({
      ok: true,
      undoSha,
      ...(body.chat === true ? { text: row.content, messages: listPath(sessionId) } : {}),
    });
  });

  // L1:撤销回退(把工作区还原到 rewind 之前拍的那份快照)
  app.post("/sessions/:id/rewind/undo", async (c) => {
    const sessionId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { sha?: unknown };
    if (typeof body.sha !== "string") return c.json({ error: "缺少 sha" }, 400);
    const session = db.prepare("SELECT workspace FROM sessions WHERE id = ?").get(sessionId) as { workspace: string } | undefined;
    if (!session?.workspace) return c.json({ error: "会话没有工作区" }, 400);
    const ok = await checkpoints.restore(session.workspace, body.sha);
    if (!ok) return c.json({ error: "撤销失败" }, 500);
    auditTool("checkpoint.undo", { sessionId, sha: body.sha });
    return c.json({ ok: true });
  });

  // L1:快照与当前工作区的差异(确认对话框列出将要还原的文件)
  app.get("/checkpoints/diff", async (c) => {
    const sessionId = c.req.query("sessionId") ?? "";
    const from = c.req.query("from") ?? "";
    if (!sessionId || !from) return c.json({ error: "缺少 sessionId 或 from" }, 400);
    const session = db.prepare("SELECT workspace FROM sessions WHERE id = ?").get(sessionId) as { workspace: string } | undefined;
    if (!session?.workspace) return c.json({ error: "会话没有工作区" }, 400);
    const files = await checkpoints.diffFiles(session.workspace, from);
    const patch = await checkpoints.diffText(session.workspace, from);
    return c.json({ files, patch: patch.slice(0, 200_000) });
  });

  // 分支:把某条消息(含)及其祖先(缺省为当前分支全部)复制到一个新会话,返回新会话。
  app.post("/sessions/:id/branch", async (c) => {
    const sessionId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { messageId?: number; title?: string };
    const src = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | { id: string; title: string; mode: string; workspace: string; provider_id: string | null; model: string | null }
      | undefined;
    if (!src) return c.json({ error: "session not found" }, 404);
    const tree = loadTree(db, sessionId);
    if (typeof body.messageId === "number" && !tree.parent.has(body.messageId))
      return c.json({ error: "message not found" }, 404);
    const ids = typeof body.messageId === "number"
      ? (tree.linear ? tree.ids.filter((id) => id <= body.messageId!) : ancestors(tree, body.messageId))
      : pathIds(tree);
    const msgs = rowsByIds(ids);
    const nid = randomUUID();
    const title = (body.title?.trim() || `${src.title}(分支)`).slice(0, 80);
    const ts = now();
    // 分支沿用原会话的模型选择;消息按路径复制成单链
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO sessions (id, title, mode, workspace, created_at, updated_at, provider_id, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        nid, title, src.mode, src.workspace, ts, ts, src.provider_id, src.model,
      );
      const ins = db.prepare(
        `INSERT INTO messages (session_id, role, content, blocks, aborted, usage, error, model, parent_id, ref_context, ctx_trim, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let prev: number | null = null;
      for (const m of msgs) {
        const r: { lastInsertRowid: number | bigint } = ins.run(nid, m.role, m.content, m.blocks, m.aborted, m.usage, m.error, m.model, prev, m.ref_context, m.ctx_trim, m.created_at);
        prev = Number(r.lastInsertRowid);
      }
      setHeadId(db, nid, prev);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return c.json({
      id: nid, title, mode: src.mode, workspace: src.workspace, createdAt: ts, updatedAt: ts,
      providerId: src.provider_id, model: src.model,
    });
  });

  // ---- 附件(B2):multipart 字段 file;返回附件元信息,发送消息时把 id 放进 /chat 的 attachments ----
  app.post("/attachments", async (c) => {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!file || typeof file === "string") return c.json({ error: "缺少文件(multipart 字段 file)" }, 400);
    try {
      let bytes = new Uint8Array(await file.arrayBuffer());
      let name = file.name;
      let mime = file.type;
      // F8:PDF / Word 附件先转文本,再按文本附件存;转换失败按原类型交给后续校验
      if (isConvertible(name)) {
        const r = await convertToText(name, Buffer.from(bytes));
        if (!r.text.trim()) return c.json({ error: r.warning ?? "文件没有可提取的文字" }, 415);
        bytes = new TextEncoder().encode(r.text);
        name = `${name}.txt`;
        mime = "text/plain";
      }
      return c.json(attachments.save(name, mime, bytes));
    } catch (e) {
      if (e instanceof AttachmentError) return c.json({ error: e.message }, e.status);
      return c.json({ error: e instanceof Error ? e.message : "附件处理失败" }, 400);
    }
  });
  // 只按内容哈希取;文本一律按纯文本返回,图片按识别出的类型,禁止嗅探
  app.get("/attachments/:id", (c) => {
    const meta = attachments.get(c.req.param("id"));
    if (!meta) return c.json({ error: "attachment not found" }, 404);
    return new Response(new Uint8Array(attachments.read(meta.id)), {
      headers: {
        "Content-Type": meta.kind === "image" ? meta.mime : "text/plain; charset=utf-8",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  // ---- 消息全文搜索(M7):GET /search?q=&mode=&limit= ----
  app.get("/search", (c) =>
    c.json(
      searchMessages(db, c.req.query("q") ?? "", {
        mode: c.req.query("mode") || undefined,
        limit: Number(c.req.query("limit")) || undefined,
        includeArchived: c.req.query("archived") === "all",
      }),
    ),
  );

  // ---- 生成运行(F1)----
  // 回到会话时查询运行中的生成并续订;刚结束(未回收)的运行也返回,用于补齐回放
  app.get("/sessions/:id/active-run", (c) => c.json(runs.active(c.req.param("id"))?.info() ?? null));
  // 运行中的会话 id 列表:侧栏据此显示"生成中",生成结束后刷新列表
  app.get("/runs", (c) => c.json({ running: [...runs.running()] }));
  app.get("/runs/:id", (c) => {
    const run = runs.get(c.req.param("id"));
    return run ? c.json(run.info()) : c.json({ error: "run not found" }, 404);
  });
  // 订阅事件流:after(或 Last-Event-ID)之后的事件先回放,再实时推送
  app.get("/runs/:id/events", (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    const after = Number(c.req.query("after") ?? c.req.header("Last-Event-ID") ?? 0) || 0;
    return streamRun(c, run, after);
  });
  // 唯一的中止入口:断开连接不会停止生成
  app.post("/runs/:id/cancel", (c) => c.json({ ok: runs.cancel(c.req.param("id")) }));

  // B1:工具确认。兼容 { callId, decision } 与 { callId, allow, remember } 两种写法
  app.post("/runs/:id/confirm", async (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      callId?: string; decision?: string; allow?: boolean; remember?: boolean;
    };
    const callId = typeof body.callId === "string" ? body.callId : "";
    if (!callId) return c.json({ error: "缺少 callId" }, 400);
    let decision: ToolDecision;
    if (body.decision === "allow" || body.decision === "always" || body.decision === "deny") decision = body.decision;
    else if (typeof body.allow === "boolean") decision = body.allow ? (body.remember ? "always" : "allow") : "deny";
    else return c.json({ error: "decision 必须是 allow / always / deny" }, 400);
    return run.confirm(callId, decision) ? c.json({ ok: true }) : c.json({ error: "该调用不在等待确认" }, 409);
  });

  // ---- Chat:规则文件 + 相关记忆 + 历史,流式回复,落库 ----
  app.post("/chat", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: string;
      message?: string;
      regenerate?: boolean;
      context?: string;
      refs?: Array<{ refType: "message" | "doc" | "file"; label: string; excerpt: string; path?: string }>;
      providerId?: string; // 本次请求临时指定模型(如"换个模型重新生成"),优先于会话设置
      model?: string;
      editOf?: number; // 编辑某条 user 消息:新消息作为它的兄弟版本(F6),原消息与其后的回复都保留
      attachments?: string[]; // 已上传附件的 id(B2);只有附件时 message 可为空
    };
    const regenerate = body.regenerate === true;
    const attachIds = Array.isArray(body.attachments)
      ? [...new Set(body.attachments.filter((x): x is string => typeof x === "string"))]
      : undefined;
    const hasText = typeof body.message === "string" && !!body.message.trim();
    if (!body.sessionId || (!regenerate && !hasText && !attachIds?.length))
      return c.json({ error: "缺少 sessionId/message" }, 400);
    if (attachIds && attachIds.length > MAX_PER_MESSAGE) return c.json({ error: `一条消息最多 ${MAX_PER_MESSAGE} 个附件` }, 400);
    // 解构为常量,保证闭包内类型收窄不失效
    const sessionId = body.sessionId;
    // context 进入模型消息并随 user 消息落库(之后几轮继续带入,F4);refs 作为展示块落库(D5)
    let context = typeof body.context === "string" ? body.context : "";
    let refs = Array.isArray(body.refs) ? body.refs : [];
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | {
          id: string; workspace: string; mode: string; title: string; provider_id: string | null; model: string | null;
          summary: string | null; summary_upto_id: number | null;
        }
      | undefined;
    if (!session) return c.json({ error: "session not found" }, 404);
    // 模型优先级(M3 / D-021):请求指定 > 会话设置 > 全局激活(D-013)> main 角色兜底
    const pick = typeof body.providerId === "string" && body.providerId
      ? { id: body.providerId, model: body.model ?? null }
      : { id: session.provider_id, model: session.model };
    // 用户本轮显式选了模型:预算超支时只提示,不擅自换模型
    const explicitPick = typeof body.providerId === "string" && !!body.providerId;
    let provider = opts?.chatProvider?.() ?? providers.resolve(pick.id, pick.model) ?? providers.registry().byRole("main");
    if (!provider) return c.json({ error: "no provider configured" }, 400);
    let modelName = provider.config.model || null; // 落到 assistant 消息上,前端气泡显示

    // L5:日预算。已超支且用户没指定模型时,降级到已定价模型里最便宜的一个。
    const dailyBudget = providers.settings().dailyBudget ?? null;
    const spentToday = usageLedger.spentToday();
    let downgraded: { from: string; to: string; reason: string } | null = null;
    if (dailyBudget != null && spentToday >= dailyBudget) {
      const cheap = cheapestPriced(
        providers.configs().flatMap((c) =>
          modelsOf(c).map((m) => ({ providerId: c.id, model: m.id, pricing: m.pricing })),
        ),
      );
      const curModel = provider.config.model;
      if (cheap && cheap.model !== curModel && !explicitPick) {
        const next = providers.resolve(cheap.providerId, cheap.model);
        if (next) {
          downgraded = {
            from: curModel,
            to: cheap.model,
            reason: `今日已花费 ${spentToday.toFixed(2)} 超出日预算 ${dailyBudget.toFixed(2)},已降级到最低价模型`,
          };
          provider = next;
          modelName = next.config.model || null;
        }
      } else if (explicitPick) {
        downgraded = {
          from: curModel, to: curModel,
          reason: `今日已花费 ${spentToday.toFixed(2)} 超出日预算 ${dailyBudget.toFixed(2)},本轮按你指定的模型继续`,
        };
      }
    }
    // 同一会话同时只允许一个生成(F1):先拦下,避免记忆工具等副作用
    const busyMsg = "该会话正在生成,请等待完成或先停止";
    if (runs.active(sessionId)?.status === "running") return c.json({ error: busyMsg }, 409);

    // F6:确定本轮在消息树上的位置。parentId = 本轮 user 消息的父消息(历史到此为止)
    const tree = ensureTree(db, sessionId);
    let parentId: number | null = tree.head;
    let message = typeof body.message === "string" ? body.message : "";
    // regenerate:沿用当前分支末尾的 user 消息(原文与引用上下文都取库里的);新回复作为兄弟版本
    let regenUserId: number | null = null;
    // 被重新生成的旧回复;出错的旧回复会被新回复替换,不累积失败版本
    let prevReply: { id: number; error: string | null } | null = null;
    // 编辑时沿用的原引用块(保留当时的文件指纹)
    let keptRefBlocks: Array<Extract<ChatBlock, { kind: "ref" }>> | null = null;
    // 本轮附件块:新发送按 attachIds 生成;regenerate / 编辑未带附件时沿用原消息的
    let attBlocks: Array<Extract<ChatBlock, { kind: "attachment" }>> = [];
    if (regenerate) {
      const head = tree.head == null ? undefined : (db.prepare("SELECT id, role, error FROM messages WHERE id = ?").get(tree.head) as
        | { id: number; role: string; error: string | null } | undefined);
      const uid = head?.role === "assistant" ? (tree.parent.get(head.id) ?? null) : (head?.id ?? null);
      const user = uid == null ? undefined : (db.prepare("SELECT id, role, content, blocks, ref_context FROM messages WHERE id = ?").get(uid) as
        | { id: number; role: string; content: string; blocks: string | null; ref_context: string | null } | undefined);
      if (!user || user.role !== "user") return c.json({ error: "没有可重新生成的消息" }, 400);
      if (head?.role === "assistant") prevReply = { id: head.id, error: head.error };
      regenUserId = user.id;
      parentId = tree.parent.get(user.id) ?? null;
      message = user.content;
      if (!context) context = user.ref_context ?? "";
      if (!refs.length) refs = refBlocksOf(user.blocks).map(({ refType, label, excerpt, path }) => ({ refType, label, excerpt, path }));
      attBlocks = attachmentBlocksOf(user.blocks);
    } else if (typeof body.editOf === "number") {
      const orig = db.prepare("SELECT id, role, blocks, ref_context FROM messages WHERE id = ? AND session_id = ?").get(body.editOf, sessionId) as
        | { id: number; role: string; blocks: string | null; ref_context: string | null } | undefined;
      if (!orig || orig.role !== "user") return c.json({ error: "要编辑的消息不存在" }, 404);
      parentId = tree.parent.get(orig.id) ?? null;
      // 编辑只改文字:没带新引用 / 附件时沿用原消息的
      if (!refs.length && !context) {
        context = orig.ref_context ?? "";
        keptRefBlocks = refBlocksOf(orig.blocks);
        refs = keptRefBlocks.map(({ refType, label, excerpt, path }) => ({ refType, label, excerpt, path }));
      }
      if (attachIds === undefined) attBlocks = attachmentBlocksOf(orig.blocks);
    }
    if (!regenerate && attachIds?.length) {
      attBlocks = [];
      for (const [i, id] of attachIds.entries()) {
        const meta = attachments.get(id);
        if (!meta) return c.json({ error: "附件不存在或已过期,请重新上传" }, 400);
        attBlocks.push({ id: `att${i + 1}`, kind: "attachment", attachmentId: meta.id, name: meta.name, mime: meta.mime, size: meta.size, type: meta.kind });
      }
    }
    // 能力未声明时不拦(按 Provider 实际报错为准);声明了但没有 vision 时不发图片
    const caps = provider.config.capabilities ?? [];
    const vision = caps.length === 0 || caps.includes("vision");
    // B1:Code / Work 模式下发工具(chat 不给)。capabilities 未声明时按 Provider 实际能力为准;
    // XIYUN_AGENT=0 可整体关闭 agent 循环(排错用)
    const agentEnabled =
      (session.mode === "code" || session.mode === "work") &&
      !!session.workspace &&
      !!provider.streamEvents &&
      (caps.length === 0 || caps.includes("tools")) &&
      process.env.XIYUN_AGENT !== "0";
    let agentTools = agentEnabled ? toolsForMode(session.mode) : [];
    // B3:MCP 工具并入注册表(code / work 默认开放,chat 由设置开关控制——当前仅 code / work)
    if (agentEnabled) {
      try {
        const mcpTools = await mcp.tools(session.workspace);
        if (mcpTools.length)
          agentTools = [
            ...agentTools,
            ...mcpAgentTools(mcpTools, (server, toolName, args, signal) =>
              mcp.callTool(session.workspace, server, toolName, args, signal),
            ),
          ];
      } catch {
        // MCP 不可用不影响内置工具
      }
    }
    const curImages = attBlocks.filter((a) => a.type === "image");
    if (curImages.length && !vision)
      return c.json({ error: "当前模型未声明图片能力(vision):请换用支持图片的模型,或在设置里为该模型加上 vision" }, 400);

    // 规则层:引用的文件参与匹配 .mdc globs 与目录级 AGENTS.md / CLAUDE.md(D-019)
    const refFiles = refs.flatMap((r) => (r.refType === "file" && typeof r.path === "string" ? [r.path] : []));
    const rules = loadRuleFiles(session.workspace, { dataDir: DATA_DIR, mode: session.mode, homeDir: homedir(), files: refFiles });
    const skillText = skills.promptFor(session.mode, "main", message);
    const scopes = ["global", session.mode, session.workspace];
    // 记忆链路只用用户原话:引用上下文不参与记忆指令与检索(D5)
    const memNote = message.trim() ? await runMemoryTool({ provider, memory, message: message, scopes, scope: session.mode }) : "";
    let facts = message.trim() ? memory.search(message, 5, scopes) : [];
    // 无主题词的泛化提问("我上次学到哪了")召回为空时,回退到最近的有效记忆。
    if (facts.length === 0) facts = memory.recent(5, scopes);
    const memories = facts.map((f) => `- ${f.content}`);

    const isCode = session.mode === "code";
    const isWork = session.mode === "work";
    // Work 模式:检索导入文档,注入带来源的片段,结论必须可回链。
    const docHits = isWork ? work.searchDocs(message, 3, session.workspace) : [];
    const system = [
      isCode
        ? `你是 XiyunAgent 的 Code 助手,在项目工作区(${session.workspace})中帮助用户分析、修改、测试和审查代码。修改前先说明方案和影响范围;提交、推送、部署只能建议,由用户在审查面板确认后执行。`
        : isWork
          ? `你是 XiyunAgent 的 Work 助手,在工作目录(${session.workspace})中帮助用户整理需求、会议资料、网页调研和待办。结论必须标注来源(文档标题或 URL);外部发送、修改原文件和批量操作只能建议,由用户确认后执行。`
          : "你是 XiyunAgent 的 Chat 助手,帮助用户学习、总结、解释和复习。",
      // B1:工具使用指引(只在真正下发了工具时出现,避免模型在无工具会话里空谈)
      agentTools.length > 0 &&
        (isCode
          ? [
              "# 工具使用",
              "你可以读写文件、搜索、执行命令和查看 git 状态。请遵守:",
              "1. 修改前先用 read_file / grep 看清现有实现,不要凭猜测改。",
              "2. 小范围修改优先用 edit_file(精确替换),整份重写才用 write_file。",
              "3. 改完运行相关测试或命令验证,不要只声称完成。",
              "4. 写操作和非常用命令可能需要用户确认;被拒绝时不要重复尝试,向用户说明并询问下一步。",
            ].join("\n")
          : [
              "# 可用工具",
              "你可以用 read_file / list_files / grep 查看工作区内的资料(只读,不会修改文件)。",
              "需要修改或执行命令时,说明需要用户手动操作。",
            ].join("\n")),
      memNote && `# 记忆操作\n${memNote}\n请在回复中向用户确认该操作结果。`,
      rules && `# 规则\n${rules}`,
      skillText && `# 已启用 Skill\n${skillText}`,
      memories.length && `# 相关记忆\n${memories.join("\n")}`,
      docHits.length > 0 &&
        `# 相关资料(引用时标注来源)\n${docHits.map((d) => `## ${d.title}(来源:${d.source} §${(d.ord ?? 0) + 1})\n${d.text}`).join("\n\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // F4:历史 = 从根到 parentId 的分支路径,按 token 预算从新到旧装入;装不下的早先消息用滚动摘要代替
    // 本轮:原话 + 引用上下文 + 文本附件正文;图片单独随消息发送
    const curText = attachmentText(attBlocks);
    const withCtx = context ? withRefContext(message, context) : message;
    const modelMessage = curText ? withAttachments(withCtx, curText) : withCtx;
    const path = parentId == null ? [] : rowsByIds(ancestors(tree, parentId)).map(toPathMessage);
    const budget =
      contextBudget({ contextLength: provider.config.contextLength, maxTokens: provider.config.params?.maxTokens }) -
      estimateTokens(system) - estimateTokens(modelMessage) - curImages.length * IMAGE_TOKENS - 2 * MESSAGE_OVERHEAD;
    // 引用过的文件现在内容变了:带入历史时提示模型
    const staleFiles = (m: PathMessage) =>
      !session.workspace
        ? []
        : (m.refs ?? []).flatMap((r) =>
            r.refType === "file" && r.path && r.hash && fileHash(session.workspace, r.path) !== r.hash ? [r.label] : [],
          );
    const planOpts = { changed: staleFiles, vision, attachmentText: (m: PathMessage) => attachmentText(m.attachments ?? []) };
    let plan = planHistory(path, budget, planOpts);
    const summaryValid =
      !!session.summary && session.summary_upto_id != null && path.some((m) => m.id === session.summary_upto_id);
    let systemText = system;
    if (plan.dropped.length && summaryValid) {
      const section = `# 早先对话摘要\n(更早的消息未逐字带入,以下为压缩摘要;与之后的消息冲突时以之后的为准)\n${session.summary}`;
      systemText = `${system}\n\n${section}`;
      plan = planHistory(path, budget - estimateTokens(section) - 2, planOpts);
    }
    const trim = plan.dropped.length ? { dropped: plan.dropped.length, summary: summaryValid } : null;
    const curImageData = readImages(curImages.map((a) => a.attachmentId));
    const messages: ChatMessage[] = [
      { role: "system", content: systemText },
      ...plan.history.map(({ imageIds, ...m }) => {
        const images = imageIds?.length ? readImages(imageIds) : [];
        return images.length ? { ...m, images } : m;
      }),
      { role: "user", content: modelMessage, ...(curImageData.length ? { images: curImageData } : {}) },
    ];

    // 最后一个 await 之后再占位,与 user 落库之间没有让出事件循环,不会并发重复
    const run = runs.start(sessionId);
    if (!run) return c.json({ error: busyMsg }, 409);

    // user 落库:content 只存原话,refs 作为 ref 块(D5)
    let userMessageId: number | null = null;
    // 模型起标题的异步结果(成功覆盖时为新标题);流还开着就推给客户端
    let titlePending: Promise<string | null> | null = null;
    if (!regenerate) {
      // 文件引用记下当前内容指纹,之后带入历史时据此判断是否已变更
      const refBlocks: ChatBlock[] =
        keptRefBlocks ??
        refs.map((r2, i) => {
          const hash = r2.refType === "file" && r2.path && session.workspace ? fileHash(session.workspace, r2.path) : undefined;
          return { id: `ref${i + 1}`, kind: "ref" as const, ...r2, ...(hash ? { hash } : {}) };
        });
      const all = [...refBlocks, ...attBlocks];
      const blocks = all.length ? JSON.stringify(all) : null;
      // L1:本轮开始前拍快照,供"回退到这里"。失败不影响对话
      const cp = session.mode === "code" && session.workspace
        ? await checkpoints.snapshot(session.workspace, `chat ${new Date().toISOString()}`).catch(() => null)
        : null;
      const r = db
        .prepare(
          "INSERT INTO messages (session_id, role, content, blocks, parent_id, ref_context, checkpoint_sha, created_at) VALUES (?, 'user', ?, ?, ?, ?, ?, ?)",
        )
        .run(sessionId, message, blocks, parentId, context || null, cp?.sha ?? null, now());
      userMessageId = Number(r.lastInsertRowid);
      setHeadId(db, sessionId, userMessageId);
      touchSession(sessionId);
      // 自动命名:仍是默认标题时,先落启发式标题,较长的消息再异步请模型起短标题(只覆盖启发式标题,不动用户改过的)
      if (session.title === DEFAULT_TITLE) {
        const quick = heuristicTitle(message) || heuristicTitle(attBlocks[0]?.name ?? "");
        if (quick) {
          db.prepare("UPDATE sessions SET title = ? WHERE id = ? AND title = ?").run(quick, sessionId, DEFAULT_TITLE);
          const titler = opts?.titleProvider ? opts.titleProvider() : memoryProvider();
          if (titler && (Array.from(message.trim()).length > 20 || message.includes("\n"))) {
            titlePending = generateTitle(titler, message)
              .then((t) => {
                if (!t || t === quick) return null;
                const r2 = db.prepare("UPDATE sessions SET title = ? WHERE id = ? AND title = ?").run(t, sessionId, quick);
                return Number(r2.changes) > 0 ? t : null;
              })
              .catch(() => null);
          }
        }
      }
    } else {
      userMessageId = regenUserId;
    }

    const tools = agentTools.length ? agentTools.map((t) => t.def) : undefined;

    // F1:生成在后台执行,不随本次连接断开而中止;只有 POST /runs/:id/cancel 触发 ac
    run.userMessageId = userMessageId;
    const ac = run.ac;
    const send = (obj: unknown) => run.emit(obj);
    // 先下发已落库的 user 消息 id 与 runId:中断或出错时客户端也能立即编辑 / 分支,断线后可凭 runId 续订
    send({
      type: "meta", userMessageId, runId: run.id, model: modelName,
      ...(trim ? { trim } : {}),
      ...(downgraded ? { downgraded } : {}),
    });
    // 运行结束后 emit 自动忽略,标题晚到时只落库
    void titlePending?.then((title) => {
      if (title) send({ type: "title", title });
    });
    let outcome: "done" | "error" = "done";

    void (async () => {

      const builder = new BlockBuilder(send);
      const blocks = builder.blocks;
      let finishReason: string | null = null;
      let usage: TokenUsage | null = null;
      // L5:记账要用实际完成本次运行的模型(可能已回退)
      let finalProvider = provider;
      let persistedId: number | null = null;

      try {
        // L5:回退链 = 当前模型之后,同 main 角色的其他模型(去重)。
        // 注入了 chatProvider(测试)时不启用,保证用例可复现。
        const chain = opts?.chatProvider
          ? []
          : providers.registry().byRoleAll("main").filter((p) => p.config.id !== provider.config.id);
        const result = await runAgent({
          provider,
          messages,
          tools: agentTools,
          workspace: session.workspace,
          signal: ac.signal,
          builder,
          homeDir: homedir(),
          maxSteps: 30,
          fallbacks: chain,
          onFallback: ({ from, to, reason }) => {
            modelName = to;
            send({ type: "meta", userMessageId, runId: run.id, model: to, fallback: { from, to, reason } });
          },
          // 确认回调:写入 runId 后挂起,等 POST /runs/:id/confirm
          confirm: async (req) => {
            const b = builder.tool(req.blockId);
            if (b) {
              b.runId = run.id;
              builder.update(req.blockId);
            }
            return run.awaitConfirm(req.blockId);
          },
          // L1:写操作 / 命令执行前拍快照
          beforeWrite: async ({ name, args }) => {
            const cp = await checkpoints.snapshot(session.workspace, `${name} ${JSON.stringify(args).slice(0, 120)}`);
            return cp?.sha ?? null;
          },
          // 每次工具执行写一条审计事件;只记参数摘要,不记文件内容
          onToolEnd: (info) => {
            const summary = JSON.stringify(info.args).slice(0, 300);
            db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('tool.agent', ?, ?)").run(
              JSON.stringify({ sessionId, name: info.name, args: summary, status: info.status, exitCode: info.exitCode }), now(),
            );
          },
        });
        finishReason = result.finishReason;
        usage = result.usage;
        finalProvider = result.provider;
        builder.closeOpen();

        if (ac.signal.aborted) {
          builder.closeUnfinished();
          const content = builder.textOf();
          let messageId: number | null = null;
          try {
            if (content || blocks.length) messageId = persist({ content, blocks, aborted: true });
          } catch {
            // 落库失败也要让客户端收尾
          }
          send({ type: "cancelled", messageId, userMessageId });
          return;
        }
        const content = builder.textOf();
        const messageId = persist({ content, blocks, aborted: false });
        persistedId = messageId;
        db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('chat', ?, ?)").run(
          JSON.stringify({ sessionId, user: message, assistant: content }), now(),
        );
        void send({ done: true, messageId, userMessageId });
        queueExtract(sessionId, session.mode, session.workspace);
        if (plan.dropped.length) queueSummary(sessionId, plan.dropped, summaryValid ? session : null);
        // 标题通常早于回复完成;还没好时最多再等 1.5s,超时则只落库,下次刷新列表可见
        if (titlePending) await Promise.race([titlePending, new Promise((r) => setTimeout(r, 1500))]);
      } catch (e) {
        // 中断后不再消费 Provider;runAgent 内部已关闭迭代器
        builder.closeOpen();
        if (ac.signal.aborted) {
          builder.closeUnfinished();
          const content = builder.textOf();
          let messageId: number | null = null;
          try {
            if (content || blocks.length) messageId = persist({ content, blocks, aborted: true });
          } catch {
            // 落库失败也要让客户端收尾
          }
          send({ type: "cancelled", messageId, userMessageId });
          return;
        }
        outcome = "error";
        // 出错时保留已生成的半截并标记 error,刷新后仍可见、可重试;
        // regenerate 出错时旧回答作为兄弟版本保留,不会被覆盖
        const error = (e instanceof Error ? e.message : "provider error").slice(0, 500);
        builder.closeUnfinished("生成出错");
        const content = builder.textOf();
        let messageId: number | null = null;
        if (content || blocks.length) {
          try {
            messageId = persist({ content, blocks, aborted: false, error });
          } catch {
            // 落库失败不影响把错误告诉客户端
          }
        }
        void send({ error, messageId, userMessageId });
      } finally {
        // L5:有用量就记一行账(取消时也记,已经消耗的 token 是真实成本)
        if (usage) {
          try {
            usageLedger.record({
              sessionId, messageId: persistedId, providerId: finalProvider.config.id,
              model: finalProvider.config.model || null, usage,
              pricing: pricingOf(finalProvider.config), currency: providers.settings().currency,
            });
          } catch {
            // 记账失败不影响回复
          }
        }
        runs.finish(run, ac.signal.aborted ? "cancelled" : outcome);
      }

      // 新回复挂在本轮 user 消息下并成为分支末端(F6)。regenerate 时旧回复作为兄弟版本保留,
      // 只有出错的旧回复(且没有后续消息)被替换;删除与插入同一事务,避免删成功但插入失败丢历史。
      function persist(input: { content: string; blocks: ChatBlock[]; aborted: boolean; error?: string }): number | null {
        if (input.aborted && !input.content && input.blocks.length === 0) return null;
        db.exec("BEGIN");
        try {
          if (prevReply?.error != null) {
            db.prepare("DELETE FROM messages WHERE id = ? AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.parent_id = ?)").run(
              prevReply.id, prevReply.id,
            );
          }
          const r = db
            .prepare(
              `INSERT INTO messages (session_id, role, content, blocks, aborted, usage, error, model, parent_id, ctx_trim, created_at)
               VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              sessionId,
              input.content,
              input.blocks.length ? JSON.stringify(input.blocks) : null,
              input.aborted ? 1 : 0,
              usage ? JSON.stringify(usage) : null,
              input.error ?? null,
              modelName,
              userMessageId,
              trim ? JSON.stringify(trim) : null,
              now(),
            );
          const id = Number(r.lastInsertRowid);
          setHeadId(db, sessionId, id);
          db.exec("COMMIT");
          touchSession(sessionId);
          return id;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }
    })().catch(() => runs.finish(run, "error"));

    return streamRun(c, run);
  });

  // ---- 记忆 ----
  app.get("/memory/facts", (c) => c.json(memory.list()));
  app.post("/memory/facts", async (c) => {
    const b = (await c.req.json()) as { content: string; source?: string; confidence?: number; scope?: string };
    return c.json(memory.addFact(b.content, b));
  });
  app.post("/memory/facts/:id/supersede", async (c) => {
    const b = (await c.req.json()) as { content: string };
    return c.json(memory.supersede(c.req.param("id"), b.content));
  });
  app.delete("/memory/facts/:id", (c) => {
    const hard = c.req.query("hard") === "true";
    if (hard) memory.forget(c.req.param("id"));
    else memory.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/memory/query", async (c) => {
    const b = (await c.req.json()) as { q: string };
    return c.json(memory.search(b.q, 20));
  });

  // ---- 候选记忆(阶段 2)----
  app.get("/memory/candidates", (c) => {
    const status = c.req.query("status") as "pending" | "confirmed" | "rejected" | undefined;
    return c.json(memory.listCandidates(status));
  });
  app.post("/memory/candidates/:id/confirm", (c) => {
    try {
      return c.json(memory.confirmCandidate(c.req.param("id")));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "confirm failed" }, 400);
    }
  });
  app.post("/memory/candidates/:id/reject", (c) => {
    memory.rejectCandidate(c.req.param("id"));
    return c.json({ ok: true });
  });
  // 手动触发提取(提取失败后的重试入口)
  app.post("/memory/extract", async (c) => {
    const b = (await c.req.json()) as { sessionId: string };
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(b.sessionId) as
      | { id: string; mode: string; workspace: string }
      | undefined;
    if (!session) return c.json({ error: "session not found" }, 404);
    const provider = memoryProvider();
    if (!provider) return c.json({ error: "no provider configured" }, 400);
    const history = rowsByIds(pathIds(loadTree(db, session.id)).slice(-12)).map(
      (r) => ({ role: r.role, content: r.content }) as ChatMessage,
    );
    const n = await extractMemories({
      provider, memory, history,
      sessionId: session.id, mode: session.mode, workspace: session.workspace,
      existingFacts: memory.list().map((f) => f.content),
    });
    return c.json({ candidates: n });
  });

  // ---- L2:批量提取作业(导入历史后初始化记忆)----
  app.get("/memory/jobs", (c) => c.json(memoryJobs.list()));
  app.get("/memory/jobs/:id", (c) => {
    const job = memoryJobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "作业不存在" }, 404);
    return c.json({ ...job, items: memoryJobs.items(job.id) });
  });
  app.post("/memory/jobs", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { source?: string; sessionIds?: string[]; scope?: string };
    const source = (b.source ?? "import").trim();
    const ids = Array.isArray(b.sessionIds) ? b.sessionIds.filter((x) => typeof x === "string" && x) : [];
    if (!ids.length) return c.json({ error: "缺少要处理的会话(sessionIds)" }, 400);
    if (!memoryProvider()) return c.json({ error: "没有可用的记忆模型,请先在设置里配置" }, 400);
    const job = memoryJobs.create({ source, sessionIds: ids, scope: b.scope ?? "global" });
    void memoryJobs.run(job.id);
    return c.json(memoryJobs.get(job.id));
  });
  app.post("/memory/jobs/:id/pause", (c) => {
    if (!memoryJobs.pause(c.req.param("id"))) return c.json({ error: "作业不存在或已结束" }, 400);
    return c.json(memoryJobs.get(c.req.param("id")));
  });
  app.post("/memory/jobs/:id/resume", (c) => {
    if (!memoryJobs.resume(c.req.param("id"))) return c.json({ error: "作业不存在或不在暂停状态" }, 400);
    return c.json(memoryJobs.get(c.req.param("id")));
  });
  app.post("/memory/jobs/:id/cancel", (c) => {
    if (!memoryJobs.cancel(c.req.param("id"))) return c.json({ error: "作业不存在或已结束" }, 400);
    return c.json(memoryJobs.get(c.req.param("id")));
  });
  // 按来源撤销全部记忆(软删除;二次确认由前端负责)
  app.post("/memory/facts/revoke", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { sourceKind?: string };
    const kind = (b.sourceKind ?? "").trim();
    if (!kind) return c.json({ error: "缺少来源(sourceKind)" }, 400);
    return c.json({ revoked: memory.revokeBySource(kind) });
  });

  // ---- 子智能体任务(阶段 3)----
  // 单个:{ role, prompt, ... };批量:{ schedule:"parallel"|"pipeline", tasks:[{ role, prompt, ... }] }
  app.post("/tasks", async (c) => {
    const b = (await c.req.json()) as {
      role?: AgentRole;
      prompt?: string;
      title?: string;
      sessionId?: string;
      providerId?: string;
      mode?: string;
      workspace?: string;
      schedule?: "run" | "parallel" | "pipeline";
      tasks?: Array<{ role: AgentRole; prompt: string; title?: string; providerId?: string }>;
    };
    const ids: string[] = [];
    if (Array.isArray(b.tasks) && b.tasks.length > 0) {
      if (!b.schedule || b.schedule === "run")
        return c.json({ error: "批量任务需要 schedule=parallel|pipeline" }, 400);
      if (b.tasks.length > MAX_GROUP_TASKS)
        return c.json({ error: `每组最多 ${MAX_GROUP_TASKS} 个子智能体` }, 400);
      const groupId = randomUUID();
      let prevId: string | null = null;
      for (const t of b.tasks) {
        const task = taskStore.create({
          role: t.role, prompt: t.prompt, title: t.title, schedule: b.schedule,
          groupId, sessionId: b.sessionId, providerId: t.providerId,
          mode: b.mode, workspace: b.workspace,
          dependsOn: b.schedule === "pipeline" ? (prevId ?? undefined) : undefined,
        });
        ids.push(task.id);
        prevId = task.id;
      }
    } else {
      if (!b.role || !b.prompt) return c.json({ error: "缺少 role/prompt" }, 400);
      const task = taskStore.create({ ...b, role: b.role, prompt: b.prompt, schedule: "run" });
      ids.push(task.id);
    }
    scheduler.dispatch(ids);
    return c.json({ ids });
  });
  app.get("/tasks", (c) => {
    return c.json(
      taskStore.list({
        sessionId: c.req.query("sessionId") || undefined,
        status: (c.req.query("status") || undefined) as TaskStatus | undefined,
        groupId: c.req.query("groupId") || undefined,
      }),
    );
  });
  app.get("/tasks/:id", (c) => {
    const t = taskStore.get(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  });
  app.post("/tasks/:id/cancel", (c) => {
    return scheduler.cancel(c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: "任务不存在或已结束" }, 400);
  });
  app.post("/tasks/:id/retry", (c) => {
    return scheduler.retry(c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: "任务不存在或正在运行" }, 400);
  });
  app.post("/tasks/:id/resume", async (c) => {
    const b = (await c.req.json()) as { answer?: string };
    if (!b.answer?.trim()) return c.json({ error: "缺少 answer" }, 400);
    return scheduler.resume(c.req.param("id"), b.answer.trim())
      ? c.json({ ok: true })
      : c.json({ error: "任务不存在或未在等待用户" }, 400);
  });

  // L4:任务事件流(SSE)。先回放历史事件,再实时推送新事件。
  app.get("/tasks/:id/events", (c) => {
    const id = c.req.param("id");
    if (!taskStore.get(id)) return c.json({ error: "not found" }, 404);
    return streamSSE(c, async (stream) => {
      let queue: Promise<unknown> = Promise.resolve();
      let end!: () => void;
      const ended = new Promise<void>((r) => (end = r));
      const gone = () => end();
      stream.onAbort(gone);
      c.req.raw.signal.addEventListener("abort", gone, { once: true });
      const seen = new Set<number>();
      // 先订阅再回放:回放期间到达的事件会重复出现,按 events 表 id 去重
      const unsub = taskEvents.subscribe(id, (e) => {
        if (seen.has(e.id)) return;
        seen.add(e.id);
        queue = queue
          .then(() => stream.writeSSE({ id: String(e.id), data: JSON.stringify(e) }))
          .catch(() => {});
      });
      const rows = db
        .prepare(
          "SELECT id, type, payload, created_at FROM events WHERE type LIKE 'task.%' AND payload LIKE ? ORDER BY id ASC LIMIT 1000",
        )
        .all(`%"taskId":"${id}"%`) as Array<{
        id: number; type: string; payload: string; created_at: string;
      }>;
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        let payload: unknown = {};
        try {
          payload = JSON.parse(r.payload);
        } catch {
          // payload 损坏时按空对象回放,不中断整条流
        }
        await stream.writeSSE({
          id: String(r.id),
          data: JSON.stringify({ id: r.id, type: r.type, payload, createdAt: r.created_at }),
        });
      }
      await ended;
      unsub();
      if (!c.req.raw.signal.aborted) await queue;
    });
  });

  // L4:隔离分支的落地操作(合并 / 推送 / 建 PR / 丢弃)。
  // 前端确认后调用,服务端再校验一次;只对有隔离分支的任务可用。
  const withTask = async (id: string) => {
    const t = taskStore.get(id);
    return t ?? null;
  };
  app.post("/tasks/:id/merge", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
    if (b.confirm !== true) return c.json({ error: "需要确认后才能合并" }, 400);
    const t = await withTask(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    if (!t.worktree || !t.branch) return c.json({ error: "该任务没有待合并的隔离分支" }, 400);
    try {
      const output = await mergeBranch(t.workspace, t.branch);
      await removeWorktree(t.workspace, t.worktree, t.branch);
      taskStore.patch(t.id, { worktree: null, branch: null, diffStat: null });
      return c.json({ ok: true, output });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
  app.post("/tasks/:id/push", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { confirm?: boolean; remote?: string };
    if (b.confirm !== true) return c.json({ error: "需要确认后才能推送" }, 400);
    const t = await withTask(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    if (!t.branch) return c.json({ error: "该任务没有待推送的隔离分支" }, 400);
    try {
      const output = await pushBranch(t.workspace, t.branch, b.remote?.trim() || "origin");
      return c.json({ ok: true, output });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
  app.post("/tasks/:id/pr", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      confirm?: boolean; title?: string; body?: string; base?: string;
    };
    if (b.confirm !== true) return c.json({ error: "需要确认后才能建 PR" }, 400);
    const t = await withTask(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    if (!t.branch) return c.json({ error: "该任务没有待推送的隔离分支" }, 400);
    const title = b.title?.trim() || t.title || `子任务 ${t.role}`;
    const body =
      b.body?.trim() ||
      [t.diffStat ? `## 变更\n\n\`\`\`\n${t.diffStat}\n\`\`\`` : "", t.result?.summary ?? ""]
        .filter(Boolean)
        .join("\n\n");
    try {
      // gh 建 PR 要求分支已在远端
      await pushBranch(t.workspace, t.branch);
      const r = await createPullRequest(t.workspace, t.branch, title, body, b.base);
      if (r && "url" in r) return c.json({ ok: true, url: r.url });
      if (r && "error" in r) return c.json({ ok: false, error: r.error }, 400);
      // 没装 gh:给出 compare 链接,由用户自己开
      const remote = await remoteUrl(t.workspace);
      const compareUrl = remote ? `${remote}/compare/${t.baseSha ?? "main"}...${t.branch}` : null;
      return c.json({ ok: false, error: "未安装 gh,无法自动建 PR", compareUrl }, 400);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
  app.post("/tasks/:id/discard", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
    if (b.confirm !== true) return c.json({ error: "需要确认后才能丢弃" }, 400);
    const t = await withTask(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    if (t.status === "running") return c.json({ error: "任务还在运行,先停止再丢弃" }, 400);
    if (!t.worktree || !t.branch) return c.json({ error: "该任务没有待丢弃的隔离分支" }, 400);
    try {
      await removeWorktree(t.workspace, t.worktree, t.branch);
      taskStore.patch(t.id, { worktree: null, branch: null, diffStat: null });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // 修改会话:工作区(Code/Work 绑定项目目录)、标题重命名、归档开关;至少给一个字段
  app.patch("/sessions/:id", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      workspace?: string; title?: string; archived?: boolean; providerId?: string | null; model?: string | null;
    };
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    if (typeof b.workspace === "string" && b.workspace.trim()) {
      sets.push("workspace = ?");
      vals.push(b.workspace.trim());
    }
    if (typeof b.title === "string" && b.title.trim()) {
      sets.push("title = ?");
      vals.push(b.title.trim());
    }
    if (typeof b.archived === "boolean") {
      sets.push("archived = ?");
      vals.push(b.archived ? 1 : 0);
    }
    // 会话级模型(M3):providerId 为 null 表示跟随全局,此时一并清空 model
    if (b.providerId === null || (typeof b.providerId === "string" && b.providerId.trim())) {
      sets.push("provider_id = ?", "model = ?");
      vals.push(b.providerId ? b.providerId.trim() : null, b.providerId && typeof b.model === "string" && b.model.trim() ? b.model.trim() : null);
    }
    if (sets.length === 0) return c.json({ error: "缺少 workspace/title/archived/providerId" }, 400);
    const r = db
      .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals, c.req.param("id"));
    return Number(r.changes) > 0 ? c.json({ ok: true }) : c.json({ error: "session not found" }, 404);
  });

  // ---- 工具(阶段 4):PathGuard 限制在工作区内,危险命令拒绝,高危操作需 confirmed ----
  const auditTool = (type: string, payload: unknown) =>
    db.prepare("INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)").run(type, JSON.stringify(payload), now());

  app.get("/tools/shells", (c) => c.json(detectShells().map(({ id, name }) => ({ id, name }))));

  app.post("/tools/read", async (c) => {
    const b = (await c.req.json()) as { workspace: string; path: string };
    try {
      return c.json({ content: readTool(b.workspace, b.path) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "read failed" }, 400);
    }
  });
  app.post("/tools/write", async (c) => {
    const b = (await c.req.json()) as { workspace: string; path: string; content: string };
    try {
      const r = writeTool(b.workspace, b.path, b.content ?? "");
      auditTool("tool.write", { workspace: b.workspace, path: b.path, bytes: r.bytes });
      return c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "write failed" }, 400);
    }
  });
  // F7:先按权限规则判定。deny 直接 403;ask 且未确认返回 409 并给出规则与原因
  const shellVerdict = (workspace: string, command: string, confirmed?: boolean) => {
    const rules = loadPermissions(workspace, { homeDir: homedir() });
    const req = { kind: "Bash" as const, tool: "bash", command };
    const v = decide(rules, req);
    if (v.decision === "allow" || confirmed) return { ok: true as const, verdict: v };
    return { ok: false as const, verdict: v };
  };
  app.post("/tools/shell", async (c) => {
    const b = (await c.req.json()) as { workspace: string; command: string; shell?: string; confirmed?: boolean };
    const check = shellVerdict(b.workspace, b.command, b.confirmed);
    if (!check.ok) {
      const status = check.verdict.decision === "deny" ? 403 : 409;
      return c.json(
        { error: check.verdict.reason, needsConfirm: check.verdict.decision === "ask", rule: suggestRule({ kind: "Bash", tool: "bash", command: b.command }), reason: check.verdict.reason },
        status,
      );
    }
    try {
      const r = await shellExec({ ...b, confirmed: true });
      auditTool("tool.shell", { workspace: b.workspace, shell: r.shell, command: r.command, exitCode: r.exitCode });
      return c.json(r);
    } catch (e) {
      const err = e as Error & { needsConfirm?: boolean };
      return c.json({ error: err.message, needsConfirm: err.needsConfirm === true }, err.needsConfirm ? 409 : 400);
    }
  });

  // F7:流式执行。逐块推送输出,最后一条是完整结果;客户端断开时结束进程树
  app.post("/tools/shell/stream", async (c) => {
    const b = (await c.req.json()) as { workspace: string; command: string; shell?: string; confirmed?: boolean };
    const check = shellVerdict(b.workspace, b.command, b.confirmed);
    if (!check.ok) {
      const status = check.verdict.decision === "deny" ? 403 : 409;
      return c.json(
        { error: check.verdict.reason, needsConfirm: check.verdict.decision === "ask", rule: suggestRule({ kind: "Bash", tool: "bash", command: b.command }), reason: check.verdict.reason },
        status,
      );
    }
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      try {
        const r = await shellExec({
          ...b,
          confirmed: true,
          signal: ac.signal,
          onData: (data, s) => void stream.writeSSE({ data: JSON.stringify({ type: "output", stream: s, data }) }),
        });
        auditTool("tool.shell", { workspace: b.workspace, shell: r.shell, command: r.command, exitCode: r.exitCode });
        await stream.writeSSE({ data: JSON.stringify({ type: "result", ...r }) });
      } catch (e) {
        if (!ac.signal.aborted)
          await stream.writeSSE({ data: JSON.stringify({ type: "error", error: e instanceof Error ? e.message : "shell failed" }) });
      }
    });
  });

  // F7:权限规则查询与"本项目始终允许"
  app.get("/tools/permissions", (c) => {
    const workspace = c.req.query("workspace") ?? "";
    const rules = loadPermissions(workspace, { homeDir: homedir() });
    return c.json({ workspace, ...rules });
  });
  app.post("/tools/permissions/allow", async (c) => {
    const b = (await c.req.json()) as { workspace: string; rule: string };
    if (!b?.workspace || !b.rule?.trim()) return c.json({ error: "缺少 workspace 或 rule" }, 400);
    try {
      addAllowRule(b.workspace, b.rule.trim());
      auditTool("permissions.allow", { workspace: b.workspace, rule: b.rule.trim() });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "写入失败" }, 400);
    }
  });
  app.post("/tools/git/status", async (c) => {
    const b = (await c.req.json()) as { workspace: string };
    const r = await shellExec({ workspace: b.workspace, command: "git status --short --branch" });
    return c.json(r);
  });
  app.post("/tools/git/diff", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { workspace: string };
    try {
      const r = await shellExec({ workspace: b.workspace, command: "git diff HEAD" });
      // shellExec 对非零退出码不抛错(如非 git 目录),这里统一转为 400;
      // stderr 可能带整段 git usage,只取首行作为错误信息
      if (r.exitCode !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `git diff 失败:exit ${r.exitCode}`);
      return c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "diff failed" }, 400);
    }
  });
  app.post("/tools/git/preview", async (c) => {
    const b = (await c.req.json()) as { workspace: string };
    try {
      return c.json(await gitPreview(b.workspace));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "preview failed" }, 400);
    }
  });
  app.post("/tools/git/commit", async (c) => {
    const b = (await c.req.json()) as {
      workspace: string;
      message: string;
      files?: string[];
      confirmed?: boolean;
    };
    try {
      const r = await gitCommit(b);
      // 审计只记范围(路径列表)、消息与结果,不记文件内容。
      auditTool("git.commit", {
        workspace: b.workspace,
        message: b.message,
        files: b.files ?? [],
        exitCode: r.exitCode,
      });
      return c.json(r);
    } catch (e) {
      const err = e as Error & { needsConfirm?: boolean };
      return c.json({ error: err.message, needsConfirm: err.needsConfirm === true }, err.needsConfirm ? 409 : 400);
    }
  });
  app.post("/tools/list", async (c) => {
    const b = (await c.req.json()) as { workspace: string; path?: string };
    try {
      return c.json({ files: listTool(b.workspace, b.path) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "list failed" }, 400);
    }
  });

  // ---- Work(阶段 5):文档导入、来源记录、待办 ----
  app.get("/work/docs", (c) => c.json(work.listDocs(c.req.query("workspace") || undefined)));
  // F8:文档检索。返回命中块(bm25 排序),snippet 带高亮标记,前端点开定位到块。
  // 必须注册在 /work/docs/:id 之前,否则 "search" 会被当成 id。
  app.get("/work/docs/search", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json([]);
    const limit = Math.min(Number(c.req.query("limit")) || 10, 50);
    const hits = work.searchDocs(q, limit, c.req.query("workspace") || undefined);
    return c.json(
      hits.map((d) => ({
        docId: d.id, title: d.title, source: d.source, kind: d.kind, workspace: d.workspace,
        ord: d.ord, start: d.start, end: d.end, snippet: d.snippet,
      })),
    );
  });
  app.get("/work/docs/:id", (c) => {
    const d = work.getDoc(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  });
  app.post("/work/docs/import-file", async (c) => {
    const b = (await c.req.json()) as { workspace: string; path: string; sessionId?: string };
    try {
      const d = await work.importFile(b.workspace, b.path, b.sessionId);
      auditTool("work.doc.import", { kind: "file", source: d.source, title: d.title });
      return c.json(d);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "import failed" }, 400);
    }
  });
  app.post("/work/docs/import-url", async (c) => {
    const b = (await c.req.json()) as { url: string; workspace?: string; sessionId?: string };
    try {
      const r = await work.importUrl(b.url, b);
      auditTool("work.doc.import", { kind: "url", source: r.doc.source, finalUrl: r.finalUrl, bytes: r.bytes });
      return c.json(r.doc);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "fetch failed";
      auditTool("work.doc.import.rejected", { url: b.url, reason: msg });
      return c.json({ error: msg }, 400);
    }
  });
  app.post("/work/docs/paste", async (c) => {
    const b = (await c.req.json()) as { title: string; content: string; workspace?: string; sessionId?: string };
    if (!b.content?.trim()) return c.json({ error: "缺少 content" }, 400);
    return c.json(work.importPaste(b.title || "粘贴资料", b.content, b));
  });
  // F8:拖入 PDF / Word。文件只转成文本存为资料,不写进用户工作区
  app.post("/work/docs/upload", async (c) => {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!file || typeof file === "string") return c.json({ error: "缺少文件(multipart 字段 file)" }, 400);
    const workspace = typeof form?.workspace === "string" ? form.workspace : "";
    const sessionId = typeof form?.sessionId === "string" ? form.sessionId : undefined;
    if (!isConvertible(file.name)) return c.json({ error: "只支持拖入 PDF 或 Word(.docx)文件" }, 415);
    try {
      const r = await convertToText(file.name, Buffer.from(await file.arrayBuffer()));
      if (!r.text.trim()) return c.json({ error: r.warning ?? "文件没有可提取的文字" }, 415);
      const doc = work.importConverted(file.name, file.name, r.text, { workspace, sessionId });
      auditTool("work.doc.import", { kind: "upload", source: file.name, title: doc.title, bytes: r.text.length });
      return c.json(r.warning ? { ...doc, warning: r.warning } : doc);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "import failed" }, 400);
    }
  });
  app.delete("/work/docs/:id", (c) => {
    work.removeDoc(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/work/todos", (c) =>
    c.json(work.listTodos(c.req.query("workspace") || undefined, (c.req.query("status") || undefined) as "open" | "done" | undefined)),
  );
  app.post("/work/todos", async (c) => {
    const b = (await c.req.json()) as { title: string; due?: string; source?: string; workspace?: string; sessionId?: string };
    if (!b.title?.trim()) return c.json({ error: "缺少 title" }, 400);
    return c.json(work.addTodo(b));
  });
  app.post("/work/todos/:id/status", async (c) => {
    const b = (await c.req.json()) as { status: "open" | "done" };
    work.setTodoStatus(c.req.param("id"), b.status === "done" ? "done" : "open");
    return c.json({ ok: true });
  });
  app.delete("/work/todos/:id", (c) => {
    work.removeTodo(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- Skill(阶段 6):导入不自动启用,禁用后立即不再注入 ----
  app.get("/skills", (c) => c.json(skills.list()));

  // ---- B3:MCP ----
  app.get("/mcp/servers", async (c) => {
    const workspace = c.req.query("workspace") ?? "";
    const servers = await mcp.status(workspace);
    const tools = await mcp.toolList(workspace).catch(() => []);
    const { projectPending } = effectiveConfig(workspace);
    return c.json({ servers, tools, projectPending, projectTrusted: workspace ? isProjectTrusted(workspace) : true });
  });
  app.get("/mcp/config", (c) => {
    const workspace = c.req.query("workspace") ?? "";
    return c.json({ user: loadUserConfig(), project: workspace ? loadProjectConfig(workspace) : { mcpServers: {} } });
  });
  app.put("/mcp/config", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { user?: unknown } | null;
    const cfg = body?.user as { mcpServers?: unknown } | undefined;
    if (!cfg || typeof cfg !== "object" || typeof cfg.mcpServers !== "object" || cfg.mcpServers === null)
      return c.json({ error: "格式必须是 { mcpServers: { ... } }" }, 400);
    for (const [name, sc] of Object.entries(cfg.mcpServers as Record<string, unknown>)) {
      if (!name.trim()) return c.json({ error: "服务器名不能为空" }, 400);
      const s = sc as Record<string, unknown>;
      const remote = s.type === "http" || s.type === "sse";
      if (remote ? typeof s.url !== "string" : typeof s.command !== "string")
        return c.json({ error: `${name}:${remote ? "缺少 url" : "缺少 command"}` }, 400);
    }
    saveUserConfig(cfg as { mcpServers: Record<string, never> });
    return c.json({ ok: true });
  });
  app.post("/mcp/servers/:name/restart", async (c) => {
    const workspace = c.req.query("workspace") ?? "";
    const ok = await mcp.restart(workspace, c.req.param("name"));
    return c.json({ ok });
  });
  // 项目级配置信任:首次使用前需批准;内容变化后需重新批准
  app.post("/mcp/trust", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { workspace?: string; revoke?: boolean };
    if (!b.workspace) return c.json({ error: "缺少 workspace" }, 400);
    if (b.revoke) revokeProjectTrust(b.workspace);
    else trustProject(b.workspace);
    return c.json({ ok: true, trusted: isProjectTrusted(b.workspace) });
  });
  app.post("/mcp/import/claude-desktop/preview", (c) => c.json(previewClaudeDesktopImport()));
  app.post("/mcp/import/claude-desktop/apply", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { names?: unknown };
    const names = Array.isArray(b.names) ? b.names.filter((x): x is string => typeof x === "string") : [];
    if (!names.length) return c.json({ error: "缺少 names" }, 400);
    return c.json(applyClaudeDesktopImport(names));
  });
  app.post("/skills/import", async (c) => {
    const b = (await c.req.json()) as { path: string };
    try {
      const s = skills.import(b.path);
      auditTool("skill.import", { id: s.id, version: s.version, warnings: s.warnings });
      return c.json(s);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "import failed" }, 400);
    }
  });
  app.post("/skills/:id/enable", (c) => {
    if (!skills.get(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    skills.setEnabled(c.req.param("id"), true);
    auditTool("skill.enable", { id: c.req.param("id") });
    return c.json({ ok: true });
  });
  app.post("/skills/:id/disable", (c) => {
    skills.setEnabled(c.req.param("id"), false);
    auditTool("skill.disable", { id: c.req.param("id") });
    return c.json({ ok: true });
  });
  app.delete("/skills/:id", (c) => {
    skills.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  // 审计日志查看(权限与安全页)
  app.get("/events", (c) => {
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const rows = db.prepare("SELECT type, payload, created_at FROM events ORDER BY id DESC LIMIT ?").all(limit);
    return c.json(rows);
  });

  // 手动备份数据库(升级/迁移前也会自动备份到 data/backups/)
  app.post("/admin/backup", (c) => {
    const dest = backupDb(join(DATA_DIR, "app.db"));
    return dest ? c.json({ ok: true, path: dest }) : c.json({ error: "数据库不存在或为空" }, 400);
  });

  // ---- 数据导入导出(优化阶段 5)----
  // 导出会话+消息+资料+待办+记忆事实。不含 API Key、运行时任务和审计正文。
  const EXPORT_KIND = "xiyun-export";
  // v2(F6):消息带 id / parent_id(消息树)与 ref_context / ctx_trim;会话带 head_id 与摘要。v1 包按单链导入
  const EXPORT_VERSION = 2;

  app.get("/admin/export", (c) => {
    const sessions = db.prepare("SELECT * FROM sessions ORDER BY created_at").all() as Array<Record<string, unknown>>;
    const messages = db
      .prepare("SELECT id, parent_id, session_id, role, content, blocks, aborted, usage, error, model, ref_context, ctx_trim, created_at FROM messages ORDER BY id")
      .all();
    const docs = db.prepare("SELECT * FROM docs ORDER BY created_at").all();
    const todos = db.prepare("SELECT * FROM todos ORDER BY created_at").all();
    const facts = db.prepare("SELECT * FROM facts WHERE deleted_at IS NULL ORDER BY valid_from").all();
    // 附件(B2)以 base64 随包导出,导入时按 sha256 校验
    return c.json({
      kind: EXPORT_KIND, version: EXPORT_VERSION, exportedAt: now(),
      data: { sessions, messages, docs, todos, facts, attachments: attachments.exportAll() },
    });
  });

  // 导入前预览:统计新增/重复(同 id),不写库
  app.post("/admin/import/preview", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { kind?: string; version?: number; data?: Record<string, unknown[]> } | null;
    if (!body || body.kind !== EXPORT_KIND || typeof body.version !== "number" || !body.data)
      return c.json({ error: "不是有效的导出包(kind/version/data 缺失或不匹配)" }, 400);
    if (body.version > EXPORT_VERSION) return c.json({ error: `导出包版本 v${body.version} 高于当前支持的 v${EXPORT_VERSION},请升级应用` }, 400);
    const count = (table: string, rows: unknown[] | undefined) => {
      const list = Array.isArray(rows) ? rows : [];
      let dup = 0;
      const stmt = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
      for (const r of list) {
        const id = (r as { id?: unknown }).id;
        if (typeof id === "string" && stmt.get(id)) dup++;
      }
      return { total: list.length, duplicate: dup, added: list.length - dup };
    };
    const d = body.data;
    return c.json({
      sessions: count("sessions", d.sessions),
      docs: count("docs", d.docs),
      todos: count("todos", d.todos),
      facts: count("facts", d.facts),
      messages: { total: Array.isArray(d.messages) ? d.messages.length : 0 },
      attachments: count("attachments", d.attachments),
    });
  });

  // 导入:同 id 跳过(不覆盖),整体一个事务,失败回滚不破坏已有数据
  app.post("/admin/import", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { kind?: string; version?: number; data?: Record<string, unknown[]> } | null;
    if (!body || body.kind !== EXPORT_KIND || typeof body.version !== "number" || !body.data)
      return c.json({ error: "不是有效的导出包" }, 400);
    if (body.version > EXPORT_VERSION) return c.json({ error: `导出包版本 v${body.version} 高于当前支持的 v${EXPORT_VERSION}` }, 400);
    const d = body.data;
    const skip = { sessions: 0, docs: 0, todos: 0, facts: 0 };
    const add = { sessions: 0, docs: 0, todos: 0, facts: 0, messages: 0 };
    try {
      db.exec("BEGIN");
      const insSession = db.prepare(
        "INSERT INTO sessions (id, title, mode, workspace, created_at, archived, updated_at, provider_id, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const str = (v: unknown) => (typeof v === "string" && v ? v : null);
      const hasSession = db.prepare("SELECT 1 FROM sessions WHERE id = ?");
      const sessionIds = new Set<string>();
      const newSessions = new Set<string>();
      for (const r of (d.sessions ?? []) as Array<Record<string, unknown>>) {
        if (typeof r.id !== "string") continue;
        sessionIds.add(r.id);
        if (hasSession.get(r.id)) { skip.sessions++; continue; }
        newSessions.add(r.id);
        // 旧导出包没有 updated_at:先留空,消息导入后按最后一条消息回填
        // provider_id 在本机不存在时 /chat 自动回退全局模型
        insSession.run(r.id, String(r.title ?? "导入会话"), String(r.mode ?? "chat"), String(r.workspace ?? ""), String(r.created_at ?? now()), r.archived ? 1 : 0, typeof r.updated_at === "string" ? r.updated_at : null, str(r.provider_id), str(r.model));
        add.sessions++;
      }
      const insMsg = db.prepare(
        `INSERT INTO messages (session_id, role, content, blocks, aborted, usage, error, model, parent_id, ref_context, ctx_trim, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // 消息无全局唯一 id,重复导入同一导出包时按 (session_id, role, content, created_at) 去重,避免二次落库
      const hasMsg = db.prepare("SELECT id FROM messages WHERE session_id = ? AND role = ? AND content = ? AND created_at = ?");
      // 包内 id → 本库 id(v2 消息树);v1 包没有 id / parent_id,按会话内顺序串成单链
      const idMap = new Map<number, number>();
      const lastOf = new Map<string, number>();
      for (const r of (d.messages ?? []) as Array<Record<string, unknown>>) {
        if (typeof r.session_id !== "string" || !sessionIds.has(r.session_id)) continue;
        const role = String(r.role ?? "user"), content = String(r.content ?? ""), created = String(r.created_at ?? now());
        const oldId = typeof r.id === "number" ? r.id : null;
        const parent =
          oldId == null
            ? (lastOf.get(r.session_id) ?? null)
            : typeof r.parent_id === "number" ? (idMap.get(r.parent_id) ?? null) : null;
        const dup = hasMsg.get(r.session_id, role, content, created) as { id: number } | undefined;
        if (dup) {
          if (oldId != null) idMap.set(oldId, dup.id);
          lastOf.set(r.session_id, dup.id);
          continue;
        }
        // 非合法 JSON 的 blocks 存 NULL,避免把坏数据带进来
        let blocks: string | null = null;
        if (typeof r.blocks === "string") {
          try {
            JSON.parse(r.blocks);
            blocks = r.blocks;
          } catch {
            blocks = null;
          }
        }
        // usage 同样只接受可解析的 JSON;旧导出包没有该字段
        const usageJson = typeof r.usage === "string" && parseUsage(r.usage) ? r.usage : null;
        const error = typeof r.error === "string" && r.error ? r.error.slice(0, 500) : null;
        const trimJson = typeof r.ctx_trim === "string" && parseTrim(r.ctx_trim) ? r.ctx_trim : null;
        const res = insMsg.run(
          r.session_id, role, content, blocks, r.aborted ? 1 : 0, usageJson, error, str(r.model)?.slice(0, 200) ?? null,
          parent, str(r.ref_context), trimJson, created,
        );
        const nid = Number(res.lastInsertRowid);
        if (oldId != null) idMap.set(oldId, nid);
        lastOf.set(r.session_id, nid);
        add.messages++;
      }
      // 新导入的会话:head 指向包里记录的分支末端(映射后),缺省为最后一条;摘要覆盖点同样映射
      const setHead = db.prepare("UPDATE sessions SET head_id = ?, summary = ?, summary_upto_id = ? WHERE id = ?");
      for (const r of (d.sessions ?? []) as Array<Record<string, unknown>>) {
        if (typeof r.id !== "string" || !newSessions.has(r.id)) continue;
        const head = (typeof r.head_id === "number" ? idMap.get(r.head_id) : undefined) ?? lastOf.get(r.id) ?? null;
        const upto = typeof r.summary_upto_id === "number" ? idMap.get(r.summary_upto_id) : undefined;
        setHead.run(head, upto != null ? str(r.summary) : null, upto ?? null, r.id);
      }
      db.exec(
        `UPDATE sessions SET updated_at = COALESCE((SELECT MAX(created_at) FROM messages WHERE messages.session_id = sessions.id), created_at)
         WHERE updated_at IS NULL`,
      );
      const simple = (table: string, cols: string[], rows: unknown[] | undefined, key: keyof typeof skip) => {
        const has = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
        const ins = db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
        for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
          if (typeof r.id !== "string") continue;
          if (has.get(r.id)) { skip[key]++; continue; }
          ins.run(...cols.map((col) => (r[col] === undefined ? null : r[col]) as never));
          add[key]++;
        }
      };
      simple("docs", ["id", "title", "kind", "source", "content", "workspace", "session_id", "created_at"], d.docs, "docs");
      simple("todos", ["id", "title", "status", "due", "source", "workspace", "session_id", "created_at", "done_at"], d.todos, "todos");
      simple("facts", ["id", "content", "source", "confidence", "scope", "valid_from", "valid_to", "deleted_at"], d.facts, "facts");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      return c.json({ error: `导入失败,已回滚:${e instanceof Error ? e.message : String(e)}` }, 400);
    }
    // 附件在主事务提交后写入(文件不在事务里);校验失败的单个附件跳过,不影响其余数据
    const att = { added: 0, skipped: 0, invalid: 0 };
    for (const r of (Array.isArray(d.attachments) ? d.attachments : []) as Array<Record<string, unknown>>) {
      try {
        if (attachments.restore(r)) att.added++;
        else att.skipped++;
      } catch {
        att.invalid++;
      }
    }
    db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('data.import', ?, ?)").run(
      JSON.stringify({ added: add, skipped: skip, attachments: att }), now(),
    );
    return c.json({ ok: true, added: add, skipped: skip, attachments: att });
  });

  // ---- 从 ChatGPT / Claude 导入历史对话(M1):body 为 conversations.json 原文(ZIP 由前端解开)----
  // 每个对话成为一个 Chat 会话,保留原分支;按 (来源, 原对话 id) 去重,重复导入跳过
  const readExternal = async (c: Context): Promise<{ source: ExternalSource; conversations: ExternalConversation[] } | Response> => {
    try {
      return parseExternal(await c.req.json().catch(() => null));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  };
  const hasExternal = db.prepare("SELECT 1 FROM sessions WHERE external_source = ? AND external_id = ?");
  app.post("/admin/import/external/preview", async (c) => {
    const parsed = await readExternal(c);
    if (parsed instanceof Response) return parsed;
    const convs = parsed.conversations.filter((x) => x.messages.length);
    const dates = convs.map((x) => x.createdAt).sort();
    // L2:可提取记忆的会话数(至少 2 轮 user)与 token 估算,供前端展示成本
    const extractable = convs.filter((x) => x.messages.filter((m) => m.role === "user").length >= 2);
    const estTokens = extractable.reduce(
      (n, x) => n + estimateTokens(x.messages.map((m) => m.content).join("\n")),
      0,
    );
    return c.json({
      source: parsed.source,
      conversations: convs.length,
      messages: convs.reduce((n, x) => n + x.messages.length, 0),
      duplicate: convs.filter((x) => hasExternal.get(parsed.source, x.externalId)).length,
      empty: parsed.conversations.length - convs.length,
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
      extractable: extractable.length,
      estimatedTokens: estTokens,
    });
  });
  app.post("/admin/import/external", async (c) => {
    const parsed = await readExternal(c);
    if (parsed instanceof Response) return parsed;
    // L2:导入后可选从这些对话批量提取记忆(前端在预览弹窗勾选,用 ?extract=1 传)
    const extract = c.req.query("extract") === "1";
    const added = { sessions: 0, messages: 0 };
    const addedIds: string[] = [];
    const skipped = { duplicate: 0, empty: 0 };
    try {
      db.exec("BEGIN");
      const insSession = db.prepare(
        "INSERT INTO sessions (id, title, mode, workspace, created_at, updated_at, external_source, external_id) VALUES (?, ?, 'chat', ?, ?, ?, ?, ?)",
      );
      const insMsg = db.prepare("INSERT INTO messages (session_id, role, content, parent_id, created_at) VALUES (?, ?, ?, ?, ?)");
      const setHead = db.prepare("UPDATE sessions SET head_id = ? WHERE id = ?");
      for (const conv of parsed.conversations) {
        if (!conv.messages.length) { skipped.empty++; continue; }
        if (hasExternal.get(parsed.source, conv.externalId)) { skipped.duplicate++; continue; }
        const sid = randomUUID();
        const lastAt = conv.messages.reduce((m, x) => (x.createdAt > m ? x.createdAt : m), conv.updatedAt);
        insSession.run(sid, conv.title.slice(0, 80), process.cwd(), conv.createdAt, lastAt, parsed.source, conv.externalId.slice(0, 200));
        const idOf = new Map<string, number>();
        for (const m of conv.messages) {
          const parent = m.parentKey == null ? null : (idOf.get(m.parentKey) ?? null);
          idOf.set(m.key, Number(insMsg.run(sid, m.role, m.content, parent, m.createdAt).lastInsertRowid));
          added.messages++;
        }
        setHead.run(conv.headKey == null ? null : (idOf.get(conv.headKey) ?? null), sid);
        added.sessions++;
        addedIds.push(sid);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      return c.json({ error: `导入失败,已回滚:${e instanceof Error ? e.message : String(e)}` }, 400);
    }
    db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('data.import.external', ?, ?)").run(
      JSON.stringify({ source: parsed.source, added, skipped }), now(),
    );
    // L2:勾选了就创建提取作业(至少 2 轮 user 的会话才进队列);
    // 记忆模型没配置时不让整次导入失败,只返回提示
    let job: ReturnType<MemoryJobRunner["create"]> | null = null;
    let jobError: string | undefined;
    if (extract && addedIds.length) {
      const usable = addedIds.filter(
        (sid) => (db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ? AND role = 'user'").get(sid) as { c: number }).c >= 2,
      );
      if (!memoryProvider()) jobError = "没有可用的记忆模型,已导入但未提取记忆";
      else if (!usable.length) jobError = "导入的对话不足 2 轮,没有可提取的内容";
      else {
        job = memoryJobs.create({ source: `import:${parsed.source}`, sessionIds: usable, scope: "global" });
        void memoryJobs.run(job.id);
      }
    }
    return c.json({ ok: true, source: parsed.source, added, skipped, ...(job ? { job } : {}), ...(jobError ? { jobError } : {}) });
  });

  return app;
}
