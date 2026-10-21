// 展示层通用格式化:耗时、错误信息、路径拆分。只做字符串处理,不依赖业务状态。

// 终端/工具耗时:<1s 用毫秒,<60s 保留一位小数,再往上用分秒
export function formatMs(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// 思考计时:始终以秒为单位,流式中按 0.1s 跳动,避免毫秒/秒切换造成宽度抖动
export function formatElapsed(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60_000);
  const s = Math.floor((v % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// api.ts 的 req 失败时抛出 "400: {"error":"..."}";提取服务端给出的可读信息
export function errorMessage(e: unknown, fallback = "未知错误"): string {
  if (typeof e === "string") return e || fallback;
  if (!(e instanceof Error)) return fallback;
  const m = /^(\d{3}):\s*([\s\S]*)$/.exec(e.message);
  if (!m) return e.message || fallback;
  try {
    const body = JSON.parse(m[2]) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // 非 JSON 响应体:原样返回文本
  }
  return m[2].trim() || `HTTP ${m[1]}`;
}

// 路径拆为目录与文件名,用于"目录淡化 + 文件名强调"的展示
export function splitPath(p: string): { dir: string; name: string } {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i < 0 ? { dir: "", name: s } : { dir: s.slice(0, i + 1), name: s.slice(i + 1) };
}

// 由文件扩展名推断代码语言(用于高亮);未知返回空串
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", swift: "swift",
  php: "php", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  md: "markdown", markdown: "markdown", html: "xml", xml: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss", less: "less", sql: "sql", diff: "diff", patch: "diff",
};

export function langFromPath(p: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "";
}
