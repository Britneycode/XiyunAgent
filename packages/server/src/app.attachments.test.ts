import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, ProviderConfig } from "@xiyun/shared";
import type { ChatProvider, ProviderEvent } from "../../runtime/src/index.ts";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";

// 附件(B2 / D-023):上传、发给模型、随消息树沿用、清理、导出导入
function recorder(config: Partial<ProviderConfig> = {}) {
  const calls: ChatMessage[][] = [];
  const provider: ChatProvider = {
    config: { id: "t", name: "t", baseUrl: "http://x", apiKey: "k", model: "m", ...config },
    async *streamChat() {},
    async *streamEvents(messages) {
      calls.push(messages);
      yield { type: "text", delta: "ok" } as ProviderEvent;
      yield { type: "finish", reason: "stop" } as ProviderEvent;
    },
  };
  return { provider, calls };
}

function setup(provider: ChatProvider) {
  const db = openDb(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "xiyun-att-"));
  const app = createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-attp-"))), {
    chatProvider: () => provider,
    titleProvider: () => undefined,
    summaryProvider: () => undefined,
    dataDir,
  });
  return { app, db, dataDir };
}

type App = ReturnType<typeof setup>["app"];
type Meta = { id: string; name: string; mime: string; size: number; kind: string };
const json = { "Content-Type": "application/json" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

const upload = async (app: App, name: string, bytes: Uint8Array | string, type = "") => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return app.request("/attachments", { method: "POST", body: form });
};
const up = async (app: App, name: string, bytes: Uint8Array | string, type = "") => (await (await upload(app, name, bytes, type)).json()) as Meta;
const chat = async (app: App, body: Record<string, unknown>) => {
  const res = await app.request("/chat", { method: "POST", headers: json, body: JSON.stringify(body) });
  if (res.status !== 200) return { status: res.status, error: ((await res.json()) as { error: string }).error };
  await res.text();
  return { status: 200, error: "" };
};
const newSession = async (app: App) =>
  (await (await app.request("/sessions", { method: "POST", headers: json, body: JSON.stringify({ mode: "chat" }) })).json()) as { id: string; title: string };
const messages = async (app: App, sid: string) =>
  (await (await app.request(`/sessions/${sid}/messages`)).json()) as Array<{ id: number; role: string; content: string; blocks?: Array<Record<string, unknown>> }>;
const last = (calls: ChatMessage[][]) => calls[calls.length - 1]!;

