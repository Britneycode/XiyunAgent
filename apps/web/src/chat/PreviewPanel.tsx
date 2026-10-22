import { useEffect, useMemo, useState } from "react";
import { Eye, FileCode2, GitCompareArrows, RefreshCw, SquareTerminal, Wrench, WrapText } from "lucide-react";
import type { ShellResult } from "@xiyun/shared";
import { api } from "../api.ts";
import { errorMessage } from "../ui/format.ts";
import { Notice, PanelEmpty, PanelHeader, SectionLabel } from "../ui/panel.tsx";
import { Badge, Button, IconButton, Skeleton } from "../ui/primitives.tsx";
import { CopyButton, type Preview } from "./blocks.tsx";
import { CodeView } from "./CodeView.tsx";
import { DiffFileCard, DiffStat, useDiffTotals } from "./DiffView.tsx";
import { normalizePath, parseUnifiedDiff, pickDiff } from "./gitDiff.ts";
import { StreamingMarkdown } from "./StreamingMarkdown.tsx";

const MAX_DIFF = 200 * 1024;

type ToolPreview = Extract<NonNullable<Preview>, { kind: "tool" }>;
type DiffPreview = Extract<NonNullable<Preview>, { kind: "diff" }>;

const TOOL_STATUS: Record<ToolPreview["block"]["status"], { label: string; tone: "neutral" | "ok" | "err" }> = {
  pending: { label: "待执行", tone: "neutral" },
  awaiting: { label: "待确认", tone: "neutral" },
  running: { label: "运行中", tone: "neutral" },
  success: { label: "成功", tone: "ok" },
  error: { label: "错误", tone: "err" },
  rejected: { label: "已拒绝", tone: "neutral" },
};

function ToolDetail({ preview, onPreview }: { preview: ToolPreview; onPreview?: (p: Preview) => void }) {
  const b = preview.block;
  const status = TOOL_STATUS[b.status];
  const parsed = b.args !== undefined;
  const text = parsed ? JSON.stringify(b.args, null, 2) : b.rawArgs;
  const target = b.target;
  return (
    <>
      <PanelHeader
        icon={Wrench}
        title={<span className="font-mono">{b.name}</span>}
        meta={<Badge tone={status.tone}>{b.note || status.label}</Badge>}
      />
      <div className="flex flex-col gap-4 p-3">
        <section className="flex flex-col gap-1.5">
          <SectionLabel>{parsed ? "参数" : "原始参数"}</SectionLabel>
          {text ? <CodeView code={text} lang={parsed ? "json" : "text"} /> : <p className="text-xs text-subtle">(无参数)</p>}
        </section>
        {b.argsError && <Notice tone="err">参数解析失败:{b.argsError}</Notice>}
        {target?.workspace && (
          <section className="flex flex-col gap-1.5">
            <SectionLabel>目标</SectionLabel>
            <div className="rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs">
              <p className="break-all text-muted">{target.workspace}</p>
              {target.path && <p className="mt-0.5 break-all text-fg">{target.path}</p>}
            </div>
            {onPreview && (
              <Button
                size="sm"
                className="self-start"
                onClick={() =>
                  onPreview({ kind: "diff", title: target.path ?? "工作区 Diff", workspace: target.workspace!, path: target.path })
                }
              >
                <GitCompareArrows size={13} strokeWidth={1.75} />
                查看 Diff
              </Button>
            )}
          </section>
        )}
        {b.status === "pending" && <Notice>模型请求调用该工具;当前版本不会自动执行。</Notice>}
      </div>
    </>
  );
}

