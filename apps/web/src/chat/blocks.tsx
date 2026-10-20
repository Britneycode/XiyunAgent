import { useEffect, useRef, useState } from "react";
import type { ChatBlock } from "@xiyun/shared";
import { renderMarkdown } from "./markdown.ts";

export type Preview =
  | { kind: "artifact"; title: string; body: string; lang?: string }
  | { kind: "tool"; title: string; block: Extract<ChatBlock, { kind: "tool" }> }
  | { kind: "diff"; title: string; workspace: string; path?: string }
  | { kind: "terminal"; title: string; body: string }
  | null;

const secs = (ms?: number) => `${((ms ?? 0) / 1000).toFixed(1)}s`;

export function ThinkingBlock({
  block,
  streaming,
  autoCollapse,
}: {
  block: Extract<ChatBlock, { kind: "thinking" }>;
  streaming: boolean;
  autoCollapse: boolean;
}) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!streaming && autoCollapse) setOpen(false);
  }, [streaming, autoCollapse]);
  return (
    <div className={`think${open ? " open" : ""}`}>
      <button className="think-head" onClick={() => setOpen(!open)} type="button">
        <i className={`pulse${streaming ? "" : " done"}`} />
        <span>{streaming ? "思考中" : "已思考"}</span>
        <span className="mono">{streaming ? "" : secs(block.durationMs)}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="think-body mono">{block.text}</div>}
    </div>
  );
}

export function ToolBlock({
  block,
  onPreview,
}: {
  block: Extract<ChatBlock, { kind: "tool" }>;
  onPreview?: (p: Preview) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = (block.rawArgs || "").slice(0, 60);
  const label = block.status === "error" ? (block.note || "错误") : block.note || "待执行";
  return (
    <div className={`tool ${block.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} type="button">
        <i className={`dot ${block.status}`} />
        <span className="mono tool-name">{block.name}</span>
        <span className="mono tool-args">{summary}</span>
        <span className={`tool-status ${block.status}`}>{label}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="mono tool-label">Arguments</div>
          <pre className="mono">{block.args !== undefined ? JSON.stringify(block.args, null, 2) : block.rawArgs}</pre>
          {block.argsError && <div className="tool-err mono">{block.argsError}</div>}
          {block.target?.workspace && (
            <div className="mono tool-target">
              {block.target.workspace}
              {block.target.path ? ` / ${block.target.path}` : ""}
            </div>
          )}
        </div>
      )}
      {onPreview && (
        <div className="tool-actions">
          <button type="button" onClick={() => onPreview({ kind: "tool", title: block.name, block })}>
            在预览中查看
          </button>
          {block.target?.workspace && (
            <button
              type="button"
              onClick={() =>
                onPreview({
                  kind: "diff",
                  title: block.target?.path ?? "Diff",
                  workspace: block.target!.workspace!,
                  path: block.target?.path,
                })
              }
            >
              查看 Diff
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function RefChips({ refs }: { refs: Array<Extract<ChatBlock, { kind: "ref" }>> }) {
  if (!refs.length) return null;
  return (
    <div className="ref-chips">
      {refs.map((r) => (
        <span className="ref-chip mono" key={r.id} title={r.excerpt}>
          @{r.label}
        </span>
      ))}
    </div>
  );
}

export function MessageBody({
  content,
  blocks,
  streaming,
  onPreview,
  manualOpen,
}: {
  content: string;
  blocks?: ChatBlock[];
  streaming?: boolean;
  onPreview?: (p: Preview) => void;
  manualOpen?: Set<string>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // KaTeX 只处理自己的节点;流式中的消息等完成后执行
  useEffect(() => {
    if (streaming || typeof renderMathInElement === "undefined" || !ref.current) return;
    renderMathInElement(ref.current, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
    });
  }, [content, streaming]);

  if (!blocks?.length) {
    return <div className="msg-body" ref={ref} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
  }

  // 只渲染 text/thinking/tool;ref 块在用户消息上方单独渲染
  return (
    <div className="msg-body blocks">
      {blocks.map((b) => {
        if (b.kind === "thinking")
          return (
            <ThinkingBlock
              key={b.id}
              block={b}
              streaming={!!streaming}
              autoCollapse={!manualOpen?.has(b.id)}
            />
          );
        if (b.kind === "tool") return <ToolBlock key={b.id} block={b} onPreview={onPreview} />;
        if (b.kind === "text")
          return (
            <div
              key={b.id}
              className="block-text"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(b.text) }}
            />
          );
        return null;
      })}
    </div>
  );
}
