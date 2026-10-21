import { marked, type Token, type Tokens, type TokensList } from "marked";

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 语言名白名单:只允许常见标识符字符,防止属性注入
const LANG_RE = /^[\w+#.-]{1,20}$/;
const DIFF_LANGS = new Set(["diff", "patch"]);
// 超过该行数的代码块显示"展开"按钮;正文区代码块统一有最大高度,流式与完成态高度一致
export const CODE_COLLAPSE_LINES = 20;
// 流式中超长代码不做高亮,避免每帧重算
const HIGHLIGHT_LIMIT = 200 * 1024;

// 按行切分已高亮的 HTML,维护 span 栈:行尾补闭合,下一行重开。
// 这样行号用 CSS counter 生成,复制时 textContent 仍是源码。
export function splitLines(html: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let cur = "";
  const pushText = (text: string) => {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        cur += "</span>".repeat(stack.length);
        out.push(cur);
        cur = stack.join("");
      }
      cur += parts[i];
    }
  };
  const re = /<span[^>]*>|<\/span>/g;
  let last = 0;
  for (const m of html.matchAll(re)) {
    pushText(html.slice(last, m.index));
    if (m[0] === "</span>") {
      stack.pop();
      cur += "</span>";
    } else {
      stack.push(m[0]);
      cur += m[0];
    }
    last = m.index! + m[0].length;
  }
  pushText(html.slice(last));
  if (cur) {
    cur += "</span>".repeat(stack.length);
    out.push(cur);
  }
  return out;
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export function diffLineKind(line: string): DiffLineKind {
  if (/^(\+\+\+|---) (a\/|b\/|"|\/dev\/null)/.test(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("@@")) return "hunk";
  if (/^(diff --git |index |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode|Binary files|\\ )/.test(line)) {
    return "meta";
  }
  return "ctx";
}

export const isDiffLang = (lang: string) => DIFF_LANGS.has(lang.toLowerCase());

export interface CodeLines {
  html: string; // 每行一个 span.line,行尾保留换行符
  count: number;
  adds: number;
  dels: number;
  diff: boolean;
}

// 代码 → 逐行 HTML。diff/patch 按行着色并统计增删,其余语言走 highlight.js。
export function renderCodeLines(text: string, lang: string, opts?: { highlight?: boolean }): CodeLines {
  const src = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (isDiffLang(lang)) {
    let adds = 0;
    let dels = 0;
    const rows = src.split("\n");
    const html = rows
      .map((l) => {
        const kind = diffLineKind(l);
        if (kind === "add") adds++;
        else if (kind === "del") dels++;
        return `<span class="line ln-${kind}">${escapeHtml(l)}\n</span>`;
      })
      .join("");
    return { html, count: rows.length, adds, dels, diff: true };
  }
  const canHighlight =
    opts?.highlight !== false &&
    src.length <= HIGHLIGHT_LIMIT &&
    lang !== "" &&
    typeof hljs !== "undefined" &&
    !!hljs.getLanguage(lang);
  const highlighted = canHighlight ? hljs.highlight(src, { language: lang }).value : escapeHtml(src);
  const rows = src === "" ? [""] : splitLines(highlighted);
  return {
    html: rows.map((l) => `<span class="line">${l}\n</span>`).join(""),
    count: rows.length,
    adds: 0,
    dels: 0,
    diff: false,
  };
}

// 内联 SVG(lucide 图标路径):代码块是 HTML 字符串,不能直接用 React 图标组件
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  copy: svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  wrap: svg('<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>'),
  open: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>'),
  expand: svg('<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>'),
};

const button = (attr: string, label: string, body: string) =>
  `<button type="button" class="code-btn" ${attr} title="${label}" aria-label="${label}">${body}</button>`;

// 代码块外框:语言 / 行数(diff 为增删统计)/ 操作。live = 流式中尚未闭合的代码块,
// 外框与完成态一致,只把操作按钮换成"生成中",闭合时不会产生布局跳动。
export function codeBlockHtml(text: string, info: string | undefined, live: boolean): string {
  const first = (info ?? "").match(/^\S*/)?.[0] ?? "";
  const lang = LANG_RE.test(first) ? first : "";
  const r = renderCodeLines(text, lang.toLowerCase(), { highlight: !live || text.length < HIGHLIGHT_LIMIT });
  const tall = r.count > CODE_COLLAPSE_LINES;
  const meta = r.diff
    ? `<span class="code-stat"><span class="add">+${r.adds}</span><span class="del">−${r.dels}</span></span>`
    : `<span class="code-meta">${r.count} 行</span>`;
  const actions = live
    ? `<span class="code-live"><i></i>生成中</span>`
    : (tall ? button(`data-expand aria-expanded="false"`, "展开全部", ICON.expand) : "") +
      button(`data-wrap aria-pressed="false"`, "自动换行", ICON.wrap) +
      button("data-preview", "在预览中打开", ICON.open) +
      `<button type="button" class="code-btn code-copy" data-copy title="复制" aria-label="复制代码">` +
      `<span class="i-copy">${ICON.copy}</span><span class="i-check">${ICON.check}</span>` +
      `<span class="code-copy-label">复制</span><span class="code-copied-label">已复制</span></button>`;
  const cls = ["code-block", r.diff && "is-diff", live && "is-live", tall && "is-tall"].filter(Boolean).join(" ");
  return (
    `<div class="${cls}" data-lang="${escapeHtml(lang)}">` +
    `<div class="code-head"><span class="code-lang">${escapeHtml(lang || "text")}</span>${meta}` +
    `<span class="code-gap"></span>${actions}</div>` +
    `<pre><code class="hljs">${r.html}</code></pre>` +
    (tall && !live
      ? `<div class="code-more"><button type="button" class="code-more-btn" data-expand aria-expanded="false">` +
        `<span class="code-more-label">展开剩余 ${r.count - CODE_COLLAPSE_LINES} 行</span>` +
        `<span class="code-less-label">收起</span></button></div>`
      : "") +
    `</div>`
  );
}

// 允许的链接协议:http(s)/mailto 与页内锚点;其余(javascript:、相对路径等)只保留文本,
// 相对路径在单页应用里点击会离开工作台
const SAFE_HREF = /^(https?:|mailto:|#)/i;
const SAFE_IMG = /^(https?:|data:image\/)/i;

// 渲染状态:由 renderMarkdown 在同步解析期间设置,供 code 渲染器判断是否处于流式尾部
let liveTail = false;

const renderer = {
  // 原始 HTML 一律转义,不允许模型注入标签
  html({ text }: { text: string }) {
    return escapeHtml(text);
  },
  // 图片 alt/title/href 均来自模型可控文本,属性位置一律转义(marked 默认会透传 alt 内的 HTML)
  image({ href, title, text }: { href: string; title: string | null; text: string }) {
    if (!SAFE_IMG.test(href ?? "")) return escapeHtml(text ?? "");
    return (
      `<img src="${escapeHtml(href ?? "")}" alt="${escapeHtml(text ?? "")}" loading="lazy"` +
      (title ? ` title="${escapeHtml(title)}"` : "") +
      `>`
    );
  },
  // 外链一律新标签页打开,避免离开工作台;危险协议降级为纯文本
  link(this: { parser: { parseInline(tokens: Token[]): string } }, { href, title, tokens }: Tokens.Link) {
    const text = this.parser.parseInline(tokens);
    if (!SAFE_HREF.test(href ?? "")) return text;
    const external = /^(https?:|mailto:)/i.test(href);
    return (
      `<a href="${escapeHtml(href)}"` +
      (title ? ` title="${escapeHtml(title)}"` : "") +
      (external ? ` target="_blank" rel="noopener noreferrer"` : "") +
      `>${text}</a>`
    );
  },
  code({ text, lang, raw }: { text: string; lang?: string; raw: string }) {
    const fence = /^[ \t]*(```|~~~)/.exec(raw)?.[1] ?? "";
    const trimmed = raw.trimEnd();
    // 缩进代码块没有围栏,视为已闭合;围栏代码块需出现收尾围栏
    const closed = fence === "" || (trimmed.endsWith(fence) && trimmed.lastIndexOf(fence) > 0);
    return codeBlockHtml(text, lang, !closed && liveTail);
  },
};

marked.use({ renderer: renderer as never });

export function renderMarkdown(src: string, opts?: { live?: boolean }): string {
  liveTail = opts?.live === true;
  try {
    return marked.parse(src, { async: false }) as string;
  } finally {
    liveTail = false;
  }
}

// 流式渲染:按顶层块切分,逐块渲染,只有尾块会随增量变化
export function lexBlocks(src: string): { tokens: Token[]; links: TokensList["links"] } {
  const list = marked.lexer(src);
  return { tokens: list.filter((t) => t.type !== "space"), links: list.links };
}

export function renderTokens(tokens: Token[], links: TokensList["links"], live: boolean): string {
  liveTail = live;
  try {
    return marked.parser(Object.assign([...tokens], { links }) as TokensList);
  } finally {
    liveTail = false;
  }
}
