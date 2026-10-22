import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";
import type { ChatProvider } from "../../runtime/src/index.ts";

// L2 / F8 的接口层测试:记忆作业、批量撤销、导入触发提取、PDF/Word 附件、文档检索
function fakeProvider(reply: string): ChatProvider {
  return {
    config: { id: "t", name: "t", baseUrl: "http://x", apiKey: "k", model: "m" },
    async *streamChat() {
      yield reply;
    },
  };
}

// 挂起的 provider:调用后一直不返回,用来把作业卡在 running
function hangingProvider(): ChatProvider {
  return {
    config: { id: "h", name: "h", baseUrl: "http://x", apiKey: "k", model: "m" },
    async *streamChat() {
      await new Promise(() => {});
    },
  };
}

function setup(reply = `[{"content":"用户偏好中文","confidence":0.9,"reason":"多次要求","index":1}]`, provider?: ChatProvider) {
  const db = openDb(":memory:");
  const memory = new MemoryStore(db);
  const p = provider ?? fakeProvider(reply);
  const app = createApp(db, memory, new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-mj-p-"))), {
    chatProvider: () => p,
    titleProvider: () => undefined,
    summaryProvider: () => undefined,
    memoryProvider: () => p,
    dataDir: mkdtempSync(join(tmpdir(), "xiyun-mj-d-")),
  });
  return { app, db, memory, provider: p };
}

const json = { "Content-Type": "application/json" };
const post = (app: ReturnType<typeof setup>["app"], path: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: json, body: JSON.stringify(body ?? {}) });

// 建一个带 2 轮消息的会话(记忆作业按会话取历史)
function addSession(db: ReturnType<typeof setup>["db"], id: string) {
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO sessions (id, title, mode, workspace, created_at, updated_at) VALUES (?, 's', 'chat', '', ?, ?)").run(id, ts, ts);
  const ins = db.prepare("INSERT INTO messages (session_id, role, content, parent_id, created_at) VALUES (?, ?, ?, ?, ?)");
  const a = Number(ins.run(id, "user", "我想学 TypeScript", null, ts).lastInsertRowid);
  const b = Number(ins.run(id, "assistant", "好的", a, ts).lastInsertRowid);
  const c = Number(ins.run(id, "user", "请记住我偏好中文", b, ts).lastInsertRowid);
  const d = Number(ins.run(id, "assistant", "记住了", c, ts).lastInsertRowid);
  db.prepare("UPDATE sessions SET head_id = ? WHERE id = ?").run(d, id);
}

// 一个 2 轮的 ChatGPT 导出(至少 2 条 user 消息才进提取队列)
const chatgpt2 = () => [
  {
    title: "学习计划", create_time: 1_700_000_000.5, update_time: 1_700_000_900, conversation_id: "conv-1", current_node: "a2",
    mapping: {
      root: { id: "root", parent: null, message: null, children: [] },
      u1: { id: "u1", parent: "root", message: { author: { role: "user" }, content: { content_type: "text", parts: ["我想学 TypeScript"] }, create_time: 1_700_000_001, recipient: "all", metadata: {} }, children: [] },
      a1: { id: "a1", parent: "u1", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["好的"] }, create_time: 1_700_000_002, recipient: "all", metadata: {} }, children: [] },
      u2: { id: "u2", parent: "a1", message: { author: { role: "user" }, content: { content_type: "text", parts: ["请记住我偏好中文"] }, create_time: 1_700_000_003, recipient: "all", metadata: {} }, children: [] },
      a2: { id: "a2", parent: "u2", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["记住了"] }, create_time: 1_700_000_004, recipient: "all", metadata: {} }, children: [] },
    },
  },
];

describe("记忆作业接口(L2)", () => {
  it("创建作业 → 查进度 → 暂停 / 恢复 / 取消", async () => {
    // 挂起的 provider 让作业停在 running,便于测暂停
    const { app, db } = setup(undefined, hangingProvider());
    addSession(db, "s1");
    const r = await (await post(app, "/memory/jobs", { source: "import:chatgpt", sessionIds: ["s1"] })).json();
    expect(r.id).toBeTruthy();
    expect(r.total).toBe(1);
    const id = r.id as string;

    const got = (await (await app.request(`/memory/jobs/${id}`)).json()) as { status: string; items: unknown[] };
    expect(got.status).toBe("running");
    expect(got.items).toHaveLength(1);

    expect((await (await post(app, `/memory/jobs/${id}/pause`)).json()).status).toBe("paused");
    expect((await (await post(app, `/memory/jobs/${id}/resume`)).json()).status).toBeTruthy();
    expect((await (await post(app, `/memory/jobs/${id}/cancel`)).json()).status).toBe("cancelled");
    // 已结束的作业不能重复暂停
    expect((await post(app, `/memory/jobs/${id}/pause`)).status).toBe(400);
  });

  it("缺少会话列表返回 400;不存在的作业返回 404", async () => {
    const { app } = setup();
    expect((await post(app, "/memory/jobs", { source: "import:chatgpt" })).status).toBe(400);
    expect((await app.request("/memory/jobs/nope")).status).toBe(404);
  });

  it("作业列表能列出作业", async () => {
    const { app } = setup();
    await post(app, "/memory/jobs", { source: "import:chatgpt", sessionIds: ["s1"] });
    const list = (await (await app.request("/memory/jobs")).json()) as unknown[];
    expect(list.length).toBe(1);
  });
});

