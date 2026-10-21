import { describe, expect, it } from "vitest";
import { codeBlockHtml, diffLineKind, lexBlocks, renderCodeLines, renderMarkdown, splitLines } from "./markdown";

describe("代码块渲染", () => {
  it("闭合代码块带操作按钮,流式未闭合时显示生成中且外框一致", () => {
    const done = renderMarkdown("```ts\nconst a = 1;\n```", { live: true });
    expect(done).toContain('class="code-block"');
    expect(done).toContain("data-copy");
    expect(done).not.toContain("code-live");

    const live = renderMarkdown("```ts\nconst a = 1;\n", { live: true });
    expect(live).toContain("is-live");
    expect(live).toContain("生成中");
    expect(live).not.toContain("data-copy");
    // 非流式渲染时,未闭合围栏也按完成态处理
    expect(renderMarkdown("```ts\nconst a = 1;\n")).toContain("data-copy");
  });

  it("超过 20 行显示展开按钮,diff 语言显示增删统计", () => {
    const tall = codeBlockHtml(Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n"), "txt", false);
    expect(tall).toContain("is-tall");
    expect(tall).toContain("data-expand");

    const diff = codeBlockHtml("@@ -1 +1 @@\n-a\n+b\n+c", "diff", false);
    expect(diff).toContain("is-diff");
    expect(diff).toContain("+2");
    expect(diff).toContain("−1");
  });

  it("语言名不合法时退回 text,防止属性注入", () => {
    const html = codeBlockHtml("x", '"><script>', false);
    expect(html).toContain('data-lang=""');
    expect(html).not.toContain("<script>");
  });

  it("逐行切分高亮 HTML 时补齐跨行 span", () => {
    const lines = splitLines('<span class="c">/* a\nb */</span>\nok');
    expect(lines).toEqual(['<span class="c">/* a</span>', '<span class="c">b */</span>', "ok"]);
  });

  it("统计行数并标注 diff 行类型", () => {
    const r = renderCodeLines("+a\n-b\n c", "diff");
    expect(r.count).toBe(3);
    expect(r.adds).toBe(1);
    expect(r.dels).toBe(1);
    expect(diffLineKind("@@ -1 +1 @@")).toBe("hunk");
    expect(diffLineKind("+++ b/x")).toBe("meta");
  });
});

describe("安全过滤", () => {
  it("转义原始 HTML", () => {
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });

  it("危险链接降级为文本,外链新标签打开", () => {
    const bad = renderMarkdown("[点我](javascript:alert(1))");
    expect(bad).not.toContain("<a");
    expect(bad).toContain("点我");
    const ok = renderMarkdown("[官网](https://example.com)");
    expect(ok).toContain('target="_blank"');
    expect(ok).toContain('rel="noopener noreferrer"');
  });

  it("图片只允许 http(s) 与 data:image", () => {
    expect(renderMarkdown("![a](javascript:alert(1))")).not.toContain("<img");
    expect(renderMarkdown("![a](https://example.com/a.png)")).toContain('loading="lazy"');
  });
});

describe("流式分块", () => {
  it("按顶层块切分并忽略空白块", () => {
    const { tokens } = lexBlocks("# 标题\n\n段落\n\n```js\nx\n```\n");
    expect(tokens.map((t) => t.type)).toEqual(["heading", "paragraph", "code"]);
  });
});
