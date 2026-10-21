import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Brain, Eye, GitCompareArrows, Library, ListTodo, LoaderCircle, Plus, SquareCheckBig, SquareTerminal, WifiOff } from "lucide-react";
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
import { CandidateList } from "./layout/CandidateList.tsx";
import { EmptyState } from "./layout/EmptyState.tsx";
import { Inspector, type InspectorTab } from "./layout/Inspector.tsx";
import { InspectorBridgeProvider, type InspectorBridge } from "./layout/inspectorBridge.tsx";
import type { RenameState } from "./layout/SessionList.tsx";
import { SideRail } from "./layout/SideRail.tsx";
import { ShortcutsDialog } from "./layout/ShortcutsDialog.tsx";
import { Sidebar } from "./layout/Sidebar.tsx";
import { StatusBar } from "./layout/StatusBar.tsx";
import { StreamHeader } from "./layout/StreamHeader.tsx";
import { Workbench } from "./layout/Workbench.tsx";
import { MODE_META, MODES, type InspectorTabId, type Mode, type Page, type PanelId } from "./layout/types.ts";
import { Button, Kbd } from "./ui/primitives.tsx";
import { isBoolean, useHotkey, useMediaQuery, usePersistentState } from "./ui/hooks.ts";

const ACTIVE_KEY = "xiyun.activeSessions";
const SIDE_KEY = "xiyun.layout.sideOpen";
// 断点:窄于此宽度时面板改为浮层
const SIDE_OVERLAY_QUERY = "(max-width: 759px)";
const INSPECTOR_OVERLAY_QUERY = "(max-width: 1099px)";

