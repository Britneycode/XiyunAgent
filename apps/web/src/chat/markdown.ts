import { marked } from "marked";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 语言名白名单:只允许常见标识符字符,防止属性注入
const LANG_RE = /^[\w+#.-]{1,20}$/;

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

const renderer = {
  // 原始 HTML 一律转义,不允许模型注入标签
  html({ text }: { text: string }) {
    return escapeHtml(text);
  },
  code({ text, lang, raw }: { text: string; lang?: string; raw: string }) {
    const fence = /^(```|~~~)/.exec(raw)?.[1] ?? "";
    const trimmed = raw.trimEnd();
    // 流式中最后一个代码块可能还没闭合:只输出转义纯文本,避免半截高亮与行号
    const closed = fence !== "" && trimmed.endsWith(fence) && trimmed.lastIndexOf(fence) > 0;
    if (!closed) return `<pre><code class="hljs">${escapeHtml(text)}</code></pre>`;
    const language = lang && LANG_RE.test(lang) ? lang : "";
    const highlighted =
      language && typeof hljs !== "undefined" && hljs.getLanguage(language)
        ? hljs.highlight(text, { language }).value
        : escapeHtml(text);
    const body = splitLines(highlighted)
      .map((l) => `<span class="line">${l}\n</span>`)
      .join("");
    return (
      `<div class="code-block">` +
      `<div class="code-head"><span class="code-lang">${escapeHtml(language || "text")}</span>` +
      `<button type="button" data-copy>复制</button></div>` +
      `<pre data-lang="${escapeHtml(language)}"><code class="hljs">${body}</code></pre>` +
      `</div>`
    );
  },
};

marked.use({ renderer });

export function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string;
}
