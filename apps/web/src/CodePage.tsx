import { useCallback, useEffect, useState } from "react";
import type { SessionMeta, ShellInfo, ShellResult } from "@xiyun/shared";
import { api } from "./api.ts";
import type { GitPreview } from "@xiyun/shared";
import { ChatPage } from "./ChatPage.tsx";

type DrawerTab = "diff" | "terminal" | "commit";

// 状态徽章配色(styles.css 无现成类,内联即可)
const badgeStyle = (color: string) =>
  ({ border: `1px solid ${color}`, color, borderRadius: 10, padding: "0 6px", fontSize: 11, whiteSpace: "nowrap" }) as const;

function Output({ r }: { r: ShellResult }) {
  return (
    <pre className="tool-out">
      [{r.shell}] {r.command} → exit {r.exitCode}({r.durationMs}ms{r.timedOut ? " 超时" : ""}){"\n"}
      {r.stdout}
      {r.stderr && `\n[stderr]\n${r.stderr}`}
    </pre>
  );
}

// Code 页:对话 + 底部抽屉(Git 状态/Diff、终端、提交确认)。
// 提交与非白名单命令必须用户显式确认;危险命令 Server 直接拒绝。
export function CodePage({ session, onSessionChanged }: { session: SessionMeta; onSessionChanged: () => void }) {
  const [ws, setWs] = useState(session.workspace);
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [shell, setShell] = useState("");
  const [cmd, setCmd] = useState("");
  const [pending, setPending] = useState<{ command: string } | null>(null);
  const [out, setOut] = useState<ShellResult | { error: string } | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [preview, setPreview] = useState<GitPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => setWs(session.workspace), [session.id, session.workspace]);
  useEffect(() => {
    void api.shells().then((s) => {
      setShells(s);
      if (s[0]) setShell(s[0].id);
    }).catch(() => {});
  }, []);

  const loadDiff = useCallback(async () => {
    try {
      const [status, diff] = await Promise.all([api.gitStatus(session.workspace), api.gitDiff(session.workspace)]);
      setOut({ ...diff, stdout: `$ git status\n${status.stdout}\n$ git diff HEAD\n${diff.stdout || "(无未提交改动)"}` });
    } catch (e) {
      setOut({ error: e instanceof Error ? e.message : "加载失败" });
    }
  }, [session.workspace]);

  useEffect(() => {
    if (drawer === "diff") void loadDiff();
  }, [drawer, loadDiff]);

  // 打开提交抽屉时拉取待提交范围;默认勾选全部(已暂存项不勾无法剥离)
  const loadPreview = useCallback(async () => {
    try {
      const p = await api.gitPreview(session.workspace);
      setPreview(p);
      setSelected(p.files.map((f) => f.path));
    } catch (e) {
      setPreview(null);
      setSelected([]);
      setOut({ error: e instanceof Error ? e.message : "加载提交范围失败" });
    }
  }, [session.workspace]);

  useEffect(() => {
    if (drawer === "commit") void loadPreview();
  }, [drawer, loadPreview]);

  const saveWs = async () => {
    await api.updateSession(session.id, { workspace: ws.trim() });
    onSessionChanged();
  };

  const runCmd = async (confirmed: boolean, command = cmd) => {
    setBusy(true);
    setPending(null);
    try {
      const r = await api.toolShell({ workspace: session.workspace, command, shell, confirmed });
      setOut(r);
      if (!r.needsConfirm) setCmd("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 409:需要确认 → 显示确认条
      if (msg.startsWith("409")) setPending({ command });
      else setOut({ error: msg });
    } finally {
      setBusy(false);
    }
  };

  // 只提交勾选的文件;取消时仅关闭抽屉,不发写请求,Git 状态不变
  const commit = async () => {
    setBusy(true);
    try {
      const r = await api.gitCommit({ workspace: session.workspace, message: commitMsg, files: selected, confirmed: true });
      setOut(r);
      setCommitMsg("");
      await loadPreview();
      void loadDiff();
    } catch (e) {
      setOut({ error: e instanceof Error ? e.message : "提交失败" });
    } finally {
      setBusy(false);
    }
  };

  const toggleFile = (path: string) =>
    setSelected((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path]));

  return (
    <div className="code-page">
      <div className="code-wsbar">
        <span style={{ color: "var(--muted)", fontSize: 12 }}>工作区</span>
        <input value={ws} onChange={(e) => setWs(e.target.value)} placeholder="项目目录绝对路径" />
        <button onClick={() => void saveWs()} disabled={ws.trim() === session.workspace}>绑定</button>
        <span className="spacer" />
        {(["diff", "terminal", "commit"] as DrawerTab[]).map((t) => (
          <button key={t} className={drawer === t ? "active" : ""}
            onClick={() => setDrawer(drawer === t ? null : t)}>
            {t === "diff" ? "Diff 审查" : t === "terminal" ? "终端" : "提交"}
          </button>
        ))}
      </div>
      <ChatPage key={session.id} session={session} />
      {drawer && (
        <div className="code-drawer">
          {drawer === "terminal" && (
            <div className="row" style={{ padding: "0 0 6px" }}>
              <select value={shell} onChange={(e) => setShell(e.target.value)}>
                {shells.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <input style={{ flex: 1 }} value={cmd} placeholder="命令(非白名单命令需确认)"
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void runCmd(false)} />
              <button className="primary" disabled={busy || !cmd.trim()} onClick={() => void runCmd(false)}>运行</button>
            </div>
          )}
          {drawer === "commit" && (
            <>
              {preview && (
                <div style={{ marginBottom: 6, fontSize: 12 }}>
                  {preview.files.length === 0 ? (
                    <div style={{ color: "var(--muted)" }}>无待提交改动</div>
                  ) : (
                    <>
                      <div style={{ color: "var(--muted)", marginBottom: 4 }}>提交范围({selected.length}/{preview.files.length})</div>
                      {preview.files.map((f) => (
                        <label key={f.path} className="row" style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", fontFamily: "var(--code-font)" }}>
                          <input type="checkbox" checked={selected.includes(f.path)} onChange={() => toggleFile(f.path)} />
                          {f.staged && <span style={badgeStyle("#2da44e")}>已暂存</span>}
                          {f.unstaged && <span style={badgeStyle("#d29922")}>未暂存</span>}
                          {f.untracked && <span style={badgeStyle("#8250df")}>未跟踪</span>}
                          <span style={{ wordBreak: "break-all" }}>{f.path}</span>
                        </label>
                      ))}
                    </>
                  )}
                  {preview.cachedStat.trim() !== "" && (
                    <div className="confirm-bar" style={{ marginTop: 6 }}>
                      <span>工作区已有暂存内容,提交将连带已有暂存内容(勾选项之外的暂存文件也会一并提交)</span>
                    </div>
                  )}
                  <pre className="tool-out">{`$ git diff --stat(未暂存)\n${preview.diffStat || "(无)"}\n\n$ git diff --cached --stat(已暂存)\n${preview.cachedStat || "(无)"}`}</pre>
                </div>
              )}
              <div className="row" style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 0 6px" }}>
                <input style={{ flex: 1 }} value={commitMsg} placeholder="提交信息(只提交勾选的文件)"
                  onChange={(e) => setCommitMsg(e.target.value)} />
                <button className="danger" disabled={busy || !commitMsg.trim() || selected.length === 0} onClick={() => void commit()}>
                  确认提交
                </button>
                <button disabled={busy} onClick={() => setDrawer(null)}>取消</button>
              </div>
            </>
          )}
          {pending && (
            <div className="confirm-bar">
              <span>命令需要确认:<code>{pending.command}</code></span>
              <button className="danger" onClick={() => void runCmd(true, pending.command)}>确认执行</button>
              <button onClick={() => setPending(null)}>取消</button>
            </div>
          )}
          {out && ("error" in out ? <pre className="tool-out err">{out.error}</pre> : <Output r={out} />)}
        </div>
      )}
    </div>
  );
}
