import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ClipboardPaste,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Globe,
  Library,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import type { WorkDoc } from "@xiyun/shared";
import type { Preview } from "../chat/blocks.tsx";
import { PathLabel } from "../chat/DiffView.tsx";
import { StreamingMarkdown } from "../chat/StreamingMarkdown.tsx";
import { api, type WorkDocHit } from "../api.ts";
import { cn } from "../ui/cn.ts";
import { Notice, PanelEmpty, PanelHeader, SectionLabel, TextArea, TextInput } from "../ui/panel.tsx";
import { Badge, Button, IconButton } from "../ui/primitives.tsx";

export type ImportMode = "file" | "url" | "paste";

export interface DocsPanelProps {
  workspace: string;
  error: string;
  onDismissError: () => void;
  busy: boolean;
  docs: WorkDoc[];
  doc: WorkDoc | null;
  onOpenDoc: (id: string) => void;
  onCloseDoc: () => void;
  onDeleteDoc: () => void;
  // F8:从检索结果打开文档时,标出命中的块
  focus?: { start: number; end: number } | null;
  files: string[];
  mode: ImportMode;
  onMode: (m: ImportMode) => void;
  importPath: string;
  onImportPath: (v: string) => void;
  onImportFile: (path?: string) => void;
  importUrl: string;
  onImportUrl: (v: string) => void;
  onFetchUrl: () => void;
  pasteTitle: string;
  onPasteTitle: (v: string) => void;
  pasteContent: string;
  onPasteContent: (v: string) => void;
  onSavePaste: () => void;
  onRefresh: () => void;
  onPreview?: (p: Preview) => void;
  onPreviewFile: (path: string) => void;
  // F8:拖入 PDF / Word
  onUploadFile: (file: File) => void;
  // F8:检索命中块(带高亮片段),点击定位到块
  onOpenDocAt?: (id: string, start: number, end: number) => void;
}

const KIND: Record<WorkDoc["kind"], { icon: LucideIcon; label: string }> = {
  file: { icon: FileText, label: "文件" },
  url: { icon: Globe, label: "网页" },
  paste: { icon: ClipboardPaste, label: "粘贴" },
};

const MODES: Array<{ id: ImportMode; label: string; icon: LucideIcon }> = [
  { id: "file", label: "文件", icon: FileText },
  { id: "url", label: "网页", icon: Globe },
  { id: "paste", label: "粘贴", icon: ClipboardPaste },
];

// 列表最多展示的工作目录文件数(过滤后)
const FILE_LIMIT = 100;

// Markdown 来源的资料按 Markdown 渲染,其余保持原文排版
const isMarkdownDoc = (doc: WorkDoc) => /\.(md|markdown|mdx)$/i.test(doc.source) || /\.(md|markdown)$/i.test(doc.title);

