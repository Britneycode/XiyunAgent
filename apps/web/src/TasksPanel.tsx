import { useCallback, useEffect, useState } from "react";
import type { AgentRole, SubagentTask, TaskSchedule } from "@xiyun/shared";
import { api, subscribeTaskEvents } from "./api.ts";

const ROLE_LABEL: Record<AgentRole, string> = {
  coder: "Coder", reviewer: "Reviewer", tester: "Tester",
  researcher: "Researcher", tutor: "Tutor", memory: "Memory",
};

const STATUS_LABEL: Record<SubagentTask["status"], string> = {
  queued: "排队", running: "运行中", completed: "完成",
  failed: "失败", cancelled: "已取消", waiting_for_user: "等待用户",
};

const STATUS_CLASS: Record<SubagentTask["status"], string> = {
  queued: "queued", running: "running", completed: "ok",
  failed: "err", cancelled: "muted", waiting_for_user: "queued",
};

function fmtDuration(ms: number | null): string {
  if (ms == null) return "-";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// L4:隔离分支的落地操作。每个都要二次确认,结果(含失败原因)显示在卡片上。
const LANDING: Array<{ key: "merge" | "push" | "pr" | "discard"; label: string; hint: string; run: (id: string) => Promise<unknown> }> = [
  { key: "merge", label: "合并", hint: "把隔离分支合入当前工作区分支?", run: (id) => api.mergeTask(id) },
  { key: "push", label: "推送", hint: "推送隔离分支到 origin?", run: (id) => api.pushTask(id) },
  { key: "pr", label: "建 PR", hint: "推送分支并创建 PR?", run: (id) => api.createTaskPr(id) },
  { key: "discard", label: "丢弃", hint: "删除隔离 worktree 与分支?此操作不可撤销", run: (id) => api.discardTask(id) },
];

type TaskDetail = Awaited<ReturnType<typeof api.taskDetail>>;

function TaskCard({ task, onChanged }: { task: SubagentTask; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [note, setNote] = useState("");
  const [tool, setTool] = useState("");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const active = task.status === "queued" || task.status === "running";

  // 展开时取完整 diff 与每步工具(任务结束后事件流不再订阅,历史从这里补齐)
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api
      .taskDetail(task.id)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, task.id, task.status]);

  // 运行中的任务订阅事件流,显示当前工具(结束或卸载时断开)
  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    void subscribeTaskEvents(
      task.id,
      (e) => {
        const p = e.payload as { tool?: string } | null;
        if (e.type === "task.tool" && p?.tool) setTool(p.tool);
      },
      ac.signal,
    ).catch(() => {});
    return () => ac.abort();
  }, [active, task.id]);
  // 有隔离分支时才显示落地按钮
  const hasBranch = !active && !!task.branch;

  const land = async (op: (typeof LANDING)[number]) => {
    if (!window.confirm(op.hint)) return;
    setNote(`${op.label}中…`);
    try {
      const r = (await op.run(task.id)) as { url?: string; compareUrl?: string; error?: string } | undefined;
      setNote(r?.url ?? r?.compareUrl ?? (r?.error ? `${op.label}失败:${r.error}` : `${op.label}完成`));
      onChanged();
    } catch (e) {
      setNote(`${op.label}失败:${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div className="task" onClick={() => setOpen(!open)} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && setOpen(!open)}>
      <div className="head">
        <span className="badge">{ROLE_LABEL[task.role]}</span>
        <span className={`st ${STATUS_CLASS[task.status]}`}>{STATUS_LABEL[task.status]}</span>
        {active && tool && <span className="tool">{tool}</span>}
        <span className="dur">{fmtDuration(task.durationMs)}</span>
      </div>
      <div className="title">{task.title}</div>
      {task.status === "waiting_for_user" && task.question && (
        <div className="qa" onClick={(e) => e.stopPropagation()}>
          <p className="q">{task.question}</p>
          <div className="row">
            <input value={answer} placeholder="输入回答" onChange={(e) => setAnswer(e.target.value)} />
            <button className="primary" disabled={!answer.trim()}
              onClick={() => void api.resumeTask(task.id, answer.trim()).then(() => { setAnswer(""); onChanged(); })}>
              回答
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="detail" onClick={(e) => e.stopPropagation()}>
          <div className="meta">
            <span>模型 {task.model ?? "未执行"}</span>
            <span>{task.schedule}</span>
            {task.steps != null && <span>{task.steps} 步</span>}
            {task.usage && <span>{task.usage.totalTokens} tokens</span>}
          </div>
          {task.branch && (
            <p className="branch" title={task.worktree ?? ""}>
              {task.baseSha ? `${task.baseSha.slice(0, 7)}...` : ""}
              {task.branch}
            </p>
          )}
          {task.diffStat && <pre className="diffstat">{task.diffStat}</pre>}
          {detail && detail.tools.length > 0 && (
            <div className="steptools">
              <span className="label">工具</span>
              <ol>
                {detail.tools.map((t, i) => (
                  <li key={`${t.at}-${i}`} className={t.status === "error" || t.status === "rejected" ? "bad" : undefined}>
                    {t.tool}
                    {t.status && <em>{t.status}</em>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {detail?.patch && (
            <details className="patch">
              <summary>
                完整 diff({detail.baseSha ? `${detail.baseSha.slice(0, 7)}...` : ""}
                {detail.branch})
              </summary>
              <pre>{detail.patch}</pre>
            </details>
          )}
          {task.result && <p className="summary">{task.result.summary}</p>}
          {task.result && task.result.risks.length > 0 && (
            <p className="risks">风险:{task.result.risks.join(";")}</p>
          )}
          {task.error && <p className="risks">{task.error}</p>}
          <div className="row">
            {active && (
              <button
                onClick={() => {
                  if (window.confirm("停止该任务?已产生的改动会保留在隔离分支上")) void api.cancelTask(task.id).then(onChanged);
                }}
              >
                停止
              </button>
            )}
            {(task.status === "failed" || task.status === "cancelled") && (
              <button onClick={() => void api.retryTask(task.id).then(onChanged)}>重试</button>
            )}
            {hasBranch &&
              LANDING.map((op) => (
                <button key={op.key} className={op.key === "discard" ? "danger" : undefined} onClick={() => void land(op)}>
                  {op.label}
                </button>
              ))}
          </div>
          {note && <p className="note">{note}</p>}
        </div>
      )}
    </div>
  );
}

export function TasksPanel({ sessionId, mode, workspace }: {
  sessionId: string | null; mode: string; workspace: string;
}) {
  const [tasks, setTasks] = useState<SubagentTask[]>([]);
  const [role, setRole] = useState<AgentRole>("researcher");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState<"single" | TaskSchedule>("single");
  const [busy, setBusy] = useState(false);

  // 只展示绑定会话的任务;未绑定会话时展示全部(与派发时的 mode/workspace 无关)。
  const refresh = useCallback(
    () => api.tasks({ sessionId: sessionId ?? undefined }).then(setTasks).catch(() => {}),
    [sessionId],
  );
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const submit = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      if (schedule === "single") {
        await api.createTask({ role, prompt, sessionId: sessionId ?? undefined, mode, workspace });
      } else if (schedule === "parallel") {
        // 预设:同主题 researcher + reviewer 并行只读分析
        await api.createTaskGroup({
          schedule: "parallel", sessionId: sessionId ?? undefined, mode, workspace,
          tasks: [
            { role: "researcher", prompt },
            { role: "reviewer", prompt: `审查以下主题的分析角度与潜在遗漏:${prompt}` },
          ],
        });
      } else if (mode === "code") {
        // Code 预设:coder 实现 → tester 测试(失败回传) → reviewer 审查 diff
        await api.createTaskGroup({
          schedule: "pipeline", sessionId: sessionId ?? undefined, mode, workspace,
          tasks: [
            { role: "coder", prompt },
            { role: "tester", prompt: `为以下改动设计并运行测试,失败说明原因回传给 coder:${prompt}` },
            { role: "reviewer", prompt: `用 git.diff 审查以下改动的缺陷与风险:${prompt}` },
          ],
        });
      } else if (mode === "work") {
        // Work 预设:researcher 整理结构化需求/待办/风险(标注来源) → tutor 讲解
        await api.createTaskGroup({
          schedule: "pipeline", sessionId: sessionId ?? undefined, mode, workspace,
          tasks: [
            { role: "researcher", prompt: `把以下资料整理成结构化需求、待办(含截止日期)和风险,每条标注来源:${prompt}` },
            { role: "tutor", prompt: `基于整理结果向用户做要点讲解:${prompt}` },
          ],
        });
      } else {
        // 预设:researcher → tutor 讲解流水线
        await api.createTaskGroup({
          schedule: "pipeline", sessionId: sessionId ?? undefined, mode, workspace,
          tasks: [
            { role: "researcher", prompt },
            { role: "tutor", prompt: `基于调研结果做分步讲解:${prompt}` },
          ],
        });
      }
      setPrompt("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const running = tasks.filter((t) => t.status === "queued" || t.status === "running").length;

  return (
    <div className="tasks-panel">
      <div className="task-form">
        <div className="row">
          <select value={role} onChange={(e) => setRole(e.target.value as AgentRole)} disabled={schedule !== "single"}>
            {(Object.keys(ROLE_LABEL) as AgentRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <select value={schedule} onChange={(e) => setSchedule(e.target.value as "single" | TaskSchedule)}>
            <option value="single">单任务</option>
            <option value="parallel">并行(调研+审查)</option>
            <option value="pipeline">
              {mode === "code" ? "流水线(编码→测试→审查)" : mode === "work" ? "流水线(需求整理→讲解)" : "流水线(调研→讲解)"}
            </option>
          </select>
        </div>
        <textarea rows={2} placeholder="子任务描述" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button className="primary" disabled={busy || !prompt.trim()} onClick={() => void submit()}>
          {busy ? "提交中…" : "派发任务"}
        </button>
      </div>
      {running > 0 && <span style={{ color: "var(--muted)", fontSize: 12 }}>{running} 个任务进行中</span>}
      {tasks.length === 0 && <span style={{ color: "var(--muted)", fontSize: 12 }}>还没有子任务。</span>}
      {tasks.slice(0, 20).map((t) => <TaskCard key={t.id} task={t} onChanged={refresh} />)}
    </div>
  );
}
