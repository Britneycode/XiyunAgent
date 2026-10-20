import { useEffect, useRef, useState } from "react";
import type { ModelRole, ProviderConfig, SkillInfo } from "@xiyun/shared";
import { api } from "./api.ts";
import {
  allPresets, applyTheme, exportThemePackage, importThemePackage, loadTheme, resetTheme, saveTheme,
  type ThemeSettings,
} from "./theme.ts";

const ROLES: ModelRole[] = ["main", "subagent", "vision", "memory", "embedding", "coder", "reviewer", "tester", "researcher", "tutor"];
const CAPABILITIES = ["stream", "tools", "vision", "json"] as const;
const CATEGORIES = ["通用", "外观", "模型", "子智能体", "记忆", "工作区", "数据", "权限与安全", "Skill", "插件", "关于"] as const;
type Category = (typeof CATEGORIES)[number];

function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeSettings>(loadTheme);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState("");

  useEffect(() => { applyTheme(theme); saveTheme(theme); }, [theme]);
  const set = <K extends keyof ThemeSettings>(k: K, v: ThemeSettings[K]) => setTheme((t) => ({ ...t, [k]: v }));

  return (
    <>
      <h2>外观</h2>
      <div className="theme-grid">
        {allPresets().map((p) => {
          const t = p.tokens;
          return (
            <div
              key={p.id}
              className={`theme-card${theme.presetId === p.id ? " active" : ""}`}
              onClick={() => set("presetId", p.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && set("presetId", p.id)}
            >
              <div className="name">
                {p.name}
                <span className="tag">{p.appearance === "system" ? "跟随系统" : p.appearance === "dark" ? "深色" : "浅色"}</span>
              </div>
              <div className="swatches">
                {[t.bg, t.surface, t.text, t.accent, t.codeBg].map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <label>主题色覆盖(留空跟随预设)
        <input type="color" value={theme.accent || "#888888"} onChange={(e) => set("accent", e.target.value)} />
        {theme.accent && <button onClick={() => set("accent", "")}>清除</button>}
      </label>
      <label>普通字体 <input value={theme.fontFamily} placeholder="跟随预设" onChange={(e) => set("fontFamily", e.target.value)} /></label>
      <label>阅读字体 <input value={theme.readingFontFamily} placeholder="跟随预设" onChange={(e) => set("readingFontFamily", e.target.value)} /></label>
      <label>代码字体 <input value={theme.codeFontFamily} placeholder="跟随预设" onChange={(e) => set("codeFontFamily", e.target.value)} /></label>
      <label>字号
        <select value={theme.fontSize} onChange={(e) => set("fontSize", e.target.value as ThemeSettings["fontSize"])}>
          <option value="small">小</option>
          <option value="medium">中</option>
          <option value="large">大</option>
        </select>
      </label>
      <label>界面密度
        <select value={theme.density} onChange={(e) => set("density", e.target.value as ThemeSettings["density"])}>
          <option value="comfortable">舒适</option>
          <option value="compact">紧凑</option>
        </select>
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => exportThemePackage(theme)}>导出主题包</button>
        <button onClick={() => fileRef.current?.click()}>导入主题包</button>
        <button className="danger" onClick={() => setTheme(resetTheme())}>恢复默认</button>
        <input ref={fileRef} type="file" accept=".json" hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const preset = importThemePackage(await f.text());
              set("presetId", preset.id);
              setImportError("");
            } catch (err) {
              setImportError(err instanceof Error ? err.message : "主题包无效");
            }
          }} />
      </div>
      {importError && <p style={{ color: "#d6453d" }}>导入失败:{importError}</p>}
    </>
  );
}

function ProvidersSection() {
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof api.providers>>>([]);
  const [draft, setDraft] = useState<ProviderConfig>({ id: "", name: "", baseUrl: "", apiKey: "", model: "", roles: ["main"], capabilities: ["stream"] });
  const [probe, setProbe] = useState<Record<string, string>>({});

  useEffect(() => { void api.providers().then(setProviders); }, []);

  const saveProvider = async () => {
    await api.saveProvider({ ...draft, id: draft.id || crypto.randomUUID() });
    setProviders(await api.providers());
    setDraft({ id: "", name: "", baseUrl: "", apiKey: "", model: "", roles: ["main"], capabilities: ["stream"] });
  };

  const doProbe = async (id: string) => {
    setProbe((m) => ({ ...m, [id]: "探测中…" }));
    try {
      const r = await api.probeProvider(id);
      setProbe((m) => ({ ...m, [id]: r.ok ? `可用 ${r.latencyMs}ms` : `不可用:${r.error ?? ""}` }));
    } catch (e) {
      setProbe((m) => ({ ...m, [id]: e instanceof Error ? e.message : "探测失败" }));
    }
  };

  return (
    <>
      <h2>模型</h2>
      {providers.map((p) => (
        <div key={p.id} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ flex: 1 }}>{p.name || "(未命名)"}({p.model})[{p.roles?.join(",") || "无角色"}]</span>
            <button onClick={() => void api.activateProvider(p.id).then(api.providers).then(setProviders)}>设为默认</button>
            <button onClick={() => void doProbe(p.id)}>探测</button>
            <button onClick={() => setDraft({ ...p, apiKey: "" })}>编辑</button>
            <button onClick={() => void api.deleteProvider(p.id).then(api.providers).then(setProviders)}>删除</button>
          </div>
          {(probe[p.id] || (p.capabilities?.length ?? 0) > 0) && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
              {p.capabilities?.length ? `能力:${p.capabilities.join("/")}` : ""}
              {probe[p.id] ? ` ${probe[p.id]}` : ""}
            </div>
          )}
        </div>
      ))}
      <label>名称 <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>Base URL <input value={draft.baseUrl} placeholder="https://api.openai.com/v1"
        onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
      <label>API Key <input type="password" value={draft.apiKey} placeholder="留空则保留原 Key"
        onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} /></label>
      <label>模型 <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></label>
      <label>角色标签
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {ROLES.map((r) => (
            <span key={r}>
              <input type="checkbox" checked={draft.roles?.includes(r) ?? false}
                onChange={(e) =>
                  setDraft({ ...draft, roles: e.target.checked ? [...(draft.roles ?? []), r] : (draft.roles ?? []).filter((x) => x !== r) })
                } />
              {r}
            </span>
          ))}
        </span>
      </label>
      <label>能力标签
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {CAPABILITIES.map((cap) => (
            <span key={cap}>
              <input type="checkbox" checked={draft.capabilities?.includes(cap) ?? false}
                onChange={(e) =>
                  setDraft({ ...draft, capabilities: e.target.checked ? [...(draft.capabilities ?? []), cap] : (draft.capabilities ?? []).filter((x) => x !== cap) })
                } />
              {cap}
            </span>
          ))}
        </span>
      </label>
      <button className="primary" onClick={() => void saveProvider()}>保存 Provider</button>
    </>
  );
}

