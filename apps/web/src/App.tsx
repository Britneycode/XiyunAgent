import { useCallback, useEffect, useState } from "react";
import type { MemoryCandidate, SessionMeta } from "@xiyun/shared";
import { ChatPage } from "./ChatPage.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { MemoryPage } from "./MemoryPage.tsx";
import { TasksPanel } from "./TasksPanel.tsx";
import { CodePage } from "./CodePage.tsx";
import { WorkPage } from "./WorkPage.tsx";
import type { Preview } from "./chat/blocks.tsx";
import { PreviewPanel } from "./chat/PreviewPanel.tsx";
import { api, health } from "./api.ts";
import { applyTheme, loadTheme } from "./theme.ts";

type Mode = "chat" | "work" | "code";
type Page = "main" | "memory" | "settings";

const MODE_LABEL: Record<Mode, string> = { chat: "Chat", work: "Work", code: "Code" };

const MODES = Object.keys(MODE_LABEL) as Mode[];
const ACTIVE_KEY = "xiyun.activeSessions";

const emptyByMode = (): Record<Mode, string | null> => ({ chat: null, work: null, code: null });

// 每模式独立记住活动会话;重启后按 id 恢复,有效性由 sessions 校验后决定。
function loadActiveSessions(): Record<Mode, string | null> {
  const out = emptyByMode();
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "{}") as Record<string, unknown>;
    for (const m of MODES) if (typeof raw[m] === "string") out[m] = raw[m] as string;
  } catch {
    return emptyByMode();
  }
  return out;
}

