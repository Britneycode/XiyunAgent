import { test } from "vitest";
import assert from "node:assert";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";

function mem() {
  return new MemoryStore(openDb(":memory:"));
}

test("facts: add / search / soft delete / hard delete", () => {
  const m = mem();
  const f = m.addFact("用户偏好中文回答", { source: "chat", confidence: 0.9 });
  assert.equal(m.search("中文").length, 1);

  m.remove(f.id); // 软删除后检索不可见
  assert.equal(m.search("中文").length, 0);
  assert.equal(m.list().length, 0);
  assert.equal(m.list(true).length, 1);

  m.remove(f.id, true); // 彻底忘记
  assert.equal(m.list(true).length, 0);
});

test("facts: supersede 结束旧事实有效期而非覆盖", () => {
  const m = mem();
  const old = m.addFact("项目使用 React 18", { source: "user" });
  const neo = m.supersede(old.id, "项目使用 React 19");
  const all = m.list();
  assert.equal(all.length, 2);
  assert.ok(m.get(old.id)!.validTo, "旧事实应有 valid_to");
  assert.equal(m.get(neo.id)!.validTo, null);
  assert.deepEqual(
    m.search("React").map((f) => f.id),
    [neo.id],
    "检索只返回当前有效事实",
  );
});

test("db: FTS5 可用", () => {
  const m = mem();
  m.addFact("SQLite FTS5 支持全文检索");
  assert.equal(m.search("全文检索").length, 1);
});

test("search: scopes 限制检索层级", () => {
  const m = mem();
  m.addFact("全局偏好:中文回答", { scope: "global" });
  m.addFact("模式偏好:chat 模式简洁", { scope: "chat" });
  m.addFact("其他项目事实:别的项目用 Vue", { scope: "/other/project" });
  const hits = m.search("偏好", 5, ["global", "chat"]);
  assert.equal(hits.length, 2, "只命中 global 和 chat 层");
  assert.ok(!hits.some((f) => f.scope === "/other/project"));
});

test("candidates: 确认成为事实,拒绝不进检索,forget 彻底删除", () => {
  const m = mem();
  const c1 = m.addCandidate({ content: "用户偏好简洁回答", confidence: 0.8 });
  const c2 = m.addCandidate({ content: "临时闲聊内容", confidence: 0.3 });
  m.confirmCandidate(c1.id);
  m.rejectCandidate(c2.id);
  assert.equal(m.search("简洁回答").length, 1, "确认后可检索");
  assert.equal(m.search("闲聊").length, 0, "拒绝不进检索");
  assert.throws(() => m.confirmCandidate(c1.id), /already confirmed/, "重复确认报错");
  const f = m.search("简洁回答")[0];
  m.forget(f.id);
  assert.equal(m.list(true).length, 0, "彻底忘记后原文不可查");
});

test("candidates: supersede 确认结束旧事实有效期", () => {
  const m = mem();
  const old = m.addFact("项目用 React 18", { source: "user" });
  const c = m.addCandidate({ content: "项目用 React 19", action: "supersede", targetId: old.id });
  m.confirmCandidate(c.id);
  assert.ok(m.get(old.id)!.validTo, "旧事实有效期已结束");
  assert.deepEqual(m.search("React").map((f) => f.validTo), [null]);
});

test("search: 长自然语言提问通过滑窗退化召回相关记忆", () => {
  const m = mem();
  m.addFact("学习进度:贝叶斯定理——已学公式和体检筛查例子");
  const hits = m.search("我上次学到哪了?帮我回顾一下贝叶斯的内容");
  assert.equal(hits.length, 1, "整体短语不匹配时应退化为 3 字滑窗 OR 命中");
});

test("search: 用户文本含 FTS5 语法字符不破坏 MATCH", () => {
  const m = mem();
  m.addFact("用户正在学习线性代数,重点是矩阵运算");
  assert.equal(m.search("线性代数,重点是矩阵").length, 1);
  assert.equal(m.search(`引号"与(括号)`).length, 0, "语法字符按字面处理,不报错不误配");
});
