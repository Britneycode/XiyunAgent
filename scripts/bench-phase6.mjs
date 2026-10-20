// 阶段 6 性能基线:造真实规模数据,测 docs 列表/LIKE 检索/滑窗兜底/sessions 列表的延迟与响应大小。
// 运行: node scripts/bench-phase6.mjs
import { openDb } from "../packages/server/src/db.ts";
import { WorkStore } from "../packages/server/src/docs.ts";

const db = openDb(":memory:");
const work = new WorkStore(db);

// 造 1000 篇资料,每篇 ~2KB 正文(模拟真实工作区累积)
const N_DOCS = 1000;
const sample = "贝叶斯定理 后验概率 先验概率 条件概率 假设检验 统计推断 ".repeat(60);
for (let i = 0; i < N_DOCS; i++) {
  work.importPaste(`资料${i}`, `${sample} 编号${i} 特征值${i}`, { workspace: "ws1" });
}
// 造 500 个会话
for (let i = 0; i < 500; i++) {
  db.prepare("INSERT INTO sessions (id, title, mode, workspace, created_at, archived) VALUES (?, ?, 'chat', '', ?, 0)")
    .run(`s${i}`, `会话${i}`, new Date().toISOString());
}

const t = (label, fn) => {
  const t0 = performance.now();
  const out = fn();
  const ms = (performance.now() - t0).toFixed(1);
  const size = typeof out === "object" ? JSON.stringify(out).length : 0;
  console.log(`${label}: ${ms}ms, 响应 ${size}B (${(size / 1024).toFixed(0)}KB)`);
  return out;
};

console.log(`--- 数据规模: ${N_DOCS} 篇资料(~2KB/篇), 500 会话 ---`);
t("docs.listDocs(全部,含正文)", () => work.listDocs());
t("docs.listDocs(workspace,含正文)", () => work.listDocs("ws1"));
t("searchDocs 整句命中", () => work.searchDocs("贝叶斯定理", 3, "ws1"));
t("searchDocs 长问句(滑窗兜底)", () => work.searchDocs("请解释一下后验概率和先验概率在医学检测里到底怎么区分", 3, "ws1"));
t("sessions 全量列表", () => db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all());