function SubagentsSection() {
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof api.providers>>>([]);
  useEffect(() => { void api.providers().then(setProviders); }, []);
  const AGENT_ROLES = ["coder", "reviewer", "tester", "researcher", "tutor", "memory"] as const;
  return (
    <>
      <h2>子智能体</h2>
      <p style={{ color: "var(--muted)" }}>各角色的模型绑定(在「模型」页通过角色标签配置;同角色多个模型构成授权回退链)。任务派发在右侧栏「子任务」面板。</p>
      {AGENT_ROLES.map((role) => {
        const bound = providers.filter((p) => p.roles?.includes(role as ModelRole));
        return (
          <div key={role} className="fact">
            <div><strong>{role}</strong></div>
            <div className="meta">
              {bound.length === 0 ? <span style={{ color: "var(--muted)" }}>未绑定模型</span> : bound.map((p) => <span key={p.id} className="badge">{p.name || p.model}</span>)}
            </div>
          </div>
        );
      })}
    </>
  );
}

function PlaceholderSection({ title, note }: { title: string; note: string }) {
  return (
    <>
      <h2>{title}</h2>
      <p style={{ color: "var(--muted)" }}>{note}</p>
    </>
  );
}

// 阶段 6:Skill 管理——导入(目录或 ZIP)不自动启用,启用前展示模式/角色/记忆范围与静态检查警告。
function SkillsSection() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const refresh = () => void api.skills().then(setSkills).catch(() => {});
  useEffect(refresh, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^\d+:\s*|\{|\}|"error":|"/g, " ").trim() : "操作失败");
    }
  };

  return (
    <>
      <h2>Skill</h2>
      {error && <p className="tool-out err">{error}</p>}
      <div className="row" style={{ display: "flex", gap: 6 }}>
        <input style={{ flex: 1 }} value={path} placeholder="Skill 目录或 ZIP 的绝对路径(示例见仓库 examples/skills/)"
          onChange={(e) => setPath(e.target.value)} />
        <button className="primary" disabled={!path.trim()}
          onClick={() => void run(async () => { await api.importSkill(path.trim()); setPath(""); })}>
          导入
        </button>
      </div>
      {skills.length === 0 && <p style={{ color: "var(--muted)" }}>还没有 Skill。导入后需手动启用才会注入对话。</p>}
      {skills.map((s) => (
        <div className="cand" key={s.id}>
          <div>
            <b>{s.name}</b> <span style={{ color: "var(--muted)" }}>v{s.version} · {s.id}</span>
            {s.enabled && <span className="badge" style={{ marginLeft: 6 }}>已启用</span>}
          </div>
          <div className="reason">
            {s.description || "(无描述)"}
            {s.modes.length > 0 && ` · 模式:${s.modes.join("/")}`}
            {s.roles.length > 0 && ` · 角色:${s.roles.join("/")}`}
            {s.memoryScopes.length > 0 && ` · 记忆范围:${s.memoryScopes.join("/")}`}
          </div>
          {s.warnings.length > 0 && <p className="risks" style={{ color: "#d6453d", fontSize: 12 }}>静态检查:{s.warnings.join(";")}</p>}
          <div className="row">
            {s.enabled ? (
              <button onClick={() => void run(() => api.disableSkill(s.id))}>禁用</button>
            ) : (
              <button className="primary" onClick={() => void run(() => api.enableSkill(s.id))}>启用</button>
            )}
            <button className="danger" onClick={() => void run(() => api.deleteSkill(s.id))}>删除</button>
          </div>
        </div>
      ))}
    </>
  );
}

