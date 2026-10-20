import { useEffect, useState } from "react";
import type { ShellResult } from "@xiyun/shared";
import { api } from "../api.ts";
import { renderMarkdown, splitLines } from "./markdown.ts";
import type { Preview } from "./blocks.tsx";

const MAX_DIFF = 200 * 1024;

export function PreviewPanel({ preview }: { preview: Preview }) {
  const [diff, setDiff] = useState<ShellResult | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setDiff(null);
    setErr("");
    if (preview?.kind !== "diff") return;
    void api.gitDiff(preview.workspace)
      .then((r) => setDiff(r))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [preview]);

  if (!preview) {
    return <div className="preview-empty">点击工具卡片或代码块查看详情</div>;
  }

  if (preview.kind === "tool") {
    const b = preview.block;
    return (
      <div className="preview-body">
        <div className="preview-title mono">{b.name}</div>
        <div className="preview-sub mono">{b.status}{b.note ? ` · ${b.note}` : ""}</div>
        <pre className="mono">{b.args !== undefined ? JSON.stringify(b.args, null, 2) : b.rawArgs}</pre>
        {b.argsError && <div className="msg-error mono">{b.argsError}</div>}
        {b.target?.workspace && <div className="preview-sub mono">{b.target.workspace}{b.target.path ? ` / ${b.target.path}` : ""}</div>}
      </div>
    );
  }

  if (preview.kind === "terminal") {
    return <div className="preview-body"><pre className="preview-diff mono">{preview.body}</pre></div>;
  }

  if (preview.kind === "artifact") {
    return (
      <div className="preview-body">
        <div className="preview-title">{preview.title}</div>
        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.body) }} />
      </div>
    );
  }

  // diff
  if (err) return <div className="preview-body"><div className="msg-error mono">{err}</div></div>;
  if (!diff) return <div className="preview-empty">读取中…</div>;
  if (diff.exitCode !== 0) {
    return <div className="preview-body"><div className="msg-error mono">{diff.stderr || "git diff 失败"}</div></div>;
  }
  let text = diff.stdout || "";
  if (preview.path) {
    const segs = text.split(/^(?=diff --git )/m);
    const hit = segs.find((s) => s.startsWith(`diff --git a/${preview.path} `) || s.includes(` b/${preview.path}\n`));
    text = hit ?? "";
    if (!text) return <div className="preview-body"><div className="preview-sub mono">该文件无改动（未跟踪文件不在 git diff HEAD 中）</div></div>;
  }
  const truncated = text.length >= MAX_DIFF;
  if (truncated) text = text.slice(0, MAX_DIFF);
  const highlighted = text
    ? typeof hljs !== "undefined" && hljs.getLanguage("diff")
      ? hljs.highlight(text, { language: "diff" }).value
      : text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : "";
  const body = splitLines(highlighted).map((l) => `<span class="line">${l}\n</span>`).join("");
  return (
    <div className="preview-body">
      <div className="preview-title mono">{preview.title}</div>
      {truncated && <div className="preview-sub mono">输出已截断</div>}
      <div className="code-block"><pre className="mono"><code className="hljs" dangerouslySetInnerHTML={{ __html: body }} /></pre></div>
    </div>
  );
}
