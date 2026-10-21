import { useEffect, useMemo, useState } from "react";
import type { ProviderConfig, SessionMeta, WorkDoc } from "@xiyun/shared";
import { api, type RefPayload } from "../api.ts";
import type { UIMessage } from "./useChatStream.ts";

type RefItem = {
  key: string;
  refType: "message" | "doc" | "file";
  label: string;
  excerpt: string;
  detail?: string; // 文档 id 或文件路径
};

const COMMANDS = [
  { name: "new", desc: "新建会话" },
  { name: "export", desc: "导出当前会话为 Markdown" },
  { name: "memory", desc: "从本会话提取记忆候选" },
];

const MAX_CONTEXT = 8000;

function download(name: string, body: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "text/markdown" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function Composer(props: {
  session: SessionMeta;
  busy: boolean;
  editingId: number | null;
  editText: string;
  onEditText: (v: string) => void;
  onCancelEdit: () => void;
  onSubmit: (text: string, o?: { context?: string; refs?: RefPayload[] }) => void;
  onStop: () => void;
  onNewSession?: () => void;
  onCandidatesChanged?: () => void;
  messages: UIMessage[];
}) {
  const [text, setText] = useState("");
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [panel, setPanel] = useState<null | "at" | "slash">(null);
  const [atQuery, setAtQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [docs, setDocs] = useState<WorkDoc[]>([]);
  const [sourceNote, setSourceNote] = useState("");
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof api.providers>>>([]);
  const [activeId, setActiveId] = useState("");
  const [cmdNote, setCmdNote] = useState("");

  const value = props.editingId != null ? props.editText : text;
  const setValue = (v: string) => (props.editingId != null ? props.onEditText(v) : setText(v));

  // `@` 打开时并行拉取文件与文档;失败只减少一类结果
  useEffect(() => {
    if (panel !== "at") return;
    let cancelled = false;
    const ws = props.session.workspace;
    const notes: string[] = [];
    const fileP = ws
      ? api.listFiles(ws).then((r) => !cancelled && setFiles(r.files)).catch(() => {
          notes.push("文件源不可用");
        })
      : Promise.resolve();
    const docP = api.workDocs(ws || undefined).then((d) => !cancelled && setDocs(d)).catch(() => {
      notes.push("文档源不可用");
    });
    void Promise.all([fileP, docP]).then(() => !cancelled && setSourceNote(notes.join(" · ")));
    return () => {
      cancelled = true;
    };
  }, [panel, props.session.workspace]);

  useEffect(() => {
    void api.providers().then((ps) => {
      setProviders(ps);
      // 以服务端 active 为准,刷新后下拉与实际生效的 Provider 保持一致
      setActiveId(ps.find((p) => p.active)?.id ?? ps[0]?.id ?? "");
    }).catch(() => {});
  }, []);

  const atResults = useMemo(() => {
    const q = atQuery.toLowerCase();
    const msgHits = props.messages
      .filter((m) => m.role === "user" && m.content.toLowerCase().includes(q))
      .slice(-5)
      .map((m, i) => ({
        key: `m-${m.id ?? i}`,
        refType: "message" as const,
        label: m.content.slice(0, 20) || "(空消息)",
        excerpt: m.content.slice(0, 200),
      }));
    const fileHits = files
      .filter((f) => f.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({ key: `f-${f}`, refType: "file" as const, label: f, excerpt: f, detail: f }));
    const docHits = docs
      .filter((d) => d.title.toLowerCase().includes(q))
      .slice(0, 8)
      .map((d) => ({ key: `d-${d.id}`, refType: "doc" as const, label: d.title, excerpt: d.content.slice(0, 80), detail: d.id }));
    return [...msgHits, ...fileHits, ...docHits];
  }, [atQuery, files, docs, props.messages]);

  const buildContext = async (): Promise<{ context: string; refs: RefPayload[] }> => {
    const parts: string[] = [];
    const payload: RefPayload[] = [];
    for (const r of refs) {
      let body = r.excerpt;
      if (r.refType === "doc" && r.detail) {
        body = await api.workDoc(r.detail).then((d) => d.content.slice(0, 2000)).catch(() => r.excerpt);
      } else if (r.refType === "file" && r.detail && props.session.workspace) {
        // 提前取出路径:闭包内访问可选属性会丢失收窄
        const path = r.detail;
        body = await api.readFile(props.session.workspace, path).then((d) => d.content.slice(0, 2000)).catch(() => path);
      }
      parts.push(`## ${r.label}\n${body}`);
      payload.push({ refType: r.refType, label: r.label, excerpt: r.excerpt.slice(0, 80) });
    }
    let context = parts.join("\n\n");
    if (context.length > MAX_CONTEXT) {
      context = context.slice(0, MAX_CONTEXT);
      setCmdNote("引用内容过长,已截断");
    }
    return { context, refs: payload };
  };

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || props.busy) return;
    // `/` 命令:只在开头且无引用时生效
    const cmd = /^\/(\w+)\s*$/.exec(trimmed);
    if (cmd && props.editingId == null) {
      const name = cmd[1];
      if (name === "new" && props.onNewSession) {
        setText("");
        props.onNewSession();
        return;
      }
      if (name === "export") {
        setText("");
        download(`${props.session.title}.md`, toMarkdown(props.session.title, props.messages));
        return;
      }
      if (name === "memory") {
        setText("");
        void api.extract(props.session.id)
          .then((r) => {
            setCmdNote(`已提取 ${r.candidates} 条候选`);
            props.onCandidatesChanged?.();
          })
          .catch((e) => setCmdNote(`提取失败:${e instanceof Error ? e.message : e}`));
        return;
      }
    }
    const built = await buildContext();
    setText("");
    setRefs([]);
    props.onSubmit(trimmed, refs.length ? { context: built.context, refs: built.refs } : undefined);
  };

  const switchModel = async (id: string) => {
    setActiveId(id);
    await api.activateProvider(id).catch(() => {});
  };

  return (
    <div className="chat-input-wrap">
      {props.editingId != null && (
        <div className="editing-bar">
          正在编辑消息,发送后将替换该条及其后的对话
          <button type="button" onClick={props.onCancelEdit}>取消编辑</button>
        </div>
      )}
      {refs.length > 0 && (
        <div className="composer-refs">
          {refs.map((r) => (
            <span className="ref-chip mono" key={r.key}>
              @{r.label}
              <button type="button" onClick={() => setRefs(refs.filter((x) => x.key !== r.key))}>×</button>
            </span>
          ))}
        </div>
      )}
      {panel === "at" && (
        <div className="at-panel">
          <input autoFocus placeholder="搜索消息/文件/文档" value={atQuery} onChange={(e) => setAtQuery(e.target.value)} />
          {sourceNote && <div className="panel-note mono">{sourceNote}</div>}
          <div className="at-list">
            {atResults.map((r) => (
              <button
                key={r.key}
                type="button"
                className="at-item"
                onClick={() => {
                  setRefs((prev) => (prev.some((p) => p.key === r.key) ? prev : [...prev, r]));
                  setPanel(null);
                  setAtQuery("");
                }}
              >
                <span className="mono at-type">{r.refType}</span>
                <span className="at-label">{r.label}</span>
              </button>
            ))}
            {atResults.length === 0 && <div className="panel-note">无匹配结果</div>}
          </div>
        </div>
      )}
      {panel === "slash" && (
        <div className="at-panel">
          {COMMANDS.filter((c) => c.name !== "new" || props.onNewSession).map((c) => (
            <button
              key={c.name}
              type="button"
              className="at-item"
              onClick={() => {
                setText(`/${c.name}`);
                setPanel(null);
              }}
            >
              <span className="mono at-type">/{c.name}</span>
              <span className="at-label">{c.desc}</span>
            </button>
          ))}
        </div>
      )}
      <div className="chat-input">
        <textarea
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            setValue(v);
            const lastChar = v.slice(-1);
            if (lastChar === "@") setPanel("at");
            else if (lastChar === "/" && v.trim() === "/") setPanel("slash");
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && panel) {
              e.preventDefault();
              setPanel(null);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !props.busy) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={
            props.editingId != null
              ? "编辑消息,Enter 重新生成"
              : "输入消息,@ 引用上下文,/ 使用命令,Enter 发送"
          }
          disabled={props.busy}
        />
        <div className="composer-bar">
          <button className="icon" type="button" title="引用上下文" onClick={() => setPanel(panel === "at" ? null : "at")}>@</button>
          <button className="icon" type="button" title="命令" onClick={() => setPanel(panel === "slash" ? null : "slash")}>/</button>
          <select
            className="mono"
            title="全局模型"
            value={activeId}
            disabled={props.busy}
            onChange={(e) => void switchModel(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.model}</option>
            ))}
          </select>
          <span className="spacer" />
          {props.busy ? (
            <button className="danger" type="button" onClick={props.onStop}>停止</button>
          ) : (
            <button className="primary" type="button" onClick={() => void submit()}>发送</button>
          )}
        </div>
      </div>
      {cmdNote && <div className="cmd-note mono">{cmdNote}</div>}
    </div>
  );
}