// 阶段 6:权限与安全——当前授权实况(Provider 角色、Skill 声明权限)+ 审计日志尾部。
function SecuritySection() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [events, setEvents] = useState<Array<{ type: string; payload: string; created_at: string }>>([]);
  useEffect(() => {
    void api.skills().then(setSkills).catch(() => {});
    void api.events(50).then(setEvents).catch(() => {});
  }, []);
  return (
    <>
      <h2>权限与安全</h2>
      <h3>已启用 Skill 的权限声明</h3>
      {skills.filter((s) => s.enabled).length === 0 && <p style={{ color: "var(--muted)" }}>没有已启用的 Skill。</p>}
      {skills.filter((s) => s.enabled).map((s) => (
        <p key={s.id} style={{ fontSize: 13 }}>
          <b>{s.name}</b>:模式 [{s.modes.join("/") || "全部"}] · 角色 [{s.roles.join("/") || "全部"}] ·
          记忆范围 [{s.memoryScopes.join("/") || "未声明"}] · 不含可执行能力
        </p>
      ))}
      <p style={{ color: "var(--muted)", fontSize: 12 }}>
        工具权限基线:文件/命令限制在工作区内;非白名单命令、git 提交/推送需确认;危险命令直接拒绝。详见 RUNBOOK.md 高风险操作验收。
      </p>
      <h3>审计日志(最近 50 条)</h3>
      <pre className="tool-out" style={{ maxHeight: 300, overflowY: "auto" }}>
        {events.map((e, i) => `${e.created_at}  ${e.type}  ${e.payload.slice(0, 160)}`).join("\n") || "(空)"}
      </pre>
    </>
  );
}