export function App() {
  const [mode, setMode] = useState<Mode>("chat");
  const [page, setPage] = useState<Page>("main");
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [byMode, setByMode] = useState<Record<Mode, string | null>>(loadActiveSessions);
  const [query, setQuery] = useState("");
  // 窗口 <980px 时 aside 变浮层,默认收起避免遮挡主区;用户可用顶栏按钮展开
  const [asideOpen, setAsideOpen] = useState(() => window.innerWidth >= 980);
  const [asideTab, setAsideTab] = useState<"candidates" | "tasks" | "preview">("candidates");
  const [preview, setPreview] = useState<Preview>(null);
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [online, setOnline] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // 窗口 <720px 时 rail 变浮层,默认收起避免遮挡主区;顶栏按钮展开
  const [railOpen, setRailOpen] = useState(() => window.innerWidth >= 720);

  // 预览入口:记录内容并自动展开 aside 切到预览 tab
  const showPreview = (p: Preview) => {
    setPreview(p);
    setAsideTab("preview");
    setAsideOpen(true);
  };

  useEffect(() => applyTheme(loadTheme()), []);

  useEffect(() => {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(byMode));
  }, [byMode]);

  // 会话分页:首屏 50 条,有 hasMore 时显示"加载更多"。
  // ponytail: 失效槽位清理只在全部加载完(无更多页)时执行,否则未加载页的活动会话会被误判失效。
  const PAGE = 50;
  const [hasMore, setHasMore] = useState(false);
  const refresh = useCallback(
    () => api.sessions(showArchived ? 1 : 0, PAGE, 0).then((r) => {
      const page = Array.isArray(r) ? { list: r, hasMore: false } : r;
      setSessions(page.list);
      setHasMore(page.hasMore);
      setLoaded(true);
    }).catch(() => setOnline(false)),
    [showArchived],
  );
  const loadMore = useCallback(
    () => api.sessions(showArchived ? 1 : 0, PAGE, sessions.length).then((r) => {
      if (Array.isArray(r)) return;
      setSessions((prev) => [...prev, ...r.list]);
      setHasMore(r.hasMore);
    }).catch(() => {}),
    [showArchived, sessions.length],
  );
  const refreshCandidates = useCallback(() => api.candidates("pending").then(setCandidates).catch(() => {}), []);

  useEffect(() => {
    void refresh();
    void refreshCandidates();
    const t = setInterval(() => {
      health().then(setOnline);
      refreshCandidates();
    }, 10000);
    return () => clearInterval(t);
  }, [refresh, refreshCandidates]);

  // 会话被删除或 mode 变化后清掉失效槽位;首次加载前不动,保留重启恢复的候选 id。
  // 仅在全部加载完(无更多页)时执行,避免分页未加载页的会话被误判失效。
  useEffect(() => {
    if (!loaded || hasMore) return;
    setByMode((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const m of MODES) {
        const id = prev[m];
        if (id && !sessions.some((s) => s.id === id && s.mode === m)) {
          next[m] = null;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions, loaded]);

  const newSession = async () => {
    const s = await api.createSession({ mode });
    await refresh();
    setByMode((prev) => ({ ...prev, [mode]: s.id }));
    setPage("main");
  };

  const activeId = byMode[mode];
  // 渲染前校验模式匹配:槽位指向其它模式的会话时按无效处理。
  const active = sessions.find((s) => s.id === activeId && s.mode === mode) ?? null;

  const saveRename = async () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    if (title) await api.updateSession(renaming.id, { title }).catch(() => {});
    setRenaming(null);
    await refresh();
  };

  const archiveSession = async (s: SessionMeta, archived: boolean) => {
    await api.updateSession(s.id, { archived }).catch(() => {});
    await refresh();
  };

  const deleteSession = async (s: SessionMeta) => {
    if (!window.confirm(`删除会话「${s.title}」及其全部消息?此操作不可恢复。`)) return;
    await api.deleteSession(s.id).catch(() => {});
    await refresh();
  };

  const visible = sessions.filter(
    (s) => s.mode === mode && (!query || s.title.toLowerCase().includes(query.toLowerCase())),
  );

  const resolveCandidate = async (id: string, action: "confirm" | "reject") => {
    if (action === "confirm") await api.confirmCandidate(id);
    else await api.rejectCandidate(id);
    await refreshCandidates();
  };

  // 分支到新会话:复制该消息(含)前的历史,切到原模式展示新会话
  const branchTo = async (sessionId: string, messageId: number) => {
    const s = await api.branchSession(sessionId, { messageId }).catch(() => null);
    if (!s) return;
    await refresh();
    setByMode((prev) => ({ ...prev, [s.mode as Mode]: s.id }));
    setMode(s.mode as Mode);
    setPage("main");
  };

  return (
    <div className="shell">
      <header className="topbar">
        {!railOpen && (
          <button className="icon" onClick={() => setRailOpen(true)} title="展开会话栏">⇥</button>
        )}
        <span className="brand">XiyunAgent</span>
        <nav className="mode-switch">
          {MODES.map((m) => (
            <button key={m} className={m === mode ? "active" : ""} onClick={() => { setMode(m); setPage("main"); }}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </nav>
        <span className="status">
          <i className={`dot${online ? "" : " err"}`} />
          {online ? "已连接" : "Server 未连接"}
        </span>
        <span className="spacer" />
        <button onClick={() => setPage("memory")} title="记忆管理">
          记忆{candidates.length > 0 ? `(${candidates.length})` : ""}
        </button>
        <button onClick={() => setPage("settings")} title="设置">设置</button>
        <button className="icon" onClick={() => setAsideOpen(!asideOpen)} title={asideOpen ? "收起侧栏" : "展开侧栏"}>
          {asideOpen ? "⇥" : "⇤"}
        </button>
      </header>
      <div className="shell-body">
        {railOpen && <div className="rail-scrim" onClick={() => setRailOpen(false)} />}
        <aside className={`rail${railOpen ? " open" : ""}`}>
          <div className="rail-head">
            <span className="rail-title">{MODE_LABEL[mode]} 会话</span>
            <button className="icon rail-close" onClick={() => setRailOpen(false)} title="收起会话栏">⇤</button>
          </div>
          <button className="primary" onClick={() => void newSession()}>新会话</button>
          <input placeholder="搜索会话" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button
            className={showArchived ? "active" : ""}
            style={{ fontSize: 12, color: showArchived ? undefined : "var(--muted)" }}
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? "← 返回会话列表" : "已归档会话"}
          </button>
          {visible.map((s) =>
            renaming?.id === s.id ? (
              <input
                key={s.id}
                autoFocus
                value={renaming.title}
                onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveRename();
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={() => void saveRename()}
              />
            ) : (
              <div key={s.id} className={`session-item${s.id === activeId ? " active" : ""}`} role="button" tabIndex={0}
                onClick={() => { setByMode((prev) => ({ ...prev, [mode]: s.id })); setPage("main"); }}
                onKeyDown={(e) => e.key === "Enter" && (setByMode((prev) => ({ ...prev, [mode]: s.id })), setPage("main"))}
                title={s.title}
              >
                <span className="session-title">{s.title}</span>
                <span className="session-actions" onClick={(e) => e.stopPropagation()}>
                  <button title="重命名" onClick={() => setRenaming({ id: s.id, title: s.title })}>✎</button>
                  {showArchived ? (
                    <button title="恢复" onClick={() => void archiveSession(s, false)}>↩</button>
                  ) : (
                    <button title="归档" onClick={() => void archiveSession(s, true)}>▤</button>
                  )}
                  <button title="删除" onClick={() => void deleteSession(s)}>✕</button>
                </span>
              </div>
            ),
          )}
          {visible.length === 0 && <span style={{ color: "var(--muted)", fontSize: 12 }}>无匹配会话</span>}
        </aside>
        <main className="main">
          {page === "settings" ? (
            <SettingsPage />
          ) : page === "memory" ? (
            <MemoryPage onChanged={refreshCandidates} />
          ) : !online ? (
            <div className="empty">Server 未连接,操作不可用。请确认本地服务已启动。</div>
          ) : !loaded ? (
            <div className="empty">加载中…</div>
          ) : mode === "work" ? (
            active ? (
              <WorkPage session={active} onSessionChanged={refresh} />
            ) : (
              <div className="empty">新建或选择一个 Work 会话开始。</div>
            )
          ) : mode === "code" ? (
            active ? (
              <CodePage session={active} onSessionChanged={refresh} />
            ) : (
              <div className="empty">新建或选择一个 Code 会话开始。</div>
            )
          ) : active ? (
            <ChatPage
              key={active.id}
              session={active}
              onBranch={(mid) => void branchTo(active.id, mid)}
              onPreview={showPreview}
              onNewSession={() => void newSession()}
              onCandidatesChanged={refreshCandidates}
            />
          ) : (
            <div className="empty">新建或选择一个 Chat 会话开始。</div>
          )}
        </main>
        {asideOpen && (
          <aside className="aside">
            <div className="aside-tabs">
              <button className={asideTab === "candidates" ? "active" : ""} onClick={() => setAsideTab("candidates")}>
                候选({candidates.length})
              </button>
              <button className={asideTab === "tasks" ? "active" : ""} onClick={() => setAsideTab("tasks")}>
                子任务
              </button>
              <button className={asideTab === "preview" ? "active" : ""} onClick={() => setAsideTab("preview")}>
                预览
              </button>
            </div>
            {asideTab === "preview" ? (
              <PreviewPanel preview={preview} />
            ) : asideTab === "tasks" ? (
              // 只在当前模式的活动会话有效时绑定 sessionId/mode/workspace,否则仅传当前 mode 用于预设文案。
              <TasksPanel
                sessionId={active?.id ?? null}
                mode={active?.mode ?? mode}
                workspace={active?.workspace ?? ""}
              />
            ) : (
              <>
                {candidates.length === 0 && <span style={{ color: "var(--muted)", fontSize: 12 }}>对话中产生的候选记忆会出现在这里。</span>}
                {candidates.slice(0, 8).map((c) => (
                  <div className="cand" key={c.id}>
                    <div>{c.content}</div>
                    <div className="reason">{c.reason || "提取自对话"} · 置信度 {c.confidence.toFixed(2)}</div>
                    <div className="row">
                      <button className="primary" onClick={() => void resolveCandidate(c.id, "confirm")}>确认</button>
                      <button onClick={() => void resolveCandidate(c.id, "reject")}>忽略</button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
