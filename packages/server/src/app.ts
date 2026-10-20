import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRole, ChatBlock, ChatMessage, ProviderConfig, SessionMeta, TaskStatus } from "@xiyun/shared";
import type { ChatProvider, ProviderEvent, ToolDef } from "../../runtime/src/index.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";
import { assertInside, loadRuleFiles } from "./workspace.ts";
import { extractMemories } from "./extract.ts";
import { runMemoryTool } from "./memchat.ts";
import { WorkStore } from "./docs.ts";
import { SkillStore } from "./skills.ts";
import { MAX_GROUP_TASKS, Scheduler, TaskStore } from "./tasks.ts";
import { detectShells, gitCommit, gitPreview, listTool, readTool, shellExec, writeTool } from "./tools.ts";
import { DATA_DIR, backupDb } from "./db.ts";

const now = () => new Date().toISOString();

// opts.chatProvider 仅用于测试注入;缺省仍走 ProviderStore。
export function createApp(
  db: DatabaseSync,
  memory: MemoryStore,
  providers: ProviderStore,
  opts?: { chatProvider?: () => ChatProvider },
) {
  const app = new Hono();
  // CORS 白名单:只放行本机来源(localhost/127.0.0.1/[::1] 的 http(s),覆盖 vite 5173 与桌面渲染器)。
  // 无 Origin 头(非浏览器/curl/Electron 主进程)不写 ACAO 也照常放行;外部来源与 "null"(file:// 沙箱页面)
  // 返回 undefined,响应不含 Access-Control-Allow-Origin,预检同样不通过,由浏览器拦截。
  app.use("*", cors({ origin: (o) => (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o) ? o : undefined) }));

  const taskStore = new TaskStore(db);
  const work = new WorkStore(db);
  const skills = new SkillStore(db, DATA_DIR);
  const scheduler = new Scheduler({
    store: taskStore,
    memory,
    registry: () => providers.registry(),
    skillsFor: (mode, role) => skills.promptFor(mode, role),
    onEvent: (type, payload) =>
      db.prepare("INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)").run(
        type, JSON.stringify(payload), now(),
      ),
  });
  // 启动恢复:上次中断的 queued/running 任务重新拉起。
  const recovered = scheduler.recover();
  if (recovered > 0)
    db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('task.recovered', ?, ?)").run(
      JSON.stringify({ count: recovered }), now(),
    );

  // 记忆提取专用 Provider:memory 角色优先,回退 main/激活。未配置则不提取。
  const memoryProvider = () =>
    providers.registry().byRole("memory") ?? providers.registry().byRole("main") ?? providers.activeProvider();

  // 回复完成后异步提取候选记忆,不阻塞 SSE;失败只记事件(R-004:低置信度只进候选区)。
  const queueExtract = (sessionId: string, mode: string, workspace: string) => {
    const provider = memoryProvider();
    if (!provider) return;
    const history = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 12")
      .all(sessionId)
      .reverse() as unknown as ChatMessage[];
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
    const p = providers.probeProvider(c.req.param("id"));
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
    const sql = `SELECT * FROM sessions ${where} ORDER BY created_at DESC` + (limit ? " LIMIT ? OFFSET ?" : "");
    const rows = (limit
      ? db.prepare(sql).all(...args, limit, offset)
      : db.prepare(sql).all(...args)) as Array<Record<string, string | number>>;
    const list = rows.map((r) => ({
      id: r.id, title: r.title, mode: r.mode, workspace: r.workspace,
      createdAt: r.created_at, archived: Number(r.archived) === 1,
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
    db.prepare("INSERT INTO sessions (id, title, mode, workspace, created_at) VALUES (?, ?, ?, ?, ?)").run(
      s.id, s.title, s.mode, s.workspace, s.createdAt,
    );
    return c.json(s);
  });
  app.delete("/sessions/:id", (c) => {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(c.req.param("id"));
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(c.req.param("id"));
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

  app.get("/sessions/:id/messages", (c) => {
    const rows = db
      .prepare("SELECT id, role, content, blocks, aborted FROM messages WHERE session_id = ? ORDER BY id")
      .all(c.req.param("id")) as unknown as Array<{
      id: number; role: string; content: string; blocks: string | null; aborted: number;
    }>;
    return c.json(
      rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        blocks: parseBlocks(r.blocks),
        aborted: r.aborted ? true : undefined,
      })),
    );
  });
  // 编辑某条 user 消息:删除该条及其后所有消息,返回被删前的消息(供前端重新发送)。
  // 用于"编辑并重新生成"——截断历史后由 /chat 重新走一轮。
  app.post("/sessions/:id/messages/:mid/truncate", (c) => {
    const sessionId = c.req.param("id");
    const mid = Number(c.req.param("mid"));
    const target = db.prepare("SELECT id, role FROM messages WHERE id = ? AND session_id = ?").get(mid, sessionId) as
      | { id: number; role: string }
      | undefined;
    if (!target) return c.json({ error: "message not found" }, 404);
    db.prepare("DELETE FROM messages WHERE session_id = ? AND id >= ?").run(sessionId, mid);
    return c.json({ ok: true });
  });
  // 分支:把某条消息(含)之前的所有消息复制到一个新会话,返回新会话。
  app.post("/sessions/:id/branch", async (c) => {
    const sessionId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { messageId?: number; title?: string };
    const src = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | { id: string; title: string; mode: string; workspace: string }
      | undefined;
    if (!src) return c.json({ error: "session not found" }, 404);
    const maxId = typeof body.messageId === "number" ? body.messageId : Number.MAX_SAFE_INTEGER;
    const msgs = db
      .prepare("SELECT role, content, blocks, aborted, created_at FROM messages WHERE session_id = ? AND id <= ? ORDER BY id")
      .all(sessionId, maxId) as unknown as Array<{
      role: string; content: string; blocks: string | null; aborted: number; created_at: string;
    }>;
    const nid = randomUUID();
    const title = (body.title?.trim() || `${src.title}(分支)`).slice(0, 80);
    const ts = now();
    db.prepare("INSERT INTO sessions (id, title, mode, workspace, created_at) VALUES (?, ?, ?, ?, ?)").run(
      nid, title, src.mode, src.workspace, ts,
    );
    const ins = db.prepare(
      "INSERT INTO messages (session_id, role, content, blocks, aborted, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const m of msgs) ins.run(nid, m.role, m.content, m.blocks, m.aborted, m.created_at);
    return c.json({ id: nid, title, mode: src.mode, workspace: src.workspace, createdAt: ts });
  });

  // ---- Chat:规则文件 + 相关记忆 + 历史,流式回复,落库 ----
  app.post("/chat", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: string;
      message?: string;
      regenerate?: boolean;
      context?: string;
      refs?: Array<{ refType: "message" | "doc" | "file"; label: string; excerpt: string }>;
    };
    if (!body.sessionId || typeof body.message !== "string" || !body.message.trim())
      return c.json({ error: "缺少 sessionId/message" }, 400);
    // 解构为常量,保证闭包内类型收窄不失效
    const sessionId = body.sessionId;
    const message = body.message;
    // regenerate=true:对同一 user 消息重新生成——不重复落库 user 消息,并替换上一条 assistant 回复
    const regenerate = body.regenerate === true;
    // context 只进入模型消息,refs 只作为展示块落库(D5)
    const context = typeof body.context === "string" ? body.context : "";
    const refs = Array.isArray(body.refs) ? body.refs : [];
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | { id: string; workspace: string; mode: string }
      | undefined;
    if (!session) return c.json({ error: "session not found" }, 404);
    // D1:激活 Provider 优先,角色兜底——模型下拉才能生效
    const provider = opts?.chatProvider?.() ?? providers.activeProvider() ?? providers.registry().byRole("main");
    if (!provider) return c.json({ error: "no provider configured" }, 400);

    const rules = loadRuleFiles(session.workspace, { dataDir: DATA_DIR, mode: session.mode });
    const scopes = ["global", session.mode, session.workspace];
    // 记忆链路只用用户原话:引用上下文不参与记忆指令与检索(D5)
    const memNote = await runMemoryTool({ provider, memory, message: message, scopes, scope: session.mode });
    let facts = memory.search(message, 5, scopes);
    // 无主题词的泛化提问("我上次学到哪了")召回为空时,回退到最近的有效记忆。
    if (facts.length === 0) facts = memory.recent(5, scopes);
    const memories = facts.map((f) => `- ${f.content}`);
    const history = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 20")
      .all(sessionId)
      .reverse() as unknown as ChatMessage[];

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
      memNote && `# 记忆操作\n${memNote}\n请在回复中向用户确认该操作结果。`,
      rules && `# 规则\n${rules}`,
      skills.promptFor(session.mode) && `# 已启用 Skill\n${skills.promptFor(session.mode)}`,
      memories.length && `# 相关记忆\n${memories.join("\n")}`,
      docHits.length > 0 &&
        `# 相关资料(引用时标注来源)\n${docHits.map((d) => `## ${d.title}(来源:${d.source})\n${d.snippet}`).join("\n\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    if (regenerate) {
      // 历史里摘掉最后一条 assistant,避免旧答案影响重新生成
      const last = history[history.length - 1];
      if (last?.role === "assistant") history.pop();
      // 末尾是与本次相同的 user 时也弹出,避免同一句话出现两次
      const lastUser = history[history.length - 1];
      if (lastUser?.role === "user" && lastUser.content === message) history.pop();
    }

    const modelMessage = context ? `${message}\n\n# 引用上下文\n${context}` : message;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: modelMessage },
    ];

    // user 落库:content 只存原话,refs 作为 ref 块(D5)
    let userMessageId: number | null = null;
    if (!regenerate) {
      const r = db
        .prepare("INSERT INTO messages (session_id, role, content, blocks, created_at) VALUES (?, 'user', ?, ?, ?)")
        .run(
          sessionId,
          message,
          refs.length
            ? JSON.stringify(refs.map((r2, i) => ({ id: `ref${i + 1}`, kind: "ref", ...r2 })))
            : null,
          now(),
        );
      userMessageId = Number(r.lastInsertRowid);
    } else {
      const prev = db
        .prepare("SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
        .get(sessionId) as { id: number } | undefined;
      userMessageId = prev?.id ?? null;
    }

    // D2:工具定义默认不下发,需显式开启环境变量且 Provider 声明 tools 能力
    const READONLY_TOOLS: ToolDef[] = [
      {
        name: "list_files",
        description: "列出工作区内的文件(相对路径)",
        parameters: { type: "object", properties: { path: { type: "string", description: "子目录,默认 ." } } },
      },
      {
        name: "read_file",
        description: "读取工作区内的文件内容",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ];
    const exposeTools =
      provider.config.capabilities?.includes("tools") && process.env.XIYUN_EXPOSE_TOOLS === "1" && !!session.workspace;
    const tools = exposeTools ? READONLY_TOOLS : undefined;

    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      // stream.onAbort 只在部分适配器触发;真实 HTTP 中断由请求信号透出,两者都接
      stream.onAbort(() => ac.abort());
      // 若在准备上下文期间客户端就已断开,信号已 aborted,监听不会再触发,先补一次
      if (c.req.raw.signal.aborted) ac.abort();
      c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });

      // SSE 写按序入队、不阻塞状态机:客户端停止读取时 writeSSE 会一直挂着,
      // 若 await 它,中断后状态机再也拿不到控制权;stream.close() 会等待队列写完。
      let writing: Promise<unknown> = Promise.resolve();
      const send = (obj: unknown) => {
        writing = writing.then(() => stream.writeSSE({ data: JSON.stringify(obj) })).catch(() => {});
        return writing;
      };

      const blocks: ChatBlock[] = [];
      const toolBlocks = new Map<string, Extract<ChatBlock, { kind: "tool" }>>();
      // 已收到 tool_end 的调用;中断时据此区分已结束与半截的工具
      const finishedTools = new Set<string>();
      // open 记录已入列块的下标,关闭时原地更新,避免同一段内容入列两次
      let open: { kind: "text" | "thinking" | "tool"; id: string; text: string; t0: number; idx: number } | null = null;
      let seq = 0;
      let finishReason: string | null = null;

      const closeOpen = () => {
        const b = open;
        if (!b) return;
        open = null;
        if (b.kind === "thinking") {
          const block: ChatBlock = { id: b.id, kind: "thinking", text: b.text, durationMs: Date.now() - b.t0 };
          blocks[b.idx] = block;
          void send({ type: "block_end", id: b.id, block });
        } else if (b.kind === "text") {
          const block: ChatBlock = { id: b.id, kind: "text", text: b.text };
          blocks[b.idx] = block;
          void send({ type: "block_end", id: b.id, block });
        }
      };

      const ensureText = () => {
        if (open?.kind === "text") return open;
        closeOpen();
        seq += 1;
        const block: ChatBlock = { id: `t${seq}`, kind: "text", text: "" };
        const idx = blocks.push(block) - 1;
        open = { kind: "text", id: block.id, text: "", t0: Date.now(), idx };
        void send({ type: "block", id: block.id, block: { kind: "text" } });
        return open;
      };

      const finishTool = (id: string) => {
        const b = toolBlocks.get(id);
        if (!b) return;
        try {
          b.args = JSON.parse(b.rawArgs || "{}") as unknown;
          b.status = "pending";
        } catch (e) {
          b.argsError = e instanceof Error ? e.message : "参数解析失败";
          b.status = "error";
        }
        // target 由服务端填写:工作区来自 session,路径必须落在工作区内
        if (session.workspace) {
          b.target = { workspace: session.workspace };
          const p = (b.args as { path?: unknown } | undefined)?.path;
          if (typeof p === "string") {
            try {
              assertInside(session.workspace, p);
              b.target.path = p;
            } catch {
              // 越界路径不填 target.path
            }
          }
        }
        finishedTools.add(id);
        if (open?.kind === "tool" && open.id === id) open = null;
        void send({ type: "block_end", id, block: b });
      };

      // 中断收尾:没等到 tool_end 的调用标记为 error 并补发 block_end,避免客户端卡片停在 pending
      const closeUnfinishedTools = () => {
        for (const [id, b] of toolBlocks) {
          if (finishedTools.has(id)) continue;
          b.status = "error";
          b.note = "已中断";
          finishedTools.add(id);
          void send({ type: "block_end", id, block: b });
        }
        open = null;
      };

      let it: AsyncIterator<ProviderEvent> | null = null;
      try {
        const iter: AsyncIterable<ProviderEvent> = provider.streamEvents
          ? provider.streamEvents(messages, { signal: ac.signal, tools })
          : (async function* () {
              for await (const d of provider.streamChat(messages, { signal: ac.signal })) {
                yield { type: "text", delta: d } as ProviderEvent;
              }
            })();
        it = iter[Symbol.asyncIterator]();

        // 与中断竞速:Provider 不响应 signal 时也能立即收尾落库,不把流挂死
        const interrupted = new Promise<{ aborted: true }>((resolve) => {
          const onAbort = () => resolve({ aborted: true });
          if (ac.signal.aborted) onAbort();
          else ac.signal.addEventListener("abort", onAbort, { once: true });
        });
        for (;;) {
          // 已中断时不再等待 Provider
          const step = ac.signal.aborted
            ? ({ aborted: true } as const)
            : await Promise.race([it.next(), interrupted]);
          if ("aborted" in step) throw Object.assign(new Error("aborted"), { name: "AbortError" });
          if (step.done) break;
          const ev = step.value;
          if (ev.type === "text") {
            const o = ensureText();
            o.text += ev.delta;
            const cur = blocks[o.idx];
            if (cur?.kind === "text") cur.text = o.text;
            void send({ delta: ev.delta, id: o.id });
          } else if (ev.type === "thinking") {
            if (open?.kind !== "thinking") {
              closeOpen();
              seq += 1;
              const idx = blocks.push({ id: `r${seq}`, kind: "thinking", text: "" }) - 1;
              open = { kind: "thinking", id: `r${seq}`, text: "", t0: Date.now(), idx };
              void send({ type: "block", id: open.id, block: { kind: "thinking" } });
            }
            open.text += ev.delta;
            const cur = blocks[open.idx];
            if (cur?.kind === "thinking") cur.text = open.text;
            void send({ type: "block_delta", id: open.id, delta: ev.delta });
          } else if (ev.type === "tool_start") {
            closeOpen();
            const block: Extract<ChatBlock, { kind: "tool" }> = {
              id: ev.id, kind: "tool", name: ev.name, rawArgs: "", status: "pending",
            };
            toolBlocks.set(ev.id, block);
            const idx = blocks.push(block) - 1;
            open = { kind: "tool", id: ev.id, text: "", t0: Date.now(), idx };
            void send({ type: "block", id: ev.id, block: { kind: "tool", name: ev.name, status: "pending" } });
          } else if (ev.type === "tool_args") {
            const b = toolBlocks.get(ev.id);
            if (b) b.rawArgs += ev.delta;
            void send({ type: "block_delta", id: ev.id, delta: ev.delta });
          } else if (ev.type === "tool_end") {
            const b = toolBlocks.get(ev.id);
            if (b) b.rawArgs = ev.args;
            finishTool(ev.id);
          } else if (ev.type === "finish") {
            finishReason = ev.reason;
          }
        }

        closeOpen();

        // 仅 tool_calls 且无正文时兜底,保证 content 非空
        const hasText = blocks.some((b) => b.kind === "text" && b.text.trim());
        if (finishReason === "tool_calls" && !hasText) {
          seq += 1;
          const id = `t${seq}`;
          const note = "（模型请求调用工具，当前版本不执行工具。）";
          const block: ChatBlock = { id, kind: "text", text: note };
          blocks.push(block);
          void send({ type: "block", id, block: { kind: "text" } });
          void send({ delta: note, id });
          void send({ type: "block_end", id, block });
        }

        if (ac.signal.aborted) {
          // 中断时为未结束的工具补 error/note
          closeUnfinishedTools();
          const content = textOf(blocks);
          // 全空则什么都不落,避免留下空 assistant 行
          if (content || blocks.length) persist({ content, blocks, aborted: true });
          return;
        }
        const content = textOf(blocks);
        const messageId = persist({ content, blocks, aborted: false });
        db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('chat', ?, ?)").run(
          JSON.stringify({ sessionId, user: message, assistant: content }), now(),
        );
        void send({ done: true, messageId, userMessageId });
        queueExtract(sessionId, session.mode, session.workspace);
      } catch (e) {
        // 中断后不再消费 Provider;主动关闭迭代器,让上游连接释放
        if (ac.signal.aborted) void it?.return?.();
        closeOpen();
        if (ac.signal.aborted) {
          closeUnfinishedTools();
          const content = textOf(blocks);
          if (content || blocks.length) persist({ content, blocks, aborted: true });
          return;
        }
        // 不把异常原文(可能含请求信息)直接外发,也不落 assistant
        void send({ error: e instanceof Error ? e.message : "provider error" });
      } finally {
        // 客户端已断开时 writeSSE 可能永久挂起,不再等待,让响应流直接关闭
        if (!ac.signal.aborted) await writing;
      }

      function textOf(list: ChatBlock[]): string {
        return list
          .filter((b): b is Extract<ChatBlock, { kind: "text" }> => b.kind === "text")
          .map((b) => b.text)
          .join("");
      }

      // regenerate 只在会话末条确实是 assistant 时替换;U1/A1/U2 出错重试不得删 A1。
      // 删除与插入同一事务,避免删成功但插入失败丢历史。
      function persist(input: { content: string; blocks: ChatBlock[]; aborted: boolean }): number | null {
        if (input.aborted && !input.content && input.blocks.length === 0) return null;
        db.exec("BEGIN");
        try {
          if (regenerate) {
            db.prepare(
              "DELETE FROM messages WHERE id = (SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1) AND role = 'assistant'",
            ).run(sessionId);
          }
          const r = db
            .prepare(
              "INSERT INTO messages (session_id, role, content, blocks, aborted, created_at) VALUES (?, 'assistant', ?, ?, ?, ?)",
            )
            .run(
              sessionId,
              input.content,
              input.blocks.length ? JSON.stringify(input.blocks) : null,
              input.aborted ? 1 : 0,
              now(),
            );
          db.exec("COMMIT");
          return Number(r.lastInsertRowid);
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }
    });
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
    const history = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 12")
      .all(session.id)
      .reverse() as unknown as ChatMessage[];
    const n = await extractMemories({
      provider, memory, history,
      sessionId: session.id, mode: session.mode, workspace: session.workspace,
      existingFacts: memory.list().map((f) => f.content),
    });
    return c.json({ candidates: n });
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

  // 修改会话:工作区(Code/Work 绑定项目目录)、标题重命名、归档开关;至少给一个字段
  app.patch("/sessions/:id", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { workspace?: string; title?: string; archived?: boolean };
    const sets: string[] = [];
    const vals: Array<string | number> = [];
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
    if (sets.length === 0) return c.json({ error: "缺少 workspace/title/archived" }, 400);
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
  app.post("/tools/shell", async (c) => {
    const b = (await c.req.json()) as { workspace: string; command: string; shell?: string; confirmed?: boolean };
    try {
      const r = await shellExec(b);
      auditTool("tool.shell", { workspace: b.workspace, shell: r.shell, command: r.command, exitCode: r.exitCode });
      return c.json(r);
    } catch (e) {
      const err = e as Error & { needsConfirm?: boolean };
      return c.json({ error: err.message, needsConfirm: err.needsConfirm === true }, err.needsConfirm ? 409 : 400);
    }
  });
  app.post("/tools/git/status", async (c) => {
    const b = (await c.req.json()) as { workspace: string };
    const r = await shellExec({ workspace: b.workspace, command: "git status --short --branch" });
    return c.json(r);
  });
  app.post("/tools/git/diff", async (c) => {
    const b = (await c.req.json()) as { workspace: string };
    const r = await shellExec({ workspace: b.workspace, command: "git diff HEAD" });
    return c.json(r);
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
  app.get("/work/docs/:id", (c) => {
    const d = work.getDoc(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  });
  app.post("/work/docs/import-file", async (c) => {
    const b = (await c.req.json()) as { workspace: string; path: string; sessionId?: string };
    try {
      const d = work.importFile(b.workspace, b.path, b.sessionId);
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
  const EXPORT_VERSION = 1;

  app.get("/admin/export", (c) => {
    const sessions = db.prepare("SELECT * FROM sessions ORDER BY created_at").all() as Array<Record<string, unknown>>;
    const messages = db.prepare("SELECT session_id, role, content, blocks, aborted, created_at FROM messages ORDER BY id").all();
    const docs = db.prepare("SELECT * FROM docs ORDER BY created_at").all();
    const todos = db.prepare("SELECT * FROM todos ORDER BY created_at").all();
    const facts = db.prepare("SELECT * FROM facts WHERE deleted_at IS NULL ORDER BY valid_from").all();
    return c.json({
      kind: EXPORT_KIND, version: EXPORT_VERSION, exportedAt: now(),
      data: { sessions, messages, docs, todos, facts },
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
      const insSession = db.prepare("INSERT INTO sessions (id, title, mode, workspace, created_at, archived) VALUES (?, ?, ?, ?, ?, ?)");
      const hasSession = db.prepare("SELECT 1 FROM sessions WHERE id = ?");
      const sessionIds = new Set<string>();
      for (const r of (d.sessions ?? []) as Array<Record<string, unknown>>) {
        if (typeof r.id !== "string") continue;
        sessionIds.add(r.id);
        if (hasSession.get(r.id)) { skip.sessions++; continue; }
        insSession.run(r.id, String(r.title ?? "导入会话"), String(r.mode ?? "chat"), String(r.workspace ?? ""), String(r.created_at ?? now()), r.archived ? 1 : 0);
        add.sessions++;
      }
      const insMsg = db.prepare(
        "INSERT INTO messages (session_id, role, content, blocks, aborted, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      // 消息无稳定 id,重复导入同一导出包时按 (session_id, role, content, created_at) 去重,避免二次落库
      const hasMsg = db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND role = ? AND content = ? AND created_at = ?");
      for (const r of (d.messages ?? []) as Array<Record<string, unknown>>) {
        if (typeof r.session_id !== "string" || !sessionIds.has(r.session_id)) continue;
        const role = String(r.role ?? "user"), content = String(r.content ?? ""), created = String(r.created_at ?? now());
        if (hasMsg.get(r.session_id, role, content, created)) continue;
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
        insMsg.run(r.session_id, role, content, blocks, r.aborted ? 1 : 0, created);
        add.messages++;
      }
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
    db.prepare("INSERT INTO events (type, payload, created_at) VALUES ('data.import', ?, ?)").run(
      JSON.stringify({ added: add, skipped: skip }), now(),
    );
    return c.json({ ok: true, added: add, skipped: skip });
  });

  return app;
}