describe("按来源批量撤销(L2)", () => {
  it("撤销某个来源的记忆,返回撤销条数", async () => {
    const { app, memory } = setup();
    memory.addFact("来自 chatgpt", { sourceKind: "import:chatgpt" });
    memory.addFact("来自 claude", { sourceKind: "import:claude" });
    const r = (await (await post(app, "/memory/facts/revoke", { sourceKind: "import:chatgpt" })).json()) as { revoked: number };
    expect(r.revoked).toBe(1);
    const facts = (await (await app.request("/memory/facts")).json()) as Array<{ content: string }>;
    expect(facts.map((f) => f.content)).toEqual(["来自 claude"]);
    // 缺少来源返回 400
    expect((await post(app, "/memory/facts/revoke", {})).status).toBe(400);
  });
});

describe("导入后提取记忆(L2)", () => {
  it("勾选 extract 时创建作业,并只处理至少 2 轮的会话", async () => {
    const { app, memory } = setup();
    const res = await app.request("/admin/import/external?extract=1", {
      method: "POST", headers: json, body: JSON.stringify(chatgpt2()),
    });
    const r = (await res.json()) as { job?: { id: string; source: string; total: number } };
    expect(r.job).toBeTruthy();
    expect(r.job!.source).toBe("import:chatgpt");
    expect(r.job!.total).toBe(1);
    // 等作业跑完,候选记忆带来源
    await new Promise((r2) => setTimeout(r2, 300));
    const cands = memory.listCandidates("pending");
    expect(cands.length).toBe(1);
    expect(cands[0]!.sourceKind).toBe("import:chatgpt");
  });

  it("不勾选 extract 时不建作业", async () => {
    const { app } = setup();
    const res = await app.request("/admin/import/external", {
      method: "POST", headers: json, body: JSON.stringify(chatgpt2()),
    });
    const r = (await res.json()) as { job?: unknown };
    expect(r.job).toBeUndefined();
  });

  it("预览给出可提取会话数与 token 估算", async () => {
    const { app } = setup();
    const pv = (await (await post(app, "/admin/import/external/preview", chatgpt2())).json()) as {
      extractable: number; estimatedTokens: number;
    };
    expect(pv.extractable).toBe(1);
    expect(pv.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("PDF / Word 附件(F8)", () => {
  it("PDF 附件转成文本附件", async () => {
    const { app } = setup();
    const form = new FormData();
    form.append("file", new File([Buffer.from("%PDF-1.4\n")], "a.pdf", { type: "application/pdf" }));
    const res = await app.request("/attachments", { method: "POST", body: form });
    // 最小 PDF 无法解析时返回 4xx(而不是当图片/文本存)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("非 PDF / docx 的附件仍然按原规则拒绝", async () => {
    const { app } = setup();
    const form = new FormData();
    form.append("file", new File([Buffer.from([1, 2, 3])], "a.bin", { type: "" }));
    const res = await app.request("/attachments", { method: "POST", body: form });
    expect(res.status).toBe(415);
  });
});

describe("文档检索接口(F8)", () => {
  it("检索返回命中块与高亮片段", async () => {
    const { app } = setup();
    await post(app, "/work/docs/paste", { title: "需求", content: "交付截止日期为 2026-11-01,包含审计日志。", workspace: "w1" });
    const hits = (await (await app.request("/work/docs/search?q=审计日志&workspace=w1")).json()) as Array<{
      docId: string; title: string; snippet: string; ord: number;
    }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe("需求");
    expect(hits[0]!.snippet).toContain("审计日志");
    expect(typeof hits[0]!.ord).toBe("number");
  });

  it("空查询返回空数组", async () => {
    const { app } = setup();
    expect(await (await app.request("/work/docs/search?q=")).json()).toEqual([]);
  });

  it("拖入 PDF 转成文本存为资料", async () => {
    const { app } = setup();
    const form = new FormData();
    form.append("file", new File([Buffer.from("%PDF-1.4\n")], "x.pdf", { type: "application/pdf" }));
    form.append("workspace", "w1");
    const res = await app.request("/work/docs/upload", { method: "POST", body: form });
    // 非法 PDF 不会 500
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("拖入非 PDF / docx 被拒绝", async () => {
    const { app } = setup();
    const form = new FormData();
    form.append("file", new File([Buffer.from("x")], "a.txt", { type: "text/plain" }));
    form.append("workspace", "w1");
    const res = await app.request("/work/docs/upload", { method: "POST", body: form });
    expect(res.status).toBe(415);
  });
});
