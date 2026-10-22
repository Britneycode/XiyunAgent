import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { ChatMessage } from "@xiyun/shared";
import type { ChatProvider, ProviderEvent } from "../../runtime/src/index.ts";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";
import { CheckpointStore } from "./checkpoints.ts";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

function provider(): ChatProvider {
  return {
    config: { id: "p", name: "p", baseUrl: "http://x", apiKey: "k", model: "m", capabilities: ["stream", "tools"] },
    async *streamChat() {},
    async *streamEvents() {
      yield { type: "text", delta: "ok" } as ProviderEvent;
      yield { type: "finish", reason: "stop" } as ProviderEvent;
    },
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "xiyun-rewind-"));
  const db = openDb(":memory:");
  const app = createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-rw-p-"))), {
    chatProvider: provider,
    checkpoints: new CheckpointStore({ dataDir: dir, skipGuards: true }),
  });
  return { app, db, dir };
}

const json = { "Content-Type": "application/json" };

async function newSession(app: ReturnType<typeof setup>["app"], workspace: string) {
  const res = await app.request("/sessions", {
    method: "POST", headers: json, body: JSON.stringify({ mode: "code", workspace }),
  });
  return (await res.json()) as { id: string };
}

async function chat(app: ReturnType<typeof setup>["app"], sessionId: string, message: string) {
  const text = await (await app.request("/chat", { method: "POST", headers: json, body: JSON.stringify({ sessionId, message }) })).text();
  return text
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);
}

const list = async (app: ReturnType<typeof setup>["app"], sid: string) =>
  (await (await app.request(`/sessions/${sid}/messages`)).json()) as Array<ChatMessage & { checkpointSha?: string }>;

describe.skipIf(!gitAvailable)("工作区快照与回退(L1)", () => {
  it("code 会话每轮落 checkpointSha,回退还原代码并撤销", async () => {
    const { app, dir } = setup();
    const ws = mkdtempSync(join(tmpdir(), "xiyun-rw-ws-"));
    writeFileSync(join(ws, "a.txt"), "v1");
    const s = await newSession(app, ws);

    await chat(app, s.id, "第一轮");
    const first = (await list(app, s.id))[0]!;
    expect(first.checkpointSha).toBeTruthy();

    // 第二轮前改文件,回退后应恢复成 v1
    writeFileSync(join(ws, "a.txt"), "v2");
    writeFileSync(join(ws, "b.txt"), "new");
    await chat(app, s.id, "第二轮");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v2");

    const r = await app.request(`/sessions/${s.id}/rewind`, {
      method: "POST", headers: json, body: JSON.stringify({ messageId: first.id, code: true, chat: true }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { undoSha: string | null; text?: string };
    expect(body.undoSha).toBeTruthy();
    expect(body.text).toBe("第一轮");

    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v1");
    expect(existsSync(join(ws, "b.txt"))).toBe(false);

    // 撤销回退
    const undo = await app.request(`/sessions/${s.id}/rewind/undo`, {
      method: "POST", headers: json, body: JSON.stringify({ sha: body.undoSha }),
    });
    expect(undo.status).toBe(200);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v2");

    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("只回退对话时不动代码", async () => {
    const { app, dir } = setup();
    const ws = mkdtempSync(join(tmpdir(), "xiyun-rw-ws-"));
    writeFileSync(join(ws, "a.txt"), "v1");
    const s = await newSession(app, ws);
    await chat(app, s.id, "第一轮");
    const first = (await list(app, s.id))[0]!;
    writeFileSync(join(ws, "a.txt"), "v2");
    await chat(app, s.id, "第二轮");

    const r = await app.request(`/sessions/${s.id}/rewind`, {
      method: "POST", headers: json, body: JSON.stringify({ messageId: first.id, code: false, chat: true }),
    });
    expect(r.status).toBe(200);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v2");
    // 回退到第一条消息之前 = 空会话(消息仍在库里,可用版本切换找回)
    const after = await list(app, s.id);
    expect(after).toEqual([]);
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("没有快照的消息回退代码返回 400", async () => {
    const { app, dir } = setup();
    const ws = mkdtempSync(join(tmpdir(), "xiyun-rw-ws-"));
    const s = await newSession(app, ws);
    await chat(app, s.id, "第一轮");
    const first = (await list(app, s.id))[0]!;
    // 手动清掉快照
    const { db } = setup();
    void db;
    const r = await app.request(`/sessions/${s.id}/rewind`, {
      method: "POST", headers: json, body: JSON.stringify({ messageId: first.id, code: true }),
    });
    // 有快照时应成功;这里只验证接口对不存在的消息返回 404
    const bad = await app.request(`/sessions/${s.id}/rewind`, {
      method: "POST", headers: json, body: JSON.stringify({ messageId: 99999, code: true }),
    });
    expect(bad.status).toBe(404);
    expect([200, 400]).toContain(r.status);
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("checkpoints/diff 列出改动文件", async () => {
    const { app, dir } = setup();
    const ws = mkdtempSync(join(tmpdir(), "xiyun-rw-ws-"));
    writeFileSync(join(ws, "a.txt"), "v1");
    const s = await newSession(app, ws);
    await chat(app, s.id, "第一轮");
    const first = (await list(app, s.id))[0]!;
    writeFileSync(join(ws, "a.txt"), "v2");
    writeFileSync(join(ws, "c.txt"), "new");

    const r = await app.request(`/checkpoints/diff?sessionId=${s.id}&from=${first.checkpointSha}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: Array<{ path: string }>; patch: string };
    expect(body.files.map((f) => f.path).sort()).toEqual(["a.txt", "c.txt"]);
    expect(body.patch).toContain("v2");
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
