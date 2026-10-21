// Git diff 文本处理(纯函数,预览面板与 Code 模式变更面板共用):
// 1. 路径匹配:按目标路径从 `git diff HEAD` 输出中挑出对应文件段;
// 2. 结构化解析:把 unified diff 拆成文件 / 行,附带新旧行号与增删统计。

// git 头里的路径有两种形态:普通文本,或 core.quotepath(默认开启)下的双引号包裹 +
// 八进制转义(非 ASCII、控制字符、引号、反斜杠)。只认普通文本会把中文文件名等误判为
// "无改动",所以按目标路径生成两种候选形态逐一比对。
// 引号内:引号/反斜杠等按 C 风格转义,其余不可打印字节按 UTF-8 字节做八进制转义。
const GIT_C_ESCAPES: Record<number, string> = {
  0x07: "\\a", 0x08: "\\b", 0x09: "\\t", 0x0a: "\\n",
  0x0b: "\\v", 0x0c: "\\f", 0x0d: "\\r", 0x22: '\\"', 0x5c: "\\\\",
};

// 引号内的转义内容(不含外层引号):目录前缀匹配需要它,以便拼出 "a/<dir>/ 这样的前缀
export function gitQuoteBody(p: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(p)) {
    const esc = GIT_C_ESCAPES[b];
    if (esc) out += esc;
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\${b.toString(8).padStart(3, "0")}`;
  }
  return out;
}

function gitQuoted(p: string): string {
  return `"${gitQuoteBody(p)}"`;
}

const UNESCAPE: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 0x22, "\\": 0x5c };

// gitQuoted 的逆过程:去引号并把八进制字节还原为 UTF-8 文本;未加引号的原样返回
export function gitUnquote(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 3;
    } else if (body[i + 1] in UNESCAPE) {
      bytes.push(UNESCAPE[body[i + 1]]);
      i += 1;
    } else {
      bytes.push(0x5c);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// 目标路径在 diff 头里的候选形态:
// - heads:本路径作为源文件出现在头行开头(普通/引号两种);后两条带尾空格,兼容 rename 段
//   "a/旧路径 b/新路径" 的旧路径侧。已知残余:文件名自身含 " b" 的极端情况可能靠尾空格
//   误命中,概率极低,不处理。
// - tails:本路径作为目标文件出现在头行末尾(rename 的新路径侧)。
function gitPathVariants(p: string): { heads: string[]; tails: string[] } {
  return {
    heads: [
      `diff --git a/${p} b/${p}`,
      `diff --git ${gitQuoted(`a/${p}`)} ${gitQuoted(`b/${p}`)}`,
      `diff --git a/${p} `,
      `diff --git ${gitQuoted(`a/${p}`)} `,
    ],
    tails: [` b/${p}`, ` ${gitQuoted(`b/${p}`)}`],
  };
}

// 目录在头行里的前缀:未加引号 a/<dir>/ 与加引号 "a/<dir>/。
// 引号形态不补收尾引号——头行是 "a/<dir>/file",目录前缀的 "/" 后面还有文件名。
// 前缀带 "/",避免目录 src 误命中 src2/x。
function dirPrefixes(p: string): string[] {
  return [`diff --git a/${p}/`, `diff --git "a/${gitQuoteBody(`${p}/`)}`];
}

// 归一化为 git 头风格的相对路径:反斜杠转正斜杠,工作区内绝对路径只保留相对部分,
// 去掉 ./ 与前导 /。前端不能引 node:path,这里只做字符串处理。
export function normalizePath(p: string, workspace: string): string {
  let s = p.replace(/\\/g, "/");
  const ws = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  // 与工作区根仅大小写差异地相等时归一化为空串(工作区根,按目录处理)
  if (ws && s.length === ws.length && s.toLowerCase() === ws.toLowerCase()) return "";
  // 按前缀长度切片而非用 lowercase 后的字符串切,避免非 ASCII 大小写折叠改变长度
  if (ws && s.slice(0, ws.length).toLowerCase() === ws.toLowerCase() && s[ws.length] === "/") {
    s = s.slice(ws.length + 1);
  }
  return s.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

// 按 "diff --git " 切段,找头行指向目标路径的段。
// 单文件未命中时,再判断该路径是否是没有尾斜杠的目录(files.list 常给 "src" 这类裸目录名):
// 任一段头行以该目录前缀开头即视为目录,返回 dirFallback,由调用方显示完整 diff。
export function pickDiff(text: string, p: string): { segment: string; dirFallback: boolean } {
  const { heads, tails } = gitPathVariants(p);
  const dirs = dirPrefixes(p);
  let dirFallback = false;
  for (const seg of text.split(/^(?=diff --git )/m)) {
    const nl = seg.indexOf("\n");
    const head = nl < 0 ? seg : seg.slice(0, nl);
    if (heads.some((h) => head.startsWith(h)) || tails.some((t) => head.endsWith(t))) {
      return { segment: seg, dirFallback: false };
    }
    if (!dirFallback && dirs.some((h) => head.startsWith(h))) dirFallback = true;
  }
  return { segment: "", dirFallback };
}

// ---------- 结构化解析 ----------

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "note";
  text: string; // 不含 +/-/空格前缀;hunk 行为完整的 @@ 头
  oldNo?: number;
  newNo?: number;
}