describe("附件(B2)", () => {
  it("上传:图片按文件头识别、内容寻址去重;文本 / 代码按 UTF-8 接受;其余拒绝", async () => {
    const { app } = setup(recorder().provider);
    const img = await up(app, "shot.txt", PNG, "text/plain"); // 声明类型不可信,按内容判定
    expect(img).toMatchObject({ kind: "image", mime: "image/png", size: PNG.length, id: createHash("sha256").update(PNG).digest("hex") });
    expect((await up(app, "again.png", PNG)).id).toBe(img.id);
    const res = await app.request(`/attachments/${img.id}`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

    const code = await up(app, "../a/b.ts", "export const x = 1;\n// 中文");
    expect(code).toMatchObject({ kind: "text", mime: "text/plain", name: ".._a_b.ts" });
    const t = await app.request(`/attachments/${code.id}`);
    expect(t.headers.get("content-type")).toContain("text/plain");
    expect(await t.text()).toContain("中文");

    expect((await upload(app, "a.bin", new Uint8Array([1, 0, 2]))).status).toBe(415);
    expect((await upload(app, "a.txt", new Uint8Array([0xff, 0xfe, 0x41]))).status).toBe(415); // 非 UTF-8
    expect((await upload(app, "big.txt", "a".repeat(1024 * 1024 + 1))).status).toBe(413);
    expect((await upload(app, "empty.txt", "")).status).toBe(400);
    expect((await app.request("/attachments", { method: "POST", body: new FormData() })).status).toBe(400);
    expect((await app.request("/attachments/../../etc")).status).toBe(404);
    expect((await app.request(`/attachments/${"0".repeat(64)}`)).status).toBe(404);
  });

  it("发送:图片随本轮 user 消息发给模型,文本附件正文并入;只有附件也能发,标题取附件名", async () => {
    const { provider, calls } = recorder();
    const { app } = setup(provider);
    const s = await newSession(app);
    const img = await up(app, "diagram.png", PNG);
    const doc = await up(app, "notes.md", "# 笔记\n第一条");
    expect((await chat(app, { sessionId: s.id, message: "", attachments: [img.id, doc.id] })).status).toBe(200);
    const u = last(calls).at(-1)!;
    expect(u.role).toBe("user");
    expect(u.images).toEqual([{ mime: "image/png", data: b64(PNG) }]);
    expect(u.content).toContain("## 附件:notes.md");
    expect(u.content).toContain("第一条");
    const ms = await messages(app, s.id);
    expect(ms[0]!.content).toBe("");
    expect(ms[0]!.blocks?.map((b) => [b.kind, b.name, b.type])).toEqual([
      ["attachment", "diagram.png", "image"],
      ["attachment", "notes.md", "text"],
    ]);
    const sess = (await (await app.request("/sessions")).json()) as Array<{ id: string; title: string }>;
    expect(sess.find((x) => x.id === s.id)!.title).toContain("diagram");
  });

  it("校验:附件不存在、超过 8 个、模型未声明 vision 时拒绝图片(文本附件不受影响)", async () => {
    const { provider } = recorder({ capabilities: ["tools"] });
    const { app } = setup(provider);
    const s = await newSession(app);
    const img = await up(app, "a.png", PNG);
    const doc = await up(app, "a.txt", "hello");
    expect(await chat(app, { sessionId: s.id, message: "看图", attachments: [img.id] })).toMatchObject({ status: 400, error: expect.stringContaining("vision") });
    expect((await chat(app, { sessionId: s.id, message: "看文", attachments: [doc.id] })).status).toBe(200);
    expect((await chat(app, { sessionId: s.id, message: "x", attachments: ["f".repeat(64)] })).status).toBe(400);
    const nine = await Promise.all(Array.from({ length: 9 }, (_, i) => up(app, `f${i}.txt`, `file ${i}`)));
    expect(await chat(app, { sessionId: s.id, message: "x", attachments: nine.map((m) => m.id) })).toMatchObject({ status: 400 });
    expect(await chat(app, { sessionId: s.id, message: "", attachments: [] })).toMatchObject({ status: 400 });
  });

  it("重新生成与编辑沿用原附件;编辑时显式传空数组则去掉附件", async () => {
    const { provider, calls } = recorder();
    const { app } = setup(provider);
    const s = await newSession(app);
    const img = await up(app, "a.png", PNG);
    await chat(app, { sessionId: s.id, message: "描述这张图", attachments: [img.id] });
    expect((await chat(app, { sessionId: s.id, regenerate: true })).status).toBe(200);
    expect(last(calls).at(-1)!.images?.length).toBe(1);
    const uid = (await messages(app, s.id))[0]!.id;
    await chat(app, { sessionId: s.id, message: "换个问法", editOf: uid });
    expect(last(calls).at(-1)!.images?.length).toBe(1);
    expect((await messages(app, s.id))[0]!.blocks?.[0]).toMatchObject({ kind: "attachment", attachmentId: img.id });
    await chat(app, { sessionId: s.id, message: "不要图了", editOf: uid, attachments: [] });
    expect(last(calls).at(-1)!.images).toBeUndefined();
  });

  it("历史:最近 3 条带附件的 user 消息完整带入图片与正文,更早的只留占位", async () => {
    const { provider, calls } = recorder();
    const { app } = setup(provider);
    const s = await newSession(app);
    for (let i = 0; i < 4; i++) {
      const img = await up(app, `p${i}.png`, new Uint8Array([...PNG, i]));
      await chat(app, { sessionId: s.id, message: `第${i}张`, attachments: [img.id] });
    }
    await chat(app, { sessionId: s.id, message: "总结一下" });
    const hist = last(calls).filter((m) => m.role === "user").slice(0, -1);
    expect(hist.map((m) => m.images?.length ?? 0)).toEqual([0, 1, 1, 1]);
    expect(hist[0]!.content).toContain("p0.png");
  });

  it("删除会话时清理只被它引用的附件,别的会话仍在用的保留", async () => {
    const { provider } = recorder();
    const { app, dataDir } = setup(provider);
    const a = await newSession(app);
    const b = await newSession(app);
    const own = await up(app, "own.png", PNG);
    const shared = await up(app, "shared.png", PNG2);
    await chat(app, { sessionId: a.id, message: "1", attachments: [own.id, shared.id] });
    await chat(app, { sessionId: b.id, message: "2", attachments: [shared.id] });
    expect((await app.request(`/sessions/${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/attachments/${own.id}`)).status).toBe(404);
    expect(existsSync(join(dataDir, "attachments", own.id))).toBe(false);
    expect((await app.request(`/attachments/${shared.id}`)).status).toBe(200);
  });

  it("导出包带附件(base64),导入到新库后可用;内容与 id 不符的附件跳过", async () => {
    const { provider } = recorder();
    const src = setup(provider);
    const s = await newSession(src.app);
    const img = await up(src.app, "a.png", PNG);
    await chat(src.app, { sessionId: s.id, message: "看", attachments: [img.id] });
    const pack = (await (await src.app.request("/admin/export")).json()) as { data: { attachments: Array<Record<string, unknown>> } };
    expect(pack.data.attachments).toEqual([expect.objectContaining({ id: img.id, name: "a.png", kind: "image", data: b64(PNG) })]);
    pack.data.attachments.push({ id: "a".repeat(64), name: "bad.png", data: b64(PNG2) });

    const dst = setup(provider);
    const pv = (await (await dst.app.request("/admin/import/preview", { method: "POST", headers: json, body: JSON.stringify(pack) })).json()) as Record<string, unknown>;
    expect(pv.attachments).toEqual({ total: 2, duplicate: 0, added: 2 });
    const r = (await (await dst.app.request("/admin/import", { method: "POST", headers: json, body: JSON.stringify(pack) })).json()) as Record<string, unknown>;
    expect(r.attachments).toEqual({ added: 1, skipped: 0, invalid: 1 });
    const got = await dst.app.request(`/attachments/${img.id}`);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    expect((await messages(dst.app, s.id))[0]!.blocks?.[0]).toMatchObject({ kind: "attachment", attachmentId: img.id });
    const again = (await (await dst.app.request("/admin/import", { method: "POST", headers: json, body: JSON.stringify(pack) })).json()) as Record<string, unknown>;
    expect(again.attachments).toEqual({ added: 0, skipped: 1, invalid: 1 });
  });
});
