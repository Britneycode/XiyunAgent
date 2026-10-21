// 极简 YAML frontmatter 解析,只覆盖规则 / Skill 文件里常见的写法:
// `key: value`、`key: [a, b]`、`key:` 后接 `- item` 列表、`|` / `>` 块标量、缩进续行。
// 嵌套映射(如 metadata:)整体忽略。不引入 YAML 依赖。
export type FrontmatterValue = string | boolean | string[];

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) return t.slice(1, -1);
  return t;
};

const scalar = (v: string): FrontmatterValue => {
  const t = v.trim();
  if (/^(true|yes)$/i.test(t)) return true;
  if (/^(false|no)$/i.test(t)) return false;
  if (t.startsWith("[") && t.endsWith("]"))
    return t.slice(1, -1).split(",").map(unquote).filter(Boolean);
  return unquote(t);
};

export function parseFrontmatter(text: string): { data: Record<string, FrontmatterValue>; body: string } {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, FrontmatterValue> = {};
  const lines = m[1]!.split(/\r?\n/);
  let listKey: string | null = null; // 正在收集 `- item` 的键
  let lastKey: string | null = null; // 最近一个标量键,缩进续行拼到它后面
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*)|$)/.exec(line);
    if (!kv) {
      // 顶层键之外的缩进行:普通续行(属于上一个标量);嵌套映射的子键因 lastKey 为空被丢弃
      if (/^\s/.test(line) && lastKey && typeof data[lastKey] === "string")
        data[lastKey] = `${data[lastKey] as string} ${line.trim()}`.trim();
      continue;
    }
    const key = kv[1]!;
    const value = (kv[2] ?? "").trim();
    listKey = null;
    lastKey = null;
    if (/^[|>][+-]?$/.test(value)) {
      // 块标量:收集后续所有缩进行;| 保留换行,> 折叠为空格
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!.trim());
      data[key] = block.join(value.startsWith("|") ? "\n" : " ").trim();
      continue;
    }
    if (!value) {
      data[key] = [];
      listKey = key;
      continue;
    }
    data[key] = scalar(value);
    if (typeof data[key] === "string") lastKey = key;
  }
  return { data, body: text.slice(m[0].length) };
}

// 字符串或列表统一成去空白的字符串数组;字符串按逗号拆分(Cursor 的 globs 常写成 "a, b")
export function toList(v: FrontmatterValue | undefined): string[] {
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => unquote(s)).filter(Boolean);
  return [];
}

export const toText = (v: FrontmatterValue | undefined): string =>
  typeof v === "string" ? v.trim() : Array.isArray(v) ? v.join(" ").trim() : "";
