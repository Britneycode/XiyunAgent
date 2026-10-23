import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkStore, htmlToText } from "./docs.ts";
import { listTool } from "./tools.ts";
import { openDb } from "./db.ts";

function setup() {
  return new WorkStore(openDb(":memory:"));
}

describe("htmlToText", () => {
  it("去 script/style,解常见实体,压缩空行", () => {
    const text = htmlToText("<html><head><style>body{}</style><title>T</title></head><body><h1>需求</h1><p>A&nbsp;B &amp; C</p><script>evil()</script></body></html>");
    expect(text).toContain("需求");
    expect(text).toContain("A B & C");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("body{");
  });
});

describe("WorkStore 文档", () => {
  const ws = mkdtempSync(join(tmpdir(), "xiyun-work-"));
  it("导入工作区文件并检索到来源片段", async () => {
    const store = setup();
    mkdirSync(join(ws, "req"), { recursive: true });
    writeFileSync(join(ws, "req", "spec.md"), "# 供应商需求\n交付截止日期为 2026-11-01,包含审计日志。");
    const d = await store.importFile(ws, "req/spec.md", "s1");
    expect(d.kind).toBe("file");
    expect(d.source).toBe("req/spec.md");
    const hits = store.searchDocs("审计日志", 3, ws);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("审计日志");
    expect(hits[0].source).toBe("req/spec.md");
  });
  it("HTML 文件导入时做标签抽取", async () => {
    const store = setup();
    writeFileSync(join(ws, "page.html"), "<html><body><p>正文内容</p><script>x()</script></body></html>");
    const d = await store.importFile(ws, "page.html");
    expect(d.content).toContain("正文内容");
    expect(d.content).not.toContain("<p>");
  });
  it("越权路径被拒绝;粘贴导入记录来源", async () => {
    const store = setup();
    await expect(store.importFile(ws, "../outside.md")).rejects.toThrow("outside workspace");
    const d = store.importPaste("会议纪要", "会议结论:分两期交付", { workspace: ws });
    expect(d.kind).toBe("paste");
    expect(store.listDocs(ws).some((x) => x.title === "会议纪要")).toBe(true);
  });
  it("删除后不再检索", () => {
    const store = setup();
    const d = store.importPaste("临时", "唯一关键词zzq", { workspace: ws });
    store.removeDoc(d.id);
    expect(store.searchDocs("唯一关键词zzq", 3, ws)).toHaveLength(0);
  });
  it("自然语言问句经 3 字滑窗兜底命中文档", async () => {
    const store = setup();
    writeFileSync(join(ws, "plan.md"), "项目分两期交付,第一期包含审计日志与权限矩阵。");
    await store.importFile(ws, "plan.md");
    // 整句不是原文子串,纯 LIKE 必不中;滑窗兜底应命中
    const hits = store.searchDocs("我们的审计日志什么时候交付?", 3, ws);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("审计日志");
  });
  it("收尾清理", () => rmSync(ws, { recursive: true, force: true }));
});

describe("WorkStore 待办", () => {
  it("增删改状态", () => {
    const store = setup();
    const t = store.addTodo({ title: "回签报价单", due: "2026-10-20", workspace: "w1" });
    expect(store.listTodos("w1")).toHaveLength(1);
    store.setTodoStatus(t.id, "done");
    expect(store.getTodo(t.id)!.status).toBe("done");
    expect(store.getTodo(t.id)!.doneAt).not.toBeNull();
    expect(store.listTodos("w1", "open")).toHaveLength(0);
    store.removeTodo(t.id);
    expect(store.listTodos("w1")).toHaveLength(0);
  });
});

describe("listTool", () => {
  it("列出文件并跳过 node_modules/.git", () => {
    const ws = mkdtempSync(join(tmpdir(), "xiyun-list-"));
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(ws, "src", "a.ts"), "");
    writeFileSync(join(ws, "node_modules", "dep", "x.js"), "");
    const files = listTool(ws);
    expect(files).toContain("src/a.ts");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });
});