function DocDetail({ doc, busy, onBack, onDelete, onPreview, focus }: {
  doc: WorkDoc;
  busy: boolean;
  onBack: () => void;
  onDelete: () => void;
  onPreview?: (p: Preview) => void;
  // F8:从检索结果跳进来时高亮命中的块
  focus?: { start: number; end: number } | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const kind = KIND[doc.kind];
  // 定位到块:非 Markdown 文档直接在正文里标出命中范围
  const marked = focus && !isMarkdownDoc(doc) ? markRange(doc.content, focus.start, focus.end) : null;
  useEffect(() => {
    if (!focus) return;
    const el = bodyRef.current?.querySelector("[data-hit]");
    el?.scrollIntoView({ block: "center" });
  }, [focus, doc.id]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={doc.title}
        meta={<Badge>{kind.label}</Badge>}
        actions={
          <>
            {onPreview && (
              <IconButton
                label="在预览中打开"
                size="xs"
                onClick={() => onPreview({ kind: "artifact", title: doc.title, body: doc.content })}
              >
                <Eye size={13} strokeWidth={1.75} />
              </IconButton>
            )}
            {confirming ? (
              <>
                <Button size="xs" variant="danger" disabled={busy} onClick={onDelete}>
                  确认删除
                </Button>
                <IconButton label="取消" size="xs" onClick={() => setConfirming(false)}>
                  <X size={13} strokeWidth={1.75} />
                </IconButton>
              </>
            ) : (
              <IconButton label="删除资料" size="xs" tone="danger" onClick={() => setConfirming(true)}>
                <Trash2 size={13} strokeWidth={1.75} />
              </IconButton>
            )}
          </>
        }
        className="pl-1.5"
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 mb-2 inline-flex h-6 items-center gap-1 rounded px-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <ArrowLeft size={13} strokeWidth={1.75} aria-hidden />
          返回列表
        </button>
        <p className="mb-3 break-all font-mono text-2xs text-subtle" title={doc.source}>
          来源:
          {doc.kind === "url" && /^https?:/i.test(doc.source) ? (
            <a href={doc.source} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              {doc.source}
            </a>
          ) : (
            doc.source
          )}
        </p>
        <div ref={bodyRef}>
          {isMarkdownDoc(doc) ? (
            <div className="rounded-lg border border-line bg-canvas px-3.5 py-3 font-reading text-fg">
              <StreamingMarkdown text={doc.content} className="text-ui" />
            </div>
          ) : marked ? (
            <div className="whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-3 font-reading text-ui leading-relaxed text-fg">
              {marked.before}
              <mark data-hit className="rounded-sm bg-accent-soft px-px text-accent">
                {marked.hit}
              </mark>
              {marked.after}
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-3 font-reading text-ui leading-relaxed text-fg">
              {doc.content}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 在正文里标出命中范围(越界时退化为整篇)
function markRange(content: string, start: number, end: number) {
  const s = Math.max(0, Math.min(start, content.length));
  const e = Math.max(s, Math.min(end, content.length));
  if (s === e) return { before: content, hit: "", after: "" };
  return { before: content.slice(0, s), hit: content.slice(s, e), after: content.slice(e) };
}

// 服务端用 \u0001 / \u0002 包住命中词;这里拆成文本节点 + <mark>
function Highlight({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("\u0001") ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-px text-accent">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p.replace(/[\u0001\u0002]/g, "")}</span>
        ),
      )}
    </>
  );
}

// Work 模式"资料"面板:导入(文件 / 网页 / 粘贴)、检索、已导入资料、工作目录文件
export function DocsPanel(props: DocsPanelProps) {
  const [filter, setFilter] = useState("");
  // F8:拖入 PDF / Word
  const [dragging, setDragging] = useState(false);
  // F8:文档检索
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<WorkDocHit[] | null>(null);
  const shownFiles = useMemo(() => {
    const qq = filter.trim().toLowerCase();
    return (qq ? props.files.filter((f) => f.toLowerCase().includes(qq)) : props.files).slice(0, FILE_LIMIT);
  }, [props.files, filter]);

  // 检索:输入停顿 250ms 后查询
  useEffect(() => {
    const s = q.trim();
    if (Array.from(s).length < 2) {
      setHits(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api
        .searchDocs(s, props.workspace)
        .then((r) => !stale && setHits(r))
        .catch(() => !stale && setHits([]));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, props.workspace]);

  if (props.doc) {
    return (
      <DocDetail
        doc={props.doc}
        busy={props.busy}
        onBack={props.onCloseDoc}
        onDelete={props.onDeleteDoc}
        onPreview={props.onPreview}
        focus={props.focus}
      />
    );
  }

  const header = (
    <PanelHeader
      icon={Library}
      title="资料"
      meta={props.docs.length > 0 && <Badge>{props.docs.length}</Badge>}
      actions={
        props.workspace && (
          <IconButton label="刷新" size="xs" onClick={props.onRefresh}>
            <RefreshCw size={13} strokeWidth={1.75} />
          </IconButton>
        )
      }
    />
  );

  if (!props.workspace) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <PanelEmpty icon={FolderOpen} title="尚未绑定工作目录" description="在主区顶部填写工作目录后,即可导入文件、抓取网页并管理资料。" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {props.error && (
          <Notice
            tone="err"
            className="mx-3 mt-3"
            action={
              <IconButton label="关闭" size="xs" onClick={props.onDismissError}>
                <X size={12} strokeWidth={1.75} />
              </IconButton>
            }
          >
            {props.error}
          </Notice>
        )}

        {/* F8:拖入 PDF / Word */}
        <section
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) props.onUploadFile(f);
          }}
          className={cn(
            "mx-3 mt-3 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs transition-colors",
            dragging ? "border-accent bg-accent-soft text-accent" : "border-line text-subtle",
          )}
        >
          <Upload size={13} strokeWidth={1.75} aria-hidden />
          <span>把 PDF 或 Word(.docx)拖到这里,自动转成文本存为资料</span>
        </section>

        {/* F8:资料检索 */}
        <section className="flex flex-col gap-1 border-b border-line p-3">
          <label className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-elevated px-2 focus-within:border-accent/60">
            <Search size={12} strokeWidth={1.75} className="text-subtle" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="检索资料内容"
              aria-label="检索资料内容"
              className="h-full min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-subtle"
            />
          </label>
          {hits && (
            <ul className="-mx-1 mt-1 flex flex-col">
              {hits.length === 0 && <li className="px-1.5 py-1 text-2xs text-subtle">没有匹配的资料</li>}
              {hits.map((h, i) => (
                <li key={`${h.docId}-${h.ord}-${i}`}>
                  <button
                    type="button"
                    onClick={() => props.onOpenDocAt?.(h.docId, h.start ?? 0, h.end ?? 0)}
                    className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-surface-2"
                  >
                    <span className="flex w-full items-center gap-1.5 text-2xs text-subtle">
                      <span className="min-w-0 flex-1 truncate font-medium text-muted">{h.title}</span>
                      {h.ord != null && <span className="shrink-0">§{h.ord + 1}</span>}
                    </span>
                    <span className="line-clamp-2 break-words text-xs leading-snug text-muted">
                      <Highlight text={h.snippet} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 导入 */}
        <section className="flex flex-col gap-2 border-b border-line p-3">
          <div role="tablist" aria-label="导入方式" className="flex h-7 items-center gap-0.5 self-start rounded-md bg-surface-2 p-0.5">
            {MODES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={props.mode === id}
                onClick={() => props.onMode(id)}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded px-2 text-xs transition-colors duration-150",
                  props.mode === id ? "bg-elevated text-fg shadow-pill" : "text-muted hover:text-fg",
                )}
              >
                <Icon size={12} strokeWidth={1.75} aria-hidden />
                {label}
              </button>
            ))}
          </div>
          {props.mode === "file" && (
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (props.importPath.trim()) props.onImportFile();
              }}
            >
              <TextInput
                mono
                value={props.importPath}
                onChange={(e) => props.onImportPath(e.target.value)}
                placeholder="相对路径,如 req/spec.md"
                aria-label="导入文件路径"
              />
              <Button type="submit" variant="primary" size="sm" className="h-8" disabled={props.busy || !props.importPath.trim()}>
                导入
              </Button>
            </form>
          )}
          {props.mode === "url" && (
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (props.importUrl.trim()) props.onFetchUrl();
              }}
            >
              <TextInput
                mono
                type="url"
                value={props.importUrl}
                onChange={(e) => props.onImportUrl(e.target.value)}
                placeholder="https://…"
                aria-label="抓取网页 URL"
              />
              <Button type="submit" variant="primary" size="sm" className="h-8" disabled={props.busy || !props.importUrl.trim()}>
                {props.busy ? <LoaderCircle size={13} className="animate-spin" /> : null}
                抓取
              </Button>
            </form>
          )}
          {props.mode === "paste" && (
            <div className="flex flex-col gap-1.5">
              <TextInput value={props.pasteTitle} onChange={(e) => props.onPasteTitle(e.target.value)} placeholder="标题" aria-label="资料标题" />
              <TextArea
                rows={4}
                value={props.pasteContent}
                onChange={(e) => props.onPasteContent(e.target.value)}
                placeholder="粘贴会议纪要 / 需求原文…"
                aria-label="资料内容"
                className="text-xs"
              />
              <Button
                variant="primary"
                size="sm"
                className="self-end"
                disabled={props.busy || !props.pasteContent.trim()}
                onClick={props.onSavePaste}
              >
                保存
              </Button>
            </div>
          )}
        </section>

        {/* 已导入资料 */}
        <section className="flex flex-col gap-1 p-3">
          <SectionLabel meta={<span className="font-mono text-2xs tabular-nums text-subtle">{props.docs.length}</span>}>已导入资料</SectionLabel>
          {props.docs.length === 0 ? (
            <p className="py-2 text-xs text-subtle">还没有资料。导入的内容会保留来源,对话结论可回链。</p>
          ) : (
            <ul className="-mx-1 flex flex-col">
              {props.docs.map((d) => {
                const { icon: Icon } = KIND[d.kind];
                return (
                  <li key={d.id}>
                    {/* 列表项只含元数据,点击查看时按需加载正文 */}
                    <button
                      type="button"
                      onClick={() => props.onOpenDoc(d.id)}
                      title={d.source}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-surface-2"
                    >
                      <Icon size={14} strokeWidth={1.75} className="shrink-0 text-subtle" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui text-fg">{d.title}</span>
                        <span className="block truncate font-mono text-2xs text-subtle">{d.source}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 工作目录文件 */}
        <section className="flex flex-col gap-1 border-t border-line p-3">
          <SectionLabel meta={<span className="font-mono text-2xs tabular-nums text-subtle">{props.files.length}</span>}>工作目录文件</SectionLabel>
          {props.files.length > 8 && (
            <label className="mb-1 flex h-7 items-center gap-1.5 rounded-md border border-line bg-elevated px-2 focus-within:border-accent/60">
              <Search size={12} strokeWidth={1.75} className="text-subtle" aria-hidden />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="筛选文件"
                aria-label="筛选文件"
                className="h-full min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-subtle"
              />
            </label>
          )}
          {shownFiles.length === 0 ? (
            <p className="py-2 text-xs text-subtle">{props.files.length ? "无匹配文件" : "(空)"}</p>
          ) : (
            <ul className="-mx-1 flex flex-col">
              {shownFiles.map((f) => (
                <li key={f} className="group flex h-7 items-center gap-1.5 rounded-md pl-1.5 pr-0.5 transition-colors hover:bg-surface-2">
                  <FileText size={13} strokeWidth={1.75} className="shrink-0 text-subtle" aria-hidden />
                  <button type="button" className="flex min-w-0 flex-1 text-left" onClick={() => props.onPreviewFile(f)} title={`预览 ${f}`}>
                    <PathLabel path={f} />
                  </button>
                  <IconButton
                    label="导入为资料"
                    size="xs"
                    disabled={props.busy}
                    className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => props.onImportFile(f)}
                  >
                    <Download size={12} strokeWidth={1.75} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          {props.files.length > shownFiles.length && shownFiles.length === FILE_LIMIT && (
            <p className="pt-1 text-2xs text-subtle">仅显示前 {FILE_LIMIT} 个,可用筛选缩小范围。</p>
          )}
        </section>
      </div>
    </div>
  );
}