// 数据迁移:导出/导入会话、资料、待办、记忆。导出包不含 API Key 与审计日志。
function DataSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState("");
  const [preview, setPreview] = useState<Record<string, { total: number; duplicate?: number; added?: number }> | null>(null);
  const [pendingPack, setPendingPack] = useState<unknown>(null);

  const doExport = async () => {
    setMsg("");
    try {
      const pack = await api.exportData();
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `xiyun-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setMsg("已导出(不含 API Key 与审计日志)。");
    } catch (e) {
      setMsg(`导出失败:${e instanceof Error ? e.message : e}`);
    }
  };

  const onFile = async (f: File) => {
    setMsg("");
    setPreview(null);
    try {
      const pack = JSON.parse(await f.text()) as unknown;
      const p = await api.importPreview(pack);
      setPendingPack(pack);
      setPreview(p);
    } catch (e) {
      setMsg(`预览失败:${e instanceof Error ? e.message : e}`);
    }
  };

  const doImport = async () => {
    try {
      const r = await api.importData(pendingPack);
      setMsg(`导入完成:新增会话 ${r.added.sessions}、消息 ${r.added.messages}、资料 ${r.added.docs}、待办 ${r.added.todos}、记忆 ${r.added.facts};跳过重复 ${r.skipped.sessions + r.skipped.docs + r.skipped.todos + r.skipped.facts} 条。`);
      setPreview(null);
      setPendingPack(null);
    } catch (e) {
      setMsg(`导入失败:${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <>
      <h2>数据</h2>
      <p style={{ color: "var(--muted)" }}>导出会话、资料、待办和记忆为 JSON 文件,用于迁移或备份;不含 API Key 与审计日志。导入时同 id 内容跳过,不覆盖已有数据。</p>
      <div className="row" style={{ display: "flex", gap: 6 }}>
        <button className="primary" onClick={() => void doExport()}>导出全部数据</button>
        <button onClick={() => fileRef.current?.click()}>导入数据包…</button>
        <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
      </div>
      {preview && (
        <div className="cand">
          <div><b>导入预览</b>(同 id 跳过,不覆盖)</div>
          <div className="reason">
            {(["sessions", "docs", "todos", "facts"] as const).map((k) => preview[k] && (
              <span key={k} style={{ marginRight: 10 }}>
                {{ sessions: "会话", docs: "资料", todos: "待办", facts: "记忆" }[k]}:新增 {preview[k].added} / 重复 {preview[k].duplicate}
              </span>
            ))}
            {preview.messages && <span>消息 {preview.messages.total} 条(随会话导入)</span>}
          </div>
          <div className="row">
            <button className="primary" onClick={() => void doImport()}>确认导入</button>
            <button onClick={() => { setPreview(null); setPendingPack(null); }}>取消</button>
          </div>
        </div>
      )}
      {msg && <p className="tool-out" style={{ whiteSpace: "pre-wrap" }}>{msg}</p>}
    </>
  );
}

export function SettingsPage() {
  const [cat, setCat] = useState<Category>("外观");

  return (
    <div className="settings">
      <nav className="settings-nav">
        {CATEGORIES.map((c) => (
          <button key={c} className={c === cat ? "active" : ""} onClick={() => setCat(c)}>{c}</button>
        ))}
      </nav>
      <div className="settings-body">
        {cat === "外观" && <AppearanceSection />}
        {cat === "模型" && <ProvidersSection />}
        {cat === "子智能体" && <SubagentsSection />}
        {cat === "通用" && <PlaceholderSection title="通用" note="界面语言跟随系统;默认模式为 Chat;每个模式独立记住最近活动会话,重启后自动恢复。对话快捷键:Enter 发送,Shift+Enter 换行,Esc 停止生成;生成失败可点「重试」,对回答不满意可点「重新生成」。界面密度在「外观」页。" />}
        {cat === "记忆" && <PlaceholderSection title="记忆" note="记忆事实与候选的筛选、确认、删除在顶栏「记忆」页。" />}
        {cat === "工作区" && <PlaceholderSection title="工作区" note="工作区在 Code/Work 页顶部绑定;文件与命令工具由 PathGuard 限制在工作区内。规则文件按序加载:全局 data/rules/global.md → 模式 data/rules/<mode>.md → 项目 AGENTS.md/CLAUDE.md,项目规则优先级最高。" />}
        {cat === "权限与安全" && <SecuritySection />}
        {cat === "数据" && <DataSection />}
        {cat === "Skill" && <SkillsSection />}
        {cat === "插件" && <PlaceholderSection title="插件" note="可执行插件沙箱(Extension API)尚未实现;Skill 已支持声明式权限,见「Skill」与「权限与安全」页。插件执行能力在有真实需求后交付。" />}
        {cat === "关于" && <PlaceholderSection title="关于" note="XiyunAgent · 本地优先的个人 Agent 工作台。" />}
      </div>
    </div>
  );
}
