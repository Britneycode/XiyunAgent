// 由 index.html 按标签加载的 vendor 脚本(apps/web/public/vendor)
declare const hljs: {
  getLanguage(lang: string): unknown;
  highlight(code: string, opts: { language: string }): { value: string };
};

declare const renderMathInElement: (
  el: HTMLElement,
  opts?: {
    delimiters?: Array<{ left: string; right: string; display: boolean }>;
    throwOnError?: boolean;
  },
) => void;
