import { ChevronsUpDown, WrapText } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../ui/cn.ts";
import { IconButton } from "../ui/primitives.tsx";
import { CopyButton } from "./blocks.tsx";
import { renderCodeLines } from "./markdown.ts";

// 独立的代码查看器(预览面板):与正文代码块同一套外观,带行号、高亮、换行切换与复制。
// full = 不限高度,由外层容器滚动。
export function CodeView({ code, lang, full = true, className }: { code: string; lang: string; full?: boolean; className?: string }) {
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const r = useMemo(() => renderCodeLines(code, lang.toLowerCase()), [code, lang]);
  return (
    <div
      className={cn(
        "code-block",
        r.diff && "is-diff",
        wrap && "is-wrapped",
        (full || expanded) && "is-expanded",
        className,
      )}
    >
      <div className="code-head">
        <span className="code-lang">{lang || "text"}</span>
        {r.diff ? (
          <span className="code-stat">
            <span className="add">+{r.adds}</span>
            <span className="del">−{r.dels}</span>
          </span>
        ) : (
          <span className="code-meta">{r.count} 行</span>
        )}
        <span className="code-gap" />
        {!full && r.count > 20 && (
          <IconButton label={expanded ? "收起" : "展开全部"} size="xs" onClick={() => setExpanded(!expanded)}>
            <ChevronsUpDown size={13} strokeWidth={1.75} />
          </IconButton>
        )}
        <IconButton label="自动换行" size="xs" active={wrap} onClick={() => setWrap(!wrap)}>
          <WrapText size={13} strokeWidth={1.75} />
        </IconButton>
        <CopyButton text={code} label="复制代码" />
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: r.html }} />
      </pre>
    </div>
  );
}