// 未迁移的页面(设置、记忆、子任务面板)包在 .legacy 中,沿用 styles.css 的旧样式与排版
const legacy = (node: ReactNode) => <div className="legacy flex min-h-0 flex-1 flex-col bg-canvas">{node}</div>;

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
  const [preview, setPreview] = useState<Preview>(null);
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [online, setOnline] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<RenameState | null>(null);

  // ---- 布局状态 ----
  // 宽窗口:侧栏停靠(展开 / 收起为窄栏),开关持久化;窄窗口:窄栏常驻,展开为浮层、不持久化。
  const sideOverlay = useMediaQuery(SIDE_OVERLAY_QUERY);
  const inspectorOverlay = useMediaQuery(INSPECTOR_OVERLAY_QUERY);
  const [sideDocked, setSideDocked] = usePersistentState<boolean>(SIDE_KEY, true, isBoolean);
  const [sideFloating, setSideFloating] = useState(false);
  const sideOpen = sideOverlay ? sideFloating : sideDocked;
  const setSideOpen = (open: boolean) => (sideOverlay ? setSideFloating(open) : setSideDocked(open));
  // 检查器默认收起,点击工具卡片/代码块等预览入口时自动滑出
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTabId>("preview");

  // 窗口跨越断点时收起浮层,避免停靠态与浮层态同时出现
  useEffect(() => {
    setSideFloating(false);
  }, [sideOverlay]);

  // 搜索聚焦请求:Ctrl+K 或窄栏搜索按钮 → 展开侧栏并聚焦搜索框
  const [searchRequested, setSearchRequested] = useState(false);
  const onSearchFocused = useCallback(() => setSearchRequested(false), []);
  const requestSearch = () => {
    setSideOpen(true);
    setSearchRequested(true);
  };

  useHotkey("b", () => setSideOpen(!sideOpen), { mod: true });
  useHotkey("j", () => setInspectorOpen((v) => !v), { mod: true });
  useHotkey("k", requestSearch, { mod: true });
  useHotkey("1", () => changeMode("chat"), { mod: true });
  useHotkey("2", () => changeMode("work"), { mod: true });
  useHotkey("3", () => changeMode("code"), { mod: true });
  // M6:与主流聊天应用一致的快捷键;完整清单见 shortcuts.ts / Ctrl+/
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  useHotkey("o", () => void newSession(), { mod: true, shift: true });
  useHotkey("s", () => setSideOpen(!sideOpen), { mod: true, shift: true });
  useHotkey("/", () => setShortcutsOpen((v) => !v), { mod: true });

  const openInspector = (tab: InspectorTabId) => {
    setInspectorTab(tab);
    setInspectorOpen(true);
  };

  // ---- 检查器面板槽位:Code / Work 页通过 portal 把面板渲染进对应标签页 ----
  const [slots, setSlots] = useState<Partial<Record<PanelId, HTMLElement>>>({});
  const slotRef = useMemo(() => {
    const make = (id: PanelId) => (el: HTMLDivElement | null) =>
      setSlots((prev) => (prev[id] === (el ?? undefined) ? prev : { ...prev, [id]: el ?? undefined }));
    return { changes: make("changes"), terminal: make("terminal"), docs: make("docs"), todos: make("todos") };
  }, []);
  const [badges, setBadges] = useState<Partial<Record<PanelId, number>>>({});
  const setBadge = useCallback(
    (id: PanelId, count: number | undefined) => setBadges((prev) => (prev[id] === count ? prev : { ...prev, [id]: count })),
    [],
  );

  // 预览入口:记录内容并自动展开检查器切到预览 tab
  const showPreview = (p: Preview) => {
    setPreview(p);
    openInspector("preview");
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
    setSideFloating(false);
  };

  const activeId = byMode[mode];
  // 渲染前校验模式匹配:槽位指向其它模式的会话时按无效处理。
  const active = sessions.find((s) => s.id === activeId && s.mode === mode) ?? null;

  const selectSession = (s: SessionMeta) => {
    setByMode((prev) => ({ ...prev, [mode]: s.id }));
    setPage("main");
    setSideFloating(false);
  };

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

  // 模式分段控件:切换模式并回到主区;各模式的活动会话由 byMode 分别记住
  function changeMode(m: Mode) {
    setMode(m);
    setPage("main");
  }

  const openPage = (p: Exclude<Page, "main">) => {
    setPage(p);
    setSideFloating(false);
  };

  const meta = MODE_META[mode];
  const headerTitle =
    page === "settings" ? "设置" : page === "memory" ? "记忆管理" : (active?.title ?? `${meta.label} 工作台`);

  const emptyMain = (
    <EmptyState
      icon={meta.icon}
      title={`新建或选择一个 ${meta.label} 会话开始`}
      description={meta.hint}
      action={
        <div className="flex items-center gap-2">
          <Button variant="primary" size="md" onClick={() => void newSession()}>
            <Plus size={14} strokeWidth={2} />
            新会话
          </Button>
          <span className="flex items-center gap-1 text-2xs text-subtle">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
            搜索会话
          </span>
        </div>
      }
    />
  );

  const mainContent =
    page === "settings" ? (
      legacy(<SettingsPage />)
    ) : page === "memory" ? (
      legacy(<MemoryPage onChanged={refreshCandidates} />)
    ) : !online ? (
      <EmptyState
        icon={WifiOff}
        title="Server 未连接"
        description="操作暂不可用。请确认本地服务已启动(默认 127.0.0.1:3777)。"
      />
    ) : !loaded ? (
      <EmptyState icon={LoaderCircle} spin title="加载中…" />
    ) : !active ? (
      emptyMain
    ) : mode === "work" ? (
      <WorkPage
        session={active}
        onSessionChanged={refresh}
        onPreview={showPreview}
        onBranch={(mid) => void branchTo(active.id, mid)}
        onNewSession={() => void newSession()}
        onCandidatesChanged={refreshCandidates}
      />
    ) : mode === "code" ? (
      <CodePage
        session={active}
        onSessionChanged={refresh}
        onPreview={showPreview}
        onBranch={(mid) => void branchTo(active.id, mid)}
        onNewSession={() => void newSession()}
        onCandidatesChanged={refreshCandidates}
      />
    ) : (
      <ChatPage
        key={active.id}
        session={active}
        onBranch={(mid) => void branchTo(active.id, mid)}
        onPreview={showPreview}
        onNewSession={() => void newSession()}
        onCandidatesChanged={refreshCandidates}
        onSessionChanged={refresh}
      />
    );

  // 模式专属面板只在对应页面已挂载时出现(页面负责通过 portal 填充内容)
  const pageMounted = page === "main" && online && loaded && !!active;
  const slotTab = (id: PanelId, label: string, icon: InspectorTab<InspectorTabId>["icon"]): InspectorTab<InspectorTabId> => ({
    id,
    label,
    icon,
    badge: badges[id],
    flush: true,
    content: <div ref={slotRef[id]} className="h-full" />,
  });
  const modeTabs: Array<InspectorTab<InspectorTabId>> = !pageMounted
    ? []
    : mode === "code"
      ? [slotTab("changes", "变更", GitCompareArrows), slotTab("terminal", "终端", SquareTerminal)]
      : mode === "work"
        ? [slotTab("docs", "资料", Library), slotTab("todos", "待办", SquareCheckBig)]
        : [];

  const inspectorTabs: Array<InspectorTab<InspectorTabId>> = [
    {
      id: "preview",
      label: "预览",
      icon: Eye,
      flush: true,
      content: <PreviewPanel preview={preview} onPreview={showPreview} />,
    },
    ...modeTabs,
    {
      id: "tasks",
      label: "子任务",
      icon: ListTodo,
      // 只在当前模式的活动会话有效时绑定 sessionId/mode/workspace,否则仅传当前 mode 用于预设文案。
      content: (
        <div className="legacy">
          <TasksPanel sessionId={active?.id ?? null} mode={active?.mode ?? mode} workspace={active?.workspace ?? ""} />
        </div>
      ),
    },
    {
      id: "candidates",
      label: "候选",
      icon: Brain,
      badge: candidates.length,
      content: (
        <CandidateList candidates={candidates} onResolve={resolveCandidate} onOpenMemory={() => setPage("memory")} />
      ),
    },
  ];

  const bridge: InspectorBridge = {
    slots,
    open: inspectorOpen,
    active: inspectorTab,
    openPanel: openInspector,
    togglePanel: (id) => {
      if (inspectorOpen && inspectorTab === id) setInspectorOpen(false);
      else openInspector(id);
    },
    setBadge,
    showPreview,
  };

  return (
    <InspectorBridgeProvider value={bridge}>
    <Workbench
      rail={
        <SideRail
          mode={mode}
          page={page}
          pendingCandidates={candidates.length}
          onExpand={() => setSideOpen(true)}
          onModeChange={changeMode}
          onNew={() => void newSession()}
          onSearch={requestSearch}
          onOpenPage={openPage}
        />
      }
      sidebar={
        <Sidebar
          mode={mode}
          page={page}
          pendingCandidates={candidates.length}
          query={query}
          focusSearch={searchRequested}
          showArchived={showArchived}
          sessionCount={visible.length}
          hasMore={hasMore}
          list={{
            sessions: visible,
            activeId: page === "main" ? activeId : null,
            loaded,
            renaming,
            emptyText: query
              ? "无匹配会话"
              : showArchived
                ? "没有已归档的会话"
                : `还没有 ${meta.label} 会话`,
            onSelect: selectSession,
            onRenameStart: (s) => setRenaming({ id: s.id, title: s.title }),
            onRenameChange: (title) => setRenaming((r) => (r ? { ...r, title } : r)),
            onRenameCommit: () => void saveRename(),
            onRenameCancel: () => setRenaming(null),
            onArchive: (s, archived) => void archiveSession(s, archived),
            onDelete: (s) => void deleteSession(s),
            onLoadMore: () => void loadMore(),
          }}
          onModeChange={changeMode}
          onOpenPage={openPage}
          onNew={() => void newSession()}
          onQueryChange={setQuery}
          onToggleArchived={() => setShowArchived(!showArchived)}
          onCollapse={() => setSideOpen(false)}
          onSearchFocused={onSearchFocused}
        />
      }
      sideOpen={sideOpen}
      sideOverlay={sideOverlay}
      onSideClose={() => setSideOpen(false)}
      inspector={
        <Inspector
          tabs={inspectorTabs}
          active={inspectorTab}
          onActiveChange={setInspectorTab}
          onClose={() => setInspectorOpen(false)}
        />
      }
      inspectorOpen={inspectorOpen}
      inspectorOverlay={inspectorOverlay}
      onInspectorClose={() => setInspectorOpen(false)}
      statusBar={
        <StatusBar
          online={online}
          mode={mode}
          workspace={page === "main" ? active?.workspace : undefined}
          pendingCandidates={candidates.length}
          onOpenCandidates={() => openInspector("candidates")}
        />
      }
    >
      <StreamHeader
        title={headerTitle}
        badge={page === "main" && active ? meta.label : undefined}
        workspace={page === "main" && mode === "chat" ? active?.workspace : undefined}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
      />
      {mainContent}
      <ShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} />
    </Workbench>
    </InspectorBridgeProvider>
  );
}
