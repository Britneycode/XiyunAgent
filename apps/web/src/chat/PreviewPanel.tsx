import { useEffect, useState } from "react";
import type { ShellResult } from "@xiyun/shared";
import { api } from "../api.ts";
import { renderMarkdown, splitLines } from "./markdown.ts";
import type { Preview } from "./blocks.tsx";

const MAX_DIFF = 200 * 1024;

// git 头里的路径有两种形态:普通文本,或 core.quotepath(默认开启)下的双引号包裹 +
// 八进制转义(非 ASCII、控制字符、引号、反斜杠)。只认普通文本会把中文文件名等误判为
// "无改动",所以按目标路径生成两种候选形态逐一比对。
// 引号内:引号/反斜杠等按 C 风格转义,其余不可打印字节按 UTF-8 字节做八进制转义。
const GIT_C_ESCAPES: Record<number, string> = {
  0x07: "\\a", 0x08: "\\b", 0x09: "\\t", 0x0a: "\\n",
  0x0b: "\\v", 0x0c: "\\f", 0x0d: "\\r", 0x22: '\\"', 0x5c: "\\\\",
};

function gitQuoted(p: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(p)) {
    const esc = GIT_C_ESCAPES[b];
    if (esc) out += esc;
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\${b.toString(8).padStart(3, "0")}`;
  }
  return `"${out}"`;
}

// 目标路径在 diff 头里的候选形态:同一路径的普通/引号两种头,以及 rename 段
// (a/旧路径 b/新路径)里目标侧出现在头行末尾的情况。
function gitPathVariants(p: string): { heads: string[]; tails: string[] } {
  return {
    heads: [`diff --git a/${p} b/${p}`, `diff --git ${gitQuoted(`a/${p}`)} ${gitQuoted(`b/${p}`)}`],
    tails: [` b/${p}`, ` ${gitQuoted(`b/${p}`)}`],
  };
}

// 归一化为 git 头风格的相对路径:反斜杠转正斜杠,工作区内绝对路径只保留相对部分,
// 去掉 ./ 与前导 /。前端不能引 node:path,这里只做字符串处理。
function normalizePath(p: string, workspace: string): string {
  let s = p.replace(/\\/g, "/");
  const ws = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  // 按前缀长度切片而非用 lowercase 后的字符串切,避免非 ASCII 大小写折叠改变长度
  if (ws && s.slice(0, ws.length).toLowerCase() === ws.toLowerCase() && s[ws.length] === "/") {
    s = s.slice(ws.length + 1);
  }
  return s.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

// 按 "diff --git " 切段,找头行指向目标路径的段;找不到返回空串。
function pickDiffSegment(text: string, p: string): string {
  const { heads, tails } = gitPathVariants(p);
  for (const seg of text.split(/^(?=diff --git )/m)) {
    const nl = seg.indexOf("\n");
    const head = nl < 0 ? seg : seg.slice(0, nl);
    if (heads.some((h) => head.startsWith(h)) || tails.some((t) => head.endsWith(t))) return seg;
  }
  return "";
}

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
  const rel = preview.path ? normalizePath(preview.path, preview.workspace) : "";
  // 工具给的 path 可能是目录(如 files.list 的 "src/" 或 "."):按单文件过滤必然找不到,
  // 此时不过滤,直接显示工作区完整 diff 并说明原因。
  const isDir = rel === "" || rel === "." || rel.endsWith("/");
  if (preview.path && !isDir) {
    text = pickDiffSegment(text, rel);
    if (!text) return <div className="preview-body"><div className="preview-sub mono">未在该工作区的 git diff 中找到此路径的改动（未跟踪文件不在 git diff HEAD 中）</div></div>;
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
      {preview.path && isDir && <div className="preview-sub mono">目录,显示工作区完整 diff</div>}
      {truncated && <div className="preview-sub mono">输出已截断</div>}
      <div className="code-block"><pre className="mono"><code className="hljs" dangerouslySetInnerHTML={{ __html: body }} /></pre></div>
    </div>
  );
}
