import { useCallback, useEffect, useState } from "react";
import { Plug, RefreshCw, Download, ShieldAlert } from "lucide-react";
import { api } from "../api.ts";
import { Button } from "../ui/primitives.tsx";
import { Notice } from "../ui/panel.tsx";
import { cn } from "../ui/cn.ts";

// B3:MCP 服务器区块。列出状态与工具数、展开看工具、重启、编辑 JSON、从 Claude Desktop 导入。
type ServerRow = { name: string; status: string; tools: number; error?: string; stderr?: string };
type ToolRow = { server: string; name: string; description: string };

const STATUS_TONE: Record<string, { label: string; dot: string }> = {
  connected: { label: "已连接", dot: "bg-ok" },
  connecting: { label: "连接中", dot: "bg-accent animate-pulse" },
  error: { label: "出错", dot: "bg-err" },
  disabled: { label: "已停用", dot: "bg-subtle" },
};

export function McpSection({ workspace }: { workspace: string }) {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [pending, setPending] = useState(false);
  const [openName, setOpenName] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.mcpServers(workspace);
      setServers(r.servers);
      setTools(r.tools);
      setPending(r.projectPending);
    } catch {
      // 未连接时静默
    }
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = async () => {
    try {
      const r = await api.mcpConfig(workspace);
      setJson(JSON.stringify(r.user, null, 2));
      setEditing(true);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "读取配置失败", ok: false });
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const parsed = JSON.parse(json) as { mcpServers: Record<string, unknown> };
      await api.saveMcpConfig(parsed);
      setEditing(false);
      setMsg({ text: "已保存", ok: true });
      await load();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "保存失败", ok: false });
    } finally {
      setBusy(false);
    }
  };

  const restart = async (name: string) => {
    setBusy(true);
    try {
      await api.restartMcp(name, workspace);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const importFromDesktop = async () => {
    setBusy(true);
    try {
      const p = await api.mcpImportPreview();
      if (!p.available) {
        setMsg({ text: `没有找到可导入的服务器(${p.path})`, ok: false });
        return;
      }
      const fresh = p.servers.filter((s) => !s.conflict).map((s) => s.name);
      const conflicts = p.servers.filter((s) => s.conflict).map((s) => s.name);
      if (!fresh.length) {
        setMsg({ text: `全部同名冲突,未导入:${conflicts.join("、")}`, ok: false });
        return;
      }
      const r = await api.mcpImportApply(fresh);
      setMsg({
        text: `已导入 ${r.imported} 个${conflicts.length ? `;同名跳过:${conflicts.join("、")}` : ""}`,
        ok: true,
      });
      await load();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "导入失败", ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-ui font-medium text-fg">MCP 服务器</h3>
          <p className="mt-0.5 text-xs text-muted">
            连接外部工具服务器(Model Context Protocol)。用户级配置在 <code className="font-mono">~/.xiyun/mcp.json</code>,
            项目级在 <code className="font-mono">&lt;工作区&gt;/.mcp.json</code>。
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="outline" onClick={() => void openEditor()} disabled={busy}>
            编辑配置
          </Button>
          <Button size="sm" variant="outline" onClick={() => void importFromDesktop()} disabled={busy}>
            <Download size={13} strokeWidth={1.75} />
            从 Claude Desktop 导入
          </Button>
        </div>
      </div>

      {pending && (
        <Notice
          tone="warn"
          action={
            <Button size="xs" variant="outline" onClick={() => void api.trustMcp(workspace).then(load)}>
              信任并启用
            </Button>
          }
        >
          <p className="flex items-center gap-1.5">
            <ShieldAlert size={13} strokeWidth={1.75} />
            该项目有 .mcp.json,首次使用前需要批准(批准后会记住;配置改动后需重新批准)。
          </p>
        </Notice>
      )}

      {msg && <p className={cn("text-xs", msg.ok ? "text-ok" : "text-err")}>{msg.text}</p>}

      {editing && (
        <div className="flex flex-col gap-2">
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            spellCheck={false}
            className="h-64 w-full rounded-md border border-line bg-code px-3 py-2 font-mono text-xs text-code-fg"
          />
          <div className="flex gap-1.5">
            <Button size="sm" onClick={() => void save()} disabled={busy}>
              保存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </div>
      )}

      {servers.length === 0 ? (
        <p className="rounded-md border border-line bg-surface px-3 py-4 text-center text-xs text-subtle">
          还没有配置 MCP 服务器。点「编辑配置」添加,或从 Claude Desktop 导入。
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-line rounded-md border border-line">
          {servers.map((s) => {
            const tone = STATUS_TONE[s.status] ?? STATUS_TONE.connecting!;
            const serverTools = tools.filter((t) => t.server === s.name);
            const open = openName === s.name;
            return (
              <div key={s.name} className="flex flex-col">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className={cn("size-2 shrink-0 rounded-full", tone.dot)} aria-hidden />
                  <button
                    type="button"
                    onClick={() => setOpenName(open ? null : s.name)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="font-mono text-xs text-fg">{s.name}</span>
                    <span className="ml-2 text-2xs text-subtle">
                      {tone.label} · {s.tools} 个工具
                    </span>
                  </button>
                  <Button size="xs" variant="ghost" onClick={() => void restart(s.name)} disabled={busy}>
                    <RefreshCw size={12} strokeWidth={1.75} />
                    重启
                  </Button>
                </div>
                {open && (
                  <div className="border-t border-line bg-code/40 px-3 py-2">
                    {serverTools.length === 0 ? (
                      <p className="font-mono text-2xs text-subtle">(没有工具)</p>
                    ) : (
                      serverTools.map((t) => (
                        <p key={t.name} className="break-all font-mono text-2xs text-muted">
                          <span className="text-fg">{t.name}</span>
                          {t.description ? ` — ${t.description.slice(0, 120)}` : ""}
                        </p>
                      ))
                    )}
                    {s.error && <p className="mt-1 break-all font-mono text-2xs text-err">{s.error}</p>}
                    {s.stderr && (
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs text-subtle">
                        {s.stderr}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="flex items-center gap-1.5 text-2xs text-subtle">
        <Plug size={11} strokeWidth={1.75} />
        MCP 工具名形如 mcp__服务器__工具,默认需要确认;可在「权限与安全」里用 mcp__server__* 放行。
      </p>
    </div>
  );
}
