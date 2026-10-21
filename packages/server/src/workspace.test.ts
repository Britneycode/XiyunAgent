import { test } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInside, loadRuleFiles } from "./workspace.ts";
import { ProviderStore } from "./providers.ts";

test("workspace: 拒绝访问工作区外路径", () => {
  const w = mkdtempSync(join(tmpdir(), "xy-"));
  assert.equal(assertInside(w, "a/b.txt"), join(w, "a", "b.txt"));
  assert.throws(() => assertInside(w, "../evil.txt"), /outside workspace/);
  assert.throws(() => assertInside(w, "..\\evil.txt"), /outside workspace/);
});

test("rules: 加载存在的规则文件,不存在则跳过", () => {
  const w = mkdtempSync(join(tmpdir(), "xy-"));
  writeFileSync(join(w, "AGENTS.md"), "规则内容");
  const rules = loadRuleFiles(w);
  assert.match(rules, /AGENTS\.md/);
  assert.match(rules, /规则内容/);
});

test("rules: 全局/模式/项目分层拼接", () => {
  const w = mkdtempSync(join(tmpdir(), "xy-"));
  const data = mkdtempSync(join(tmpdir(), "xy-"));
  mkdirSync(join(data, "rules"));
  writeFileSync(join(data, "rules", "global.md"), "全局内容");
  writeFileSync(join(data, "rules", "chat.md"), "模式内容");
  writeFileSync(join(w, "AGENTS.md"), "项目内容");
  const rules = loadRuleFiles(w, { dataDir: data, mode: "chat" });
  assert.ok(rules.indexOf("全局内容") < rules.indexOf("模式内容"));
  assert.ok(rules.indexOf("模式内容") < rules.indexOf("项目内容"));
  // 不传 dataDir 时只加载项目规则
  assert.equal(loadRuleFiles(w).includes("全局内容"), false);
});

test("providers: apiKey 不回显明文", () => {
  const dir = mkdtempSync(join(tmpdir(), "xy-"));
  const s = new ProviderStore(dir);
  s.upsert({ id: "p1", name: "t", baseUrl: "http://x", apiKey: "sk-secret", model: "m" });
  const listed = s.listMasked();
  assert.equal(listed[0].apiKey, "********");
  assert.ok(!JSON.stringify(listed).includes("sk-secret"));
  // 用掩码提交不清空原 key
  s.upsert({ id: "p1", name: "t2", baseUrl: "http://x", apiKey: "********", model: "m" });
  assert.equal(s.activeProvider()!.config.apiKey, "sk-secret");
});

test("providers: listMasked 标记服务端 active,与 activeProvider 同口径", () => {
  const dir = mkdtempSync(join(tmpdir(), "xy-"));
  const s = new ProviderStore(dir);
  s.upsert({ id: "p1", name: "a", baseUrl: "http://x", apiKey: "k1", model: "m" });
  s.upsert({ id: "p2", name: "b", baseUrl: "http://x", apiKey: "k2", model: "m" });
  // 首个 upsert 自动成为 active
  assert.deepEqual(s.listMasked().map((p) => p.active), [true, false]);
  s.setActive("p2");
  assert.deepEqual(s.listMasked().map((p) => p.active), [false, true]);
  // activeProviderId 指向不存在的 id 时回退到列表第一项
  s.setActive("missing");
  assert.deepEqual(s.listMasked().map((p) => p.active), [true, false]);
  assert.equal(s.activeProvider()!.config.id, "p1");
});
