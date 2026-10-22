import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { ChunkStore, splitChunks } from "./chunks.ts";

// 建一张最小 docs 表 + 分块表(与 db.ts v15 一致)
function setup() {
  const db = openDb(":memory:");
  return { db, chunks: new ChunkStore(db) };
}

describe("splitChunks", () => {
  it("按段落切分,相邻块有重叠", () => {
    const text = "第一段内容。\n\n第二段内容。\n\n第三段内容。";
    const cs = splitChunks(text, 20, 5);
    expect(cs.length).toBeGreaterThan(1);
    for (let i = 1; i < cs.length; i++) {
      // 后一块的起点被前移,产生重叠
      expect(cs[i].start).toBeLessThan(cs[i - 1].end);
    }
  });
  it("超长段落硬切,不会丢内容", () => {
    const text = "x".repeat(2500);
    const cs = splitChunks(text, 800, 100);
    expect(cs.length).toBeGreaterThan(1);
    expect(cs[cs.length - 1].end).toBe(2500);
    expect(cs[0].start).toBe(0);
  });
  it("空内容返回空数组", () => {
    expect(splitChunks("   ")).toEqual([]);
  });
});

describe("ChunkStore 检索", () => {
  it("中文 trigram 命中", () => {
    const { db, chunks } = setup();
    db.prepare("INSERT INTO docs (id, title, kind, source, content, workspace, created_at) VALUES ('d1', '需求', 'file', 'a.md', '交付截止日期为 2026-11-01,包含审计日志。', 'w1', '2026-01-01')").run();
    chunks.rebuild("d1", "交付截止日期为 2026-11-01,包含审计日志。");
    const hits = chunks.search("审计日志", 5, "w1");
    expect(hits.length).toBe(1);
    expect(hits[0].docId).toBe("d1");
    expect(hits[0].snippet).toContain("审计日志");
  });

  it("短查询(不足 3 字符)退回 LIKE", () => {
    const { db, chunks } = setup();
    const content = "紧急:服务器宕机需要立即处理";
    db.prepare("INSERT INTO docs (id, title, kind, source, content, workspace, created_at) VALUES ('d2', '告警', 'file', 'b.md', ?, 'w1', '2026-01-01')").run(content);
    chunks.rebuild("d2", content);
    const hits = chunks.search("宕机", 5, "w1");
    expect(hits.length).toBe(1);
    expect(hits[0].snippet).toContain("宕机");
  });

  it("bm25 排序:命中次数多的排前面", () => {
    const { db, chunks } = setup();
    const a = "权限矩阵说明。权限矩阵是本项目的核心设计。";
    const b = "无关内容,提到一次权限矩阵。";
    db.prepare("INSERT INTO docs (id, title, kind, source, content, workspace, created_at) VALUES ('d3', 'A', 'file', 'a.md', ?, 'w1', '2026-01-01')").run(a);
    db.prepare("INSERT INTO docs (id, title, kind, source, content, workspace, created_at) VALUES ('d4', 'B', 'file', 'b.md', ?, 'w1', '2026-01-01')").run(b);
    chunks.rebuild("d3", a);
    chunks.rebuild("d4", b);
    const hits = chunks.search("权限矩阵", 5, "w1");
    expect(hits.length).toBe(2);
    expect(hits[0].docId).toBe("d3");
  });

  it("每篇文档只返回一个块", () => {
    const { db, chunks } = setup();
    const content = "关键词出现一次。\n\n关键词出现两次。\n\n关键词出现三次。";
    db.prepare("INSERT INTO docs (id, title, kind, source, content, workspace, created_at) VALUES ('d5', 'C', 'file', 'c.md', ?, 'w1', '2026-01-01')").run(content);
    chunks.rebuild("d5", content);
    const hits = chunks.search("关键词", 5, "w1");
    expect(hits.filter((h) => h.docId === "d5")).toHaveLength(1);
  });

  it("块回链:命中块带 start / end,能定位到原文", () => {
    const { db, chunks } = setup();
    const content = "开头内容。\n\n需要定位的段落在这里。\n\n结尾。";
    db.prepare("INSERT INTO docs (id, title, kind, source, content, workspace, created_at) VALUES ('d6', 'D', 'file', 'd.md', ?, 'w1', '2026-01-01')").run(content);
    chunks.rebuild("d6", content);
    const hits = chunks.search("需要定位", 5, "w1");
    expect(hits.length).toBe(1);
    expect(content.slice(hits[0].start, hits[0].end)).toContain("需要定位");
  });

  it("删除文档后不再命中", () => {
    const { db, chunks } = setup();
    const content = "临时资料关键词zzq";
    db.prepare("INSERT INTO docs (id, title, kind, source, content, workspace, created_at) VALUES ('d7', 'E', 'file', 'e.md', ?, 'w1', '2026-01-01')").run(content);
    chunks.rebuild("d7", content);
    expect(chunks.search("关键词zzq", 5, "w1").length).toBe(1);
    chunks.remove("d7");
    expect(chunks.search("关键词zzq", 5, "w1").length).toBe(0);
  });

  it("老文档补建块(backfill 可重复执行)", () => {
    const { db, chunks } = setup();
    // 模拟老数据:只有 docs,没有块
    db.prepare("INSERT INTO docs (id, title, kind, source, content, workspace, created_at) VALUES ('d8', 'F', 'file', 'f.md', '历史文档需要补建块', 'w1', '2026-01-01')").run();
    expect(chunks.count("d8")).toBe(0);
    expect(chunks.backfill()).toBe(1);
    expect(chunks.count("d8")).toBe(1);
    expect(chunks.search("补建块", 5, "w1").length).toBe(1);
    // 重复执行不会重复建
    expect(chunks.backfill()).toBe(0);
    expect(chunks.count("d8")).toBe(1);
  });

  it("自然语言整句无命中时按 3 字滑窗兜底", () => {
    const { db, chunks } = setup();
    const content = "项目分两期交付,第一期包含审计日志与权限矩阵。";
    db.prepare("INSERT INTO docs (id, title, kind, source, content, workspace, created_at) VALUES ('d9', 'G', 'file', 'g.md', ?, 'w1', '2026-01-01')").run(content);
    chunks.rebuild("d9", content);
    const hits = chunks.search("我们的审计日志什么时候交付?", 5, "w1");
    expect(hits.length).toBe(1);
    expect(hits[0].docId).toBe("d9");
  });
});