// 导出格式:正文原样;thinking 引用块;tool 单行;ref 引用标记;aborted 标注
function toMarkdown(title: string, messages: UIMessage[]): string {
  const out: string[] = [`# ${title}`, ""];
  for (const m of messages) {
    out.push(`## ${m.role === "user" ? "用户" : "助手"}`, "");
    // 带 refs 的 user 消息 content 存原话、blocks 只有 ref 块,正文必须始终取自 content
    const blocks =
      m.role === "user"
        ? [{ id: "", kind: "text" as const, text: m.content }, ...(m.blocks ?? [])]
        : m.blocks?.length
          ? m.blocks
          : [{ id: "", kind: "text" as const, text: m.content }];
    for (const b of blocks) {
      if (b.kind === "text") out.push(b.text, "");
      else if (b.kind === "ref") out.push(`> @${b.label}`, "");
      else if (b.kind === "thinking") {
        out.push(`> 思考（${((b.durationMs ?? 0) / 1000).toFixed(1)}s）`);
        out.push(...b.text.split("\n").map((l) => `> ${l}`), "");
      } else if (b.kind === "tool") out.push(`\`${b.name}(${b.rawArgs})\``, "");
    }
    if (m.aborted) out.push("（已中断）", "");
  }
  return out.join("\n");
}
