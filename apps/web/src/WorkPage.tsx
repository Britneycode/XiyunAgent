import { useCallback, useEffect, useState } from "react";
import type { SessionMeta, Todo, WorkDoc } from "@xiyun/shared";
import { api } from "./api.ts";
import { ChatPage } from "./ChatPage.tsx";

type DrawerTab = "docs" | "todos";

// Work 页:文件/资料树 + 对话 + 待办。文档导入保留来源,对话结论可回链(由 system prompt 约束标注来源)。
export function WorkPage({ session, onSessionChanged }: { session: SessionMeta; onSessionChanged: () => void }) {
  const [ws, setWs] = useState(session.workspace);
  const [drawer, setDrawer] = useState<DrawerTab | null>("docs");
  const [files, setFiles] = useState<string[]>([]);
  const [docs, setDocs] = useState<WorkDoc[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [doc, setDoc] = useState<WorkDoc | null>(null);
  const [importPath, setImportPath] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteContent, setPasteContent] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [todoTitle, setTodoTitle] = useState("");
  const [todoDue, setTodoDue] = useState("");
  const [error, setError] = useState("");

  useEffect(() => setWs(session.workspace), [session.id, session.workspace]);

  const refresh = useCallback(() => {
    if (!session.workspace) return;
    void api.listFiles(session.workspace).then((r) => setFiles(r.files)).catch(() => setFiles([]));
    void api.workDocs(session.workspace).then(setDocs).catch(() => {});
    void api.todos(session.workspace).then(setTodos).catch(() => {});
  }, [session.workspace]);
  useEffect(refresh, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(`操作失败(未修改任何数据):${e instanceof Error ? e.message.replace(/^\d+:\s*|\{|\}|"error":|"/g, " ").trim() : "未知错误"}。可修正后重试。`);
    }
  };

  const saveWs = async () => {
    await api.updateSession(session.id, { workspace: ws.trim() });
    onSessionChanged();
  };

  return (
    <div className="code-page">
      <div className="code-wsbar">
        <span style={{ color: "var(--muted)", fontSize: 12 }}>工作目录</span>
        <input value={ws} onChange={(e) => setWs(e.target.value)} placeholder="工作目录绝对路径" />
        <button onClick={() => void saveWs()} disabled={ws.trim() === session.workspace}>绑定</button>
        <span className="spacer" />
        {(["docs", "todos"] as DrawerTab[]).map((t) => (
          <button key={t} className={drawer === t ? "active" : ""} onClick={() => setDrawer(drawer === t ? null : t)}>
            {t === "docs" ? `资料(${docs.length})` : `待办(${todos.filter((x) => x.status === "open").length})`}
          </button>
        ))}
      </div>
      <div className="work-body">
        {drawer === "docs" && (
          <aside className="work-side">
            {error && <p className="tool-out err">{error}</p>}
            {doc ? (
              <>
                <div className="row">
                  <button onClick={() => setDoc(null)}>← 返回</button>
                  <button className="danger" onClick={() => void run(async () => { await api.deleteDoc(doc.id); setDoc(null); })}>删除</button>
                </div>
                <h3 style={{ margin: "6px 0 2px" }}>{doc.title}</h3>
                <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 6px" }}>来源:{doc.source}</p>
                <pre className="tool-out" style={{ flex: 1, overflowY: "auto" }}>{doc.content}</pre>
              </>
            ) : (
              <>
                <div className="row">
                  <input style={{ flex: 1 }} value={importPath} placeholder="导入文件(相对路径,如 req/spec.md)"
                    onChange={(e) => setImportPath(e.target.value)} />
                  <button className="primary" disabled={!importPath.trim()}
                    onClick={() => void run(async () => { await api.importDocFile({ workspace: session.workspace, path: importPath.trim(), sessionId: session.id }); setImportPath(""); })}>
                    导入
                  </button>
                </div>
                <div className="row">
                  <input style={{ flex: 1 }} value={importUrl} placeholder="抓取网页 URL"
                    onChange={(e) => setImportUrl(e.target.value)} />
                  <button className="primary" disabled={!importUrl.trim()}
                    onClick={() => void run(async () => { await api.importDocUrl({ url: importUrl.trim(), workspace: session.workspace, sessionId: session.id }); setImportUrl(""); })}>
                    抓取
                  </button>
                </div>
                <button onClick={() => setShowPaste(!showPaste)}>{showPaste ? "收起粘贴" : "粘贴资料"}</button>
                {showPaste && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <input value={pasteTitle} placeholder="标题" onChange={(e) => setPasteTitle(e.target.value)} />
                    <textarea rows={4} value={pasteContent} placeholder="粘贴会议纪要/需求原文…"
                      onChange={(e) => setPasteContent(e.target.value)} />
                    <button className="primary" disabled={!pasteContent.trim()}
                      onClick={() => void run(async () => { await api.pasteDoc({ title: pasteTitle || "粘贴资料", content: pasteContent, workspace: session.workspace, sessionId: session.id }); setPasteTitle(""); setPasteContent(""); setShowPaste(false); })}>
                      保存
                    </button>
                  </div>
                )}
                <span style={{ color: "var(--muted)", fontSize: 12 }}>已导入资料</span>
                {docs.map((d) => (
                  // 列表项只含元数据,点击查看时按需加载正文
                  <button key={d.id} className="session-item" title={d.source}
                    onClick={() => void run(async () => setDoc(await api.workDoc(d.id)))}>
                    {d.title}
                  </button>
                ))}
                {docs.length === 0 && <span style={{ color: "var(--muted)", fontSize: 12 }}>还没有资料。</span>}
                <span style={{ color: "var(--muted)", fontSize: 12 }}>工作目录文件</span>
                <pre className="tool-out" style={{ maxHeight: 180, overflowY: "auto" }}>{files.slice(0, 100).join("\n") || "(空)"}</pre>
              </>
            )}
          </aside>
        )}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <ChatPage key={session.id} sessionId={session.id} />
        </div>
        {drawer === "todos" && (
          <aside className="work-side">
            <div className="row">
              <input style={{ flex: 1 }} value={todoTitle} placeholder="待办事项" onChange={(e) => setTodoTitle(e.target.value)} />
              <input type="date" value={todoDue} onChange={(e) => setTodoDue(e.target.value)} />
              <button className="primary" disabled={!todoTitle.trim()}
                onClick={() => void run(async () => { await api.addTodo({ title: todoTitle.trim(), due: todoDue || undefined, workspace: session.workspace, sessionId: session.id }); setTodoTitle(""); setTodoDue(""); })}>
                添加
              </button>
            </div>
            {todos.map((t) => (
              <div key={t.id} className="cand">
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={t.status === "done"}
                    onChange={(e) => void run(() => api.setTodoStatus(t.id, e.target.checked ? "done" : "open"))} />
                  <span style={{ textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</span>
                </label>
                <div className="reason">
                  {t.due && `截止 ${t.due} · `}{t.source && `来源:${t.source} · `}
                  <a onClick={() => void run(() => api.deleteTodo(t.id))} style={{ cursor: "pointer" }}>删除</a>
                </div>
              </div>
            ))}
            {todos.length === 0 && <span style={{ color: "var(--muted)", fontSize: 12 }}>还没有待办。</span>}
          </aside>
        )}
      </div>
    </div>
  );
}
