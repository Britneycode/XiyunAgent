import { memo, useLayoutEffect, useMemo, useRef } from "react";
import type { Token, TokensList } from "marked";
import { cn } from "../ui/cn.ts";
import { lexBlocks, renderTokens } from "./markdown.ts";

const MATH_DELIMITERS = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "\\(", right: "\\)", display: false },
];

// KaTeX 只处理已定稿的块:流式尾块的公式可能尚未闭合
function typeset(el: HTMLElement) {
  if (typeof renderMathInElement === "undefined") return;
  renderMathInElement(el, { delimiters: MATH_DELIMITERS, throwOnError: false });
}

interface BlockProps {
  token: Token;
  links: TokensList["links"];
  live: boolean;
}

// 单个顶层块。memo 以源码文本为键:历史块的 DOM 不再被触碰,流式时只有尾块重渲染。
const MarkdownBlock = memo(
  function MarkdownBlock({ token, links, live }: BlockProps) {
    const ref = useRef<HTMLDivElement>(null);
    const html = useMemo(() => renderTokens([token], links, live), [token, links, live]);
    useLayoutEffect(() => {
      if (!live && ref.current) typeset(ref.current);
    }, [html, live]);
    return <div ref={ref} className="md-block" dangerouslySetInnerHTML={{ __html: html }} />;
  },
  (a, b) => a.token.raw === b.token.raw && a.live === b.live,
);

// 流式 Markdown:按顶层块切分并逐块缓存,避免整段 innerHTML 重写造成的闪烁与选区丢失。
// streaming 时尾块带输入光标,未闭合代码块以完成态外框渲染,闭合时无布局跳动。
export function StreamingMarkdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  const { tokens, links } = useMemo(() => lexBlocks(text), [text]);
  const last = tokens.length - 1;
  return (
    <div className={cn("md", className)} data-streaming={streaming || undefined}>
      {tokens.map((t, i) => (
        <MarkdownBlock key={i} token={t} links={links} live={streaming && i === last} />
      ))}
    </div>
  );
}