function DiffDetail({ preview }: { preview: DiffPreview }) {
  const [diff, setDiff] = useState<ShellResult | null>(null);
  const [err, setErr] = useState("");
  const [wrap, setWrap] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setErr("");
    void api
      .gitDiff(preview.workspace)
      .then((r) => alive && setDiff(r))
      .catch((e) => alive && setErr(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [preview, nonce]);

  // 工具给的 path 可能是目录(如 files.list 的 "src/" 或 "."):按单文件过滤必然找不到,
  // 此时不过滤,直接显示工作区完整 diff 并说明原因。
  // 无尾斜杠的裸目录名("src")先按单文件试,未命中再看是否作为目录前缀出现在头行。
  const view = useMemo(() => {
    if (!diff || diff.exitCode !== 0) return null;
    let text = diff.stdout || "";
    const rel = preview.path ? normalizePath(preview.path, preview.workspace) : "";
    let isDir = rel === "" || rel === "." || rel.endsWith("/");
    if (preview.path && !isDir) {
      const hit = pickDiff(text, rel);
      if (hit.segment) text = hit.segment;
      else if (hit.dirFallback) isDir = true;
      else return { missing: true as const };
    }
    const truncated = text.length >= MAX_DIFF;
    if (truncated) text = text.slice(0, MAX_DIFF);
    return { missing: false as const, files: parseUnifiedDiff(text), truncated, isDir };
  }, [diff, preview]);

  const files = view && !view.missing ? view.files : [];
  const totals = useDiffTotals(files);

  return (
    <>
      <PanelHeader
        icon={GitCompareArrows}
        title={<span className="font-mono">{preview.title}</span>}
        meta={files.length > 0 && <DiffStat adds={totals.adds} dels={totals.dels} />}
        actions={
          <>
            <IconButton label="自动换行" size="xs" active={wrap} onClick={() => setWrap(!wrap)}>
              <WrapText size={13} strokeWidth={1.75} />
            </IconButton>
            <IconButton label="刷新" size="xs" onClick={() => setNonce((n) => n + 1)}>
              <RefreshCw size={13} strokeWidth={1.75} />
            </IconButton>
          </>
        }
      />
      <div className="flex flex-col gap-2 p-3">
        {err ? (
          <Notice tone="err">{err}</Notice>
        ) : !diff ? (
          <div className="flex flex-col gap-2" aria-label="读取中">
            <Skeleton className="h-9" />
            <Skeleton className="h-40" />
          </div>
        ) : diff.exitCode !== 0 ? (
          <Notice tone="err">{diff.stderr || "git diff 失败"}</Notice>
        ) : view?.missing ? (
          <Notice>未在该工作区的 git diff 中找到此路径的改动(未跟踪文件不在 git diff HEAD 中)。</Notice>
        ) : (
          <>
            {preview.path && view?.isDir && <Notice>目录路径,显示工作区完整 diff。</Notice>}
            {view?.truncated && <Notice tone="warn">输出超过 200 KB,已截断。</Notice>}
            {files.length === 0 ? (
              <PanelEmpty icon={GitCompareArrows} title="没有未提交的改动" description={preview.workspace} />
            ) : (
              files.map((f, i) => <DiffFileCard key={`${f.path}-${i}`} file={f} wrap={wrap} defaultOpen={files.length <= 8} />)
            )}
          </>
        )}
      </div>
    </>
  );
}

// 检查器"预览"页:工具调用详情、代码 / 文档、终端输出与 Git Diff
export function PreviewPanel({ preview, onPreview }: { preview: Preview; onPreview?: (p: Preview) => void }) {
  if (!preview) {
    return (
      <PanelEmpty
        icon={Eye}
        title="暂无预览"
        description="点击工具卡片的「在预览中查看」或代码块的「在预览中打开」,内容会显示在这里。"
        className="py-16"
      />
    );
  }

  if (preview.kind === "tool") return <ToolDetail preview={preview} onPreview={onPreview} />;

  if (preview.kind === "diff") return <DiffDetail key={`${preview.workspace}|${preview.path ?? ""}`} preview={preview} />;

  if (preview.kind === "terminal") {
    return (
      <>
        <PanelHeader icon={SquareTerminal} title={preview.title} actions={<CopyButton text={preview.body} label="复制输出" />} />
        <pre className="m-3 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-code p-3 font-mono text-xs leading-relaxed text-code-fg">
          {preview.body}
        </pre>
      </>
    );
  }

  // artifact:带语言的按代码查看,否则按 Markdown 文档渲染
  return (
    <>
      <PanelHeader
        icon={FileCode2}
        title={<span className={preview.lang ? "font-mono" : undefined}>{preview.title}</span>}
        actions={!preview.lang ? <CopyButton text={preview.body} /> : undefined}
      />
      <div className="p-3">
        {preview.lang ? (
          <CodeView code={preview.body} lang={preview.lang} />
        ) : (
          <StreamingMarkdown text={preview.body} className="font-reading" />
        )}
      </div>
    </>
  );
}
