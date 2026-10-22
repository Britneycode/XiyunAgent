import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";
import { collapse, parseExternal, UNKNOWN_FORMAT } from "./external.ts";

// M1:ChatGPT / Claude 导出的 conversations.json
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  author: { role }, content, create_time: (extra.t as number) ?? 1_700_000_000, recipient: extra.recipient ?? "all", metadata: extra.metadata ?? {},
});
const text = (s: string) => ({ content_type: "text", parts: [s] });
const node = (id: string, parent: string | null, message: unknown) => ({ id, parent, message, children: [] });
const chatgpt = () => [
  {
    title: "猫的图片", create_time: 1_700_000_000.5, update_time: 1_700_000_900, conversation_id: "conv-1", current_node: "a2c",
    mapping: {
      root: node("root", null, null),
      sys: node("sys", "root", msg("system", text(""), { metadata: { is_visually_hidden_from_conversation: true } })),
      ctx: node("ctx", "sys", msg("user", { content_type: "user_editable_context", user_profile: "x" })),
      u1: node("u1", "ctx", msg("user", text("你好"), { t: 1_700_000_001 })),
      th: node("th", "u1", msg("assistant", { content_type: "thoughts", thoughts: [] }, { t: 1_700_000_002 })),
      a1: node("a1", "th", msg("assistant", text("你好!"), { t: 1_700_000_003 })),
      u2: node("u2", "a1", msg("user", { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer" }, "这是什么"] }, { t: 1_700_000_004 })),
      call: node("call", "u2", msg("assistant", { content_type: "code", text: "print(1)" }, { recipient: "python", t: 1_700_000_005 })),
      out: node("out", "call", msg("tool", { content_type: "execution_output", text: "1" }, { t: 1_700_000_006 })),
      a2b: node("a2b", "out", msg("assistant", text("是一只猫"), { t: 1_700_000_007 })),
      t2: node("t2", "a2b", msg("tool", text("搜索结果"), { t: 1_700_000_008 })),
      a2c: node("a2c", "t2", msg("assistant", text("补充:橘猫"), { t: 1_700_000_009 })),
      a3: node("a3", "u2", msg("assistant", text("是一只狗"), { t: 1_700_000_010 })),
    },
  },
  { title: "空对话", create_time: 1_600_000_000, conversation_id: "conv-2", mapping: { root: node("root", null, null) } },
];
const ROOT = "00000000-0000-4000-8000-000000000000";
const claude = () => [
  {
    uuid: "c-1", name: "", created_at: "2024-05-01T10:00:00Z", updated_at: "2024-05-01T11:00:00Z", current_leaf_message_uuid: "m4",
    chat_messages: [
      { uuid: "m1", sender: "human", text: "解释一下", content: [{ type: "text", text: "解释一下" }], parent_message_uuid: ROOT, created_at: "2024-05-01T10:00:01Z" },
      { uuid: "m2", sender: "assistant", content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "好的" }], parent_message_uuid: "m1", created_at: "2024-05-01T10:00:02Z" },
      {
        uuid: "m3", sender: "human", text: "看这个文件", parent_message_uuid: "m2", created_at: "2024-05-01T10:00:03Z",
        attachments: [{ file_name: "a.py", extracted_content: "print('hi')" }], files: [{ file_name: "img.png" }],
      },
      { uuid: "m4", sender: "assistant", text: "这段代码打印 hi", parent_message_uuid: "m3", created_at: "2024-05-01T10:00:04Z" },
      { uuid: "m3b", sender: "human", text: "换个问题", parent_message_uuid: "m2", created_at: "2024-05-01T10:00:05Z" },
      { uuid: "m4b", sender: "assistant", content: [{ type: "tool_use", name: "x" }, { type: "text", text: "新回答" }], parent_message_uuid: "m3b", created_at: "2024-05-01T10:00:06Z" },
    ],
  },
  {
    uuid: "c-2", name: "旧格式", created_at: "2023-01-01T00:00:00Z", updated_at: "2023-01-01T00:00:00Z",
    chat_messages: [
      { uuid: "x1", sender: "human", text: "一", created_at: "2023-01-01T00:00:01Z" },
      { uuid: "x2", sender: "assistant", text: "二", created_at: "2023-01-01T00:00:02Z" },
    ],
  },
];

describe("外部对话解析(M1)", () => {
  it("ChatGPT:跳过系统 / 工具 / 思考 / 隐藏消息,工具调用两侧的回复合并,分支与当前节点保留", () => {
    const { source, conversations } = parseExternal(chatgpt());
    expect(source).toBe("chatgpt");
    const [c, empty] = conversations;
    expect(c).toMatchObject({ externalId: "conv-1", title: "猫的图片", createdAt: "2023-11-14T22:13:20.500Z" });
    expect(c!.messages.map((m) => [m.key, m.parentKey, m.role, m.content])).toEqual([
      ["u1", null, "user", "你好"],
      ["a1", "u1", "assistant", "你好!"],
      ["u2", "a1", "user", "[图片]\n这是什么"],
      ["a2b", "u2", "assistant", "是一只猫\n\n补充:橘猫"],
      ["a3", "u2", "assistant", "是一只狗"],
    ]);
    expect(c!.headKey).toBe("a2b"); // current_node a2c 已并入 a2b
    expect(empty!.messages).toEqual([]);
  });

  it("Claude:parent_message_uuid 成树、当前叶子为 head;附件抽取文本并入;旧格式按顺序成单链", () => {
    const { source, conversations } = parseExternal(claude());
    expect(source).toBe("claude");
    const [c, old] = conversations;
    expect(c!.title).toBe("Claude 对话");
    expect(c!.messages.map((m) => [m.key, m.parentKey])).toEqual([
      ["m1", null], ["m2", "m1"], ["m3", "m2"], ["m3b", "m2"], ["m4", "m3"], ["m4b", "m3b"],
    ]);
    expect(c!.messages.find((m) => m.key === "m2")!.content).toBe("好的");
    expect(c!.messages.find((m) => m.key === "m3")!.content).toBe("看这个文件\n\n[附件:a.py]\nprint('hi')\n\n[文件:img.png]");
    expect(c!.messages.find((m) => m.key === "m4b")!.content).toBe("新回答");
    expect(c!.headKey).toBe("m4");
    expect(old!.messages.map((m) => [m.key, m.parentKey, m.role])).toEqual([["x1", null, "user"], ["x2", "x1", "assistant"]]);
    expect(old!.headKey).toBe("x2");
  });

  it("无法识别的内容报错;节点成环不会死循环", () => {
    expect(() => parseExternal({ foo: 1 })).toThrow(UNKNOWN_FORMAT);
    expect(() => parseExternal([])).toThrow(UNKNOWN_FORMAT);
    expect(() => parseExternal("x")).toThrow(UNKNOWN_FORMAT);
    const r = collapse(
      [
        { key: "a", parentKey: "b", role: "user", content: "1", createdAt: "t" },
        { key: "b", parentKey: "a", role: "assistant", content: "2", createdAt: "t" },
        { key: "c", parentKey: null, role: "user", content: "3", createdAt: "t" },
      ],
      "a",
    );
    expect(r.messages.map((m) => m.key)).toEqual(["c"]);
    expect(r.headKey).toBe("c");
  });
});

describe("外部对话导入接口(M1)", () => {
  const setup = () => {
    const db = openDb(":memory:");
    const app = createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-ext-"))), {
      dataDir: mkdtempSync(join(tmpdir(), "xiyun-extd-")),
    });
    return { app, db };
  };
  const post = (app: ReturnType<typeof setup>["app"], path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("预览 → 导入:每个对话一个 Chat 会话,保留分支与当前分支;重复导入跳过;可被全文搜索", async () => {
    const { app } = setup();
    const pv = await (await post(app, "/admin/import/external/preview", chatgpt())).json();
    expect(pv).toEqual({ source: "chatgpt", conversations: 1, messages: 5, duplicate: 0, empty: 1, from: "2023-11-14T22:13:20.500Z", to: "2023-11-14T22:13:20.500Z", extractable: 1, estimatedTokens: expect.any(Number) });
    const r = await (await post(app, "/admin/import/external", chatgpt())).json();
    expect(r).toEqual({ ok: true, source: "chatgpt", added: { sessions: 1, messages: 5 }, skipped: { duplicate: 0, empty: 1 } });
    const sessions = (await (await app.request("/sessions")).json()) as Array<{ id: string; title: string; mode: string; updatedAt: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ title: "猫的图片", mode: "chat" });
    const ms = (await (await app.request(`/sessions/${sessions[0]!.id}/messages`)).json()) as Array<{ content: string; siblings?: number[] }>;
    expect(ms.map((m) => m.content)).toEqual(["你好", "你好!", "[图片]\n这是什么", "是一只猫\n\n补充:橘猫"]);
    expect(ms[3]!.siblings).toHaveLength(2);
    const hits = (await (await app.request(`/search?q=${encodeURIComponent("橘猫")}`)).json()) as unknown;
    expect(JSON.stringify(hits)).toContain(sessions[0]!.id);

    expect((await (await post(app, "/admin/import/external/preview", chatgpt())).json()).duplicate).toBe(1);
    expect((await (await post(app, "/admin/import/external", chatgpt())).json()).skipped).toEqual({ duplicate: 1, empty: 1 });
    const claudeRes = await (await post(app, "/admin/import/external", claude())).json();
    expect(claudeRes.added).toEqual({ sessions: 2, messages: 8 });
  });

  it("不是导出文件返回 400", async () => {
    const { app } = setup();
    const res = await post(app, "/admin/import/external/preview", { kind: "xiyun-export" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("无法识别");
    expect((await app.request("/admin/import/external", { method: "POST", body: "not json" })).status).toBe(400);
  });
});
