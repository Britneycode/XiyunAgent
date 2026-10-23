import { useCallback, useEffect, useState } from "react";
import { Library, SquareCheckBig } from "lucide-react";
import type { SessionMeta, Todo, WorkDoc } from "@xiyun/shared";
import { api } from "./api.ts";
import { ChatPage } from "./ChatPage.tsx";
import type { Preview } from "./chat/blocks.tsx";
import { ContextBar, PanelToggle } from "./layout/ContextBar.tsx";
import { InspectorPortal, useInspectorBadge, useInspectorBridge } from "./layout/inspectorBridge.tsx";
import { errorMessage, langFromPath } from "./ui/format.ts";
import { DocsPanel, type ImportMode } from "./work/DocsPanel.tsx";
import { TodosPanel } from "./work/TodosPanel.tsx";

export interface WorkPageProps {
  session: SessionMeta;
  onSessionChanged: () => void;
  onPreview?: (p: Preview) => void;
  onBranch?: (messageId: number) => void;
  onNewSession?: () => void;
  onCandidatesChanged?: () => void;
}

// Work 页:对话 + 检查器中的"资料"(文件 / 网页 / 粘贴导入、工作目录文件)与"待办"面板。
// 文档导入保留来源,对话结论可回链(由 system prompt 约束标注来源)。
export function WorkPage({ session, onSessionChanged, onPreview, onBranch, onNewSession, onCandidatesChanged }: WorkPageProps) {
  const workspace = session.workspace;
  const bridge = useInspectorBridge();
  const [files, setFiles] = useState<string[]>([]);
  const [docs, setDocs] = useState<WorkDoc[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [doc, setDoc] = useState<WorkDoc | null>(null);
  // F8:从检索结果打开文档时标出的命中块
  const [focus, setFocus] = useState<{ start: number; end: number } | null>(null);
  const [mode, setMode] = useState<ImportMode>("file");
  const [importPath, setImportPath] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteContent, setPasteContent] = useState("");
  const [todoTitle, setTodoTitle] = useState("");
  const [todoDue, setTodoDue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!workspace) return;
    void api.listFiles(workspace).then((r) => setFiles(r.files)).catch(() => setFiles([]));
    void api.workDocs(workspace).then(setDocs).catch(() => {});
    void api.todos(workspace).then(setTodos).catch(() => {});
  }, [workspace]);

  // 切换工作目录:清空旧数据后重新读取
  useEffect(() => {
    setFiles([]);
    setDocs([]);
    setTodos([]);
    setDoc(null);
    setError("");
    refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(`操作失败(未修改任何数据):${errorMessage(e)}。可修正后重试。`);
    } finally {
      setBusy(false);
    }
  };

  const previewFile = async (path: string) => {
    try {
      const r = await api.readFile(workspace, path);
      const lang = langFromPath(path);
      // Markdown 按文档渲染,其余按代码查看
      onPreview?.({ kind: "artifact", title: path, body: r.content, lang: lang === "markdown" ? undefined : lang || "text" });
    } catch (e) {
      setError(`读取失败:${errorMessage(e)}`);
    }
  };

  const openTodos = todos.filter((t) => t.status === "open").length;
  useInspectorBadge("docs", docs.length || undefined);
  useInspectorBadge("todos", openTodos || undefined);

  const isActive = (id: "docs" | "todos") => !!bridge?.open && bridge.active === id;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContextBar
        label="工作目录"
        workspace={workspace}
        placeholder="工作目录绝对路径"
        onBind={async (path) => {
          await api.updateSession(session.id, { workspace: path });
          onSessionChanged();
        }}
      >
        <PanelToggle icon={Library} label="资料" count={docs.length} active={isActive("docs")} onClick={() => bridge?.togglePanel("docs")} />
        <PanelToggle icon={SquareCheckBig} label="待办" count={openTodos} active={isActive("todos")} onClick={() => bridge?.togglePanel("todos")} />
      </ContextBar>

      <ChatPage
        key={session.id}
        session={session}
        onPreview={onPreview}
        onBranch={onBranch}
        onNewSession={onNewSession}
        onCandidatesChanged={onCandidatesChanged}
        onSessionChanged={onSessionChanged}
      />

      <InspectorPortal id="docs">
        <DocsPanel
          workspace={workspace}
          error={error}
          onDismissError={() => setError("")}
          busy={busy}
          docs={docs}
          doc={doc}
          focus={focus}
          onOpenDoc={(id) => void run(async () => { setFocus(null); setDoc(await api.workDoc(id)); })}
          onOpenDocAt={(id, start, end) =>
            void run(async () => {
              const d = await api.workDoc(id);
              setFocus({ start, end });
              setDoc(d);
            })
          }
          onCloseDoc={() => { setFocus(null); setDoc(null); }}
          onDeleteDoc={() =>
            doc &&
            void run(async () => {
              await api.deleteDoc(doc.id);
              setDoc(null);
            })
          }
          files={files}
          mode={mode}
          onMode={setMode}
          importPath={importPath}
          onImportPath={setImportPath}
          onImportFile={(path) =>
            void run(async () => {
              await api.importDocFile({ workspace, path: (path ?? importPath).trim(), sessionId: session.id });
              if (!path) setImportPath("");
            })
          }
          importUrl={importUrl}
          onImportUrl={setImportUrl}
          onFetchUrl={() =>
            void run(async () => {
              await api.importDocUrl({ url: importUrl.trim(), workspace, sessionId: session.id });
              setImportUrl("");
            })
          }
          pasteTitle={pasteTitle}
          onPasteTitle={setPasteTitle}
          pasteContent={pasteContent}
          onPasteContent={setPasteContent}
          onSavePaste={() =>
            void run(async () => {
              await api.pasteDoc({ title: pasteTitle || "粘贴资料", content: pasteContent, workspace, sessionId: session.id });
              setPasteTitle("");
              setPasteContent("");
            })
          }
          onRefresh={refresh}
          onPreview={onPreview}
          onPreviewFile={(p) => void previewFile(p)}
          onUploadFile={(file) =>
            void run(async () => {
              await api.uploadDocFile(file, workspace, session.id);
            })
          }
        />
      </InspectorPortal>

      <InspectorPortal id="todos">
        <TodosPanel
          workspace={workspace}
          error={error}
          onDismissError={() => setError("")}
          busy={busy}
          todos={todos}
          title={todoTitle}
          onTitle={setTodoTitle}
          due={todoDue}
          onDue={setTodoDue}
          onAdd={() =>
            void run(async () => {
              await api.addTodo({ title: todoTitle.trim(), due: todoDue || undefined, workspace, sessionId: session.id });
              setTodoTitle("");
              setTodoDue("");
            })
          }
          onSetStatus={(id, done) => void run(() => api.setTodoStatus(id, done ? "done" : "open"))}
          onDelete={(id) => void run(() => api.deleteTodo(id))}
        />
      </InspectorPortal>
    </div>
  );
}
