import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage } from "@xiyun/shared";
import type { ChatProvider } from "@xiyun/runtime";
import { MemoryStore } from "./memory.ts";
import { parseMemoryAction, runMemoryTool } from "./memchat.ts";

function fakeProvider(reply: string): ChatProvider {
  return {
    config: { id: "p", name: "p", baseUrl: "", apiKey: "", model: "m" },
    async *streamChat(_messages: ChatMessage[]) {
      yield reply;
    },
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE facts (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.5, scope TEXT NOT NULL DEFAULT 'global', valid_from TEXT NOT NULL, valid_to TEXT, deleted_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE facts_fts USING fts5(id UNINDEXED, content, tokenize='trigram');
  `);
  return new MemoryStore(db);
}

describe("parseMemoryAction", () => {
  it("解析 remember/forget/none,容忍前后闲聊", () => {
    expect(parseMemoryAction('好的 {"action":"remember","content":"用户偏好中文"} ')).toEqual({
      action: "remember",
      content: "用户偏好中文",
    });
    expect(parseMemoryAction('{"action":"forget","query":"贝叶斯"}')).toEqual({ action: "forget", query: "贝叶斯" });
    expect(parseMemoryAction('{"action":"none"}')).toBeNull();
    expect(parseMemoryAction("不是 JSON")).toBeNull();
  });
});

describe("runMemoryTool", () => {
  it("无意图词不触发模型调用", async () => {
    const memory = setup();
    const note = await runMemoryTool({
      provider: fakeProvider('{"action":"remember","content":"不该执行"}'),
      memory, message: "今天天气怎么样", scopes: ["global"], scope: "chat",
    });
    expect(note).toBeNull();
    expect(memory.list()).toHaveLength(0);
  });

  it("记住X → 直接写入事实", async () => {
    const memory = setup();
    const note = await runMemoryTool({
      provider: fakeProvider('{"action":"remember","content":"用户喜欢深色主题"}'),
      memory, message: "记住我喜欢深色主题", scopes: ["global", "chat"], scope: "chat",
    });
    expect(note).toContain("新增记忆");
    const facts = memory.list();
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("用户喜欢深色主题");
    expect(facts[0].source).toBe("chat:cmd");
  });

  it("忘掉X → 检索命中并软删除;无命中只提示", async () => {
    const memory = setup();
    memory.addFact("贝叶斯定理已学完先验概率", { scope: "chat" });
    const note = await runMemoryTool({
      provider: fakeProvider('{"action":"forget","query":"贝叶斯"}'),
      memory, message: "忘掉贝叶斯相关的记忆", scopes: ["global", "chat"], scope: "chat",
    });
    expect(note).toContain("已删除 1 条");
    expect(memory.search("贝叶斯", 5)).toHaveLength(0); // 软删除后不可检索
    expect(memory.list(true)).toHaveLength(1); // 数据仍在,可彻底忘记

    const miss = await runMemoryTool({
      provider: fakeProvider('{"action":"forget","query":"不存在的主题"}'),
      memory, message: "忘掉不存在的主题", scopes: ["global"], scope: "chat",
    });
    expect(miss).toContain("没有找到");
  });
});