export type DiffFileStatus = "M" | "A" | "D" | "R";

export interface DiffFile {
  path: string; // 新路径(删除时为旧路径)
  oldPath?: string; // 仅 rename
  status: DiffFileStatus;
  binary: boolean;
  adds: number;
  dels: number;
  lines: DiffLine[];
}

// "a/x" / "b/x" / "\"a/中\"" → 去掉 a/ b/ 前缀后的真实路径
function stripSide(raw: string): string {
  const p = gitUnquote(raw.trim());
  return p.replace(/^[ab]\//, "");
}

// diff --git 头行:两侧可能各自加引号;未加引号时以 " b/" 分隔(与 git 自身的歧义一致)
function parseHeadPaths(head: string): { a: string; b: string } {
  const rest = head.replace(/^diff --git /, "");
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|.+)$/.exec(rest);
  if (rest.startsWith('"') || rest.endsWith('"')) {
    if (quoted) return { a: stripSide(quoted[1]), b: stripSide(quoted[2]) };
  }
  const i = rest.indexOf(" b/");
  if (i > 0) return { a: stripSide(rest.slice(0, i)), b: stripSide(rest.slice(i + 1)) };
  return { a: stripSide(rest), b: stripSide(rest) };
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseSegment(seg: string): DiffFile {
  const rows = seg.replace(/\n$/, "").split("\n");
  const file: DiffFile = { path: "", status: "M", binary: false, adds: 0, dels: 0, lines: [] };
  let oldPath = "";
  let newPath = "";
  if (rows[0]?.startsWith("diff --git ")) {
    const h = parseHeadPaths(rows[0]);
    oldPath = h.a;
    newPath = h.b;
  }
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const row of rows) {
    const hunk = HUNK_RE.exec(row);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      file.lines.push({ kind: "hunk", text: row });
      continue;
    }
    if (!inHunk) {
      if (row.startsWith("new file mode")) file.status = "A";
      else if (row.startsWith("deleted file mode")) file.status = "D";
      else if (row.startsWith("rename from ")) {
        file.status = "R";
        oldPath = gitUnquote(row.slice("rename from ".length));
      } else if (row.startsWith("rename to ")) newPath = gitUnquote(row.slice("rename to ".length));
      else if (row.startsWith("Binary files") || row === "GIT binary patch") file.binary = true;
      else if (row.startsWith("--- ") && !row.startsWith("--- /dev/null")) oldPath = stripSide(row.slice(4));
      else if (row.startsWith("+++ ") && !row.startsWith("+++ /dev/null")) newPath = stripSide(row.slice(4));
      continue;
    }
    if (row.startsWith("+")) {
      file.adds++;
      file.lines.push({ kind: "add", text: row.slice(1), newNo: newNo++ });
    } else if (row.startsWith("-")) {
      file.dels++;
      file.lines.push({ kind: "del", text: row.slice(1), oldNo: oldNo++ });
    } else if (row.startsWith("\\")) {
      file.lines.push({ kind: "note", text: row.slice(2) });
    } else {
      file.lines.push({ kind: "ctx", text: row.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  file.path = file.status === "D" ? oldPath || newPath : newPath || oldPath;
  if (file.status === "R" && oldPath && oldPath !== file.path) file.oldPath = oldPath;
  return file;
}

// 解析 unified diff;不含 "diff --git" 头的补丁(如模型给出的片段)作为单个无路径文件处理
export function parseUnifiedDiff(text: string): DiffFile[] {
  if (!text.trim()) return [];
  const segs = text.split(/^(?=diff --git )/m).filter((s) => s.trim());
  return segs.map(parseSegment).filter((f) => f.lines.length > 0 || f.binary || f.path);
}
