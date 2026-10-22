import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Todo, WorkDoc } from "@xiyun/shared";
import { assertInside } from "./workspace.ts";
import { ChunkStore } from "./chunks.ts";
import { convertToText, isConvertible } from "./convert.ts";

// ---- 阶段 5:Work 文档导入与来源记录 ----
// 支持 Markdown/TXT/代码文件直读、HTML 标签抽取、网页抓取。
// ponytail: PDF/Office 解析需要新增依赖,暂未支持(见 NOW.md 待办)。

const MAX_DOC = 500 * 1024; // 单文档 500KB 上限
const MAX_REDIRECTS = 5; // 网页导入最多跟随 5 跳
const ALLOWED_PORTS = new Set(["", "80", "443"]); // 空串 = URL 未显式指定端口

// 网页导入 SSRF 防护:拒绝环回、私网、链路本地、未指定地址。
// BlockList 会把 IPv4 映射的 IPv6(::ffff:a.b.c.d)归一成 IPv4 再比对,所以 ::/96 不会误伤映射地址,
// 也不用为 ::ffff:0:0/96 单列条目。
const BLOCKED = new BlockList();
BLOCKED.addSubnet("127.0.0.0", 8, "ipv4"); // 环回
BLOCKED.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED.addSubnet("169.254.0.0", 16, "ipv4"); // 链路本地(含云元数据 169.254.169.254)
BLOCKED.addSubnet("0.0.0.0", 8, "ipv4"); // 未指定 / 本机
BLOCKED.addSubnet("::1", 128, "ipv6");
BLOCKED.addSubnet("fc00::", 7, "ipv6"); // 唯一本地
BLOCKED.addSubnet("fe80::", 10, "ipv6"); // 链路本地
BLOCKED.addSubnet("::", 128, "ipv6");
BLOCKED.addSubnet("::", 96, "ipv6"); // IPv4 兼容地址(::a.b.c.d),可指向 127/10/192.168
BLOCKED.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64,可映射到内网 v4

type Lookup = (host: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>>;

function isBlocked(ip: string): boolean {
  const family = isIP(ip);
  return family === 0 || BLOCKED.check(ip, family === 6 ? "ipv6" : "ipv4");
}

// 校验 URL 指向公网:协议、解析地址、端口依次判定;返回 URL 与已校验的地址列表,
// 后者供连接时钉住(见 httpGet),避免校验与连接之间被 DNS 重绑定绕过。
// 域名走 dns.lookup(解析可注入,便于测试);IP 字面量直接判定。
export async function assertPublicUrl(raw: string, resolve: Lookup = lookup): Promise<{ url: URL; addrs: string[] }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("URL 格式无效");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("仅支持 http/https URL");
  const host = u.hostname.replace(/^\[|\]$/g, ""); // URL 保留 IPv6 方括号
  const addrs = isIP(host) ? [host] : (await resolve(host, { all: true })).map((a) => a.address);
  if (addrs.length === 0) throw new Error(`无法解析主机 ${host}`);
  for (const ip of addrs) if (isBlocked(ip)) throw new Error(`拒绝访问内网地址 ${ip}`);
  if (!ALLOWED_PORTS.has(u.port)) throw new Error(`端口 ${u.port} 不在允许范围(仅 80/443)`);
  return { url: u, addrs };
}

// GET 一跳。lookup 直接返回已校验地址:连接用的就是校验过的 IP,
// 不再二次解析,Host/SNI 仍用原域名(TLS 不受影响)。
function httpGet(u: URL, addrs: string[], signal: AbortSignal): Promise<IncomingMessage> {
  const lookupPinned: LookupFunction = (_host, o, cb) => {
    const list = addrs.map((a) => ({ address: a, family: isIP(a) }));
    if (o.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  };
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        // 不请求压缩:省去解压依赖;UA 与 fetch 时代保持等效,避免站点直接 403。
        headers: { "user-agent": "XiyunAgent", "accept-encoding": "identity" },
        agent: false, // 每跳独立连接,不复用
        signal,
        lookup: lookupPinned,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

// 流式读取响应体,累计超过 MAX_DOC 立即中止(不再读完,也不返回内容)。
async function readCapped(res: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res) {
    const buf = c as Buffer;
    size += buf.byteLength;
    if (size > MAX_DOC) {
      res.destroy();
      throw new Error(`响应过大,超过上限 ${MAX_DOC}B`);
    }
    chunks.push(buf);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// HTML → 纯文本:去 script/style,标签换行,实体只解最常见的几个。
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type DocRow = {
  id: string; title: string; kind: string; source: string; content: string;
  workspace: string; session_id: string | null; created_at: string;
};
type TodoRow = {
  id: string; title: string; status: string; due: string | null; source: string;
  workspace: string; session_id: string | null; created_at: string; done_at: string | null;
};

const toDoc = (r: DocRow): WorkDoc => ({
  id: r.id, title: r.title, kind: r.kind as WorkDoc["kind"], source: r.source,
  content: r.content, workspace: r.workspace, sessionId: r.session_id, createdAt: r.created_at,
});
const toTodo = (r: TodoRow): Todo => ({
  id: r.id, title: r.title, status: r.status as Todo["status"], due: r.due,
  source: r.source, workspace: r.workspace, sessionId: r.session_id,
  createdAt: r.created_at, doneAt: r.done_at,
});

export class WorkStore {
  private db: DatabaseSync;
  private chunks: ChunkStore;
  constructor(db: DatabaseSync) {
    this.db = db;
    this.chunks = new ChunkStore(db);
    // F8:启动时给缺块的老文档补建(可重复执行)
    try {
      this.chunks.backfill();
    } catch {
      // 补建失败不影响启动
    }
  }

  private addDoc(d: { title: string; kind: WorkDoc["kind"]; source: string; content: string; workspace?: string; sessionId?: string }): WorkDoc {
    const id = randomUUID();
    const content = d.content.slice(0, MAX_DOC);
    this.db
      .prepare("INSERT INTO docs (id, title, kind, source, content, workspace, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, d.title, d.kind, d.source, content, d.workspace ?? "", d.sessionId ?? null, new Date().toISOString());
    this.chunks.rebuild(id, content);
    return this.getDoc(id)!;
  }

  // 从工作区文件导入(相对路径,PathGuard 限制);HTML 做标签抽取,PDF / docx 走 convert.ts 转文本。
  async importFile(workspace: string, path: string, sessionId?: string): Promise<WorkDoc & { warning?: string }> {
    const abs = assertInside(workspace, path);
    const raw = readFileSync(abs);
    const isHtml = /\.(html?|htm)$/i.test(path);
    let text: string;
    let warning: string | undefined;
    if (isConvertible(path)) {
      const r = await convertToText(path, raw);
      text = r.text;
      warning = r.warning;
    } else {
      if (raw.length > MAX_DOC) throw new Error(`文件过大(${raw.length}B),上限 ${MAX_DOC}B`);
      text = raw.toString("utf8");
    }
    if (!text.trim()) throw new Error(warning ?? "文件没有可提取的文字");
    const doc = this.addDoc({
      title: path.split(/[\\/]/).pop() ?? path, kind: "file", source: path,
      content: isHtml ? htmlToText(text) : text, workspace, sessionId,
    });
    return warning ? { ...doc, warning } : doc;
  }

  importPaste(title: string, content: string, opts: { workspace?: string; sessionId?: string } = {}): WorkDoc {
    return this.addDoc({ title, kind: "paste", source: "粘贴导入", content, ...opts });
  }

  // F8:拖入的 PDF / Word 转成文本后存为资料(来源记文件名,不写进工作区)
  importConverted(title: string, source: string, content: string, opts: { workspace?: string; sessionId?: string } = {}): WorkDoc {
    return this.addDoc({ title, kind: "file", source, content, ...opts });
  }

  // 网页抓取:记录来源 URL,正文抽取。受控:仅 GET、手动跟随重定向(每跳重新解析并钉住地址)、限大小。
  // 拒绝或超限时在写库前抛出,调用方不会拿到 doc(审计由路由层)。
  async importUrl(url: string, opts: { workspace?: string; sessionId?: string } = {}): Promise<{ doc: WorkDoc; finalUrl: string; bytes: number }> {
    let target = url;
    let res: IncomingMessage | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { url: u, addrs } = await assertPublicUrl(target);
      const r = await httpGet(u, addrs, AbortSignal.timeout(20_000));
      const status = r.statusCode ?? 0;
      if (status < 300 || status >= 400) { res = r; break; }
      const loc = r.headers.location;
      r.destroy();
      if (!loc) { res = r; break; }
      target = new URL(loc, target).toString(); // 相对 Location 按当前跳解析
    }
    if (!res) throw new Error(`重定向次数超过 ${MAX_REDIRECTS}`);
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) { res.destroy(); throw new Error(`抓取失败:HTTP ${status}`); }
    const buf = await readCapped(res);
    const html = new TextDecoder().decode(buf);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || url;
    const doc = this.addDoc({ title, kind: "url", source: url, content: htmlToText(html), ...opts });
    return { doc, finalUrl: target, bytes: buf.byteLength };
  }

  getDoc(id: string): WorkDoc | undefined {
    const r = this.db.prepare("SELECT * FROM docs WHERE id = ?").get(id) as DocRow | undefined;
    return r ? toDoc(r) : undefined;
  }

  // 列表只返回元数据(不带正文),正文用 getDoc 按需加载——大规模工作区下列表响应小一个数量级
  listDocs(workspace?: string): WorkDoc[] {
    const cols = "id, title, kind, source, '' AS content, workspace, session_id, created_at";
    const rows = (workspace
      ? this.db.prepare(`SELECT ${cols} FROM docs WHERE workspace = ? ORDER BY created_at DESC`).all(workspace)
      : this.db.prepare(`SELECT ${cols} FROM docs ORDER BY created_at DESC`).all()) as DocRow[];
    return rows.map(toDoc);
  }

  removeDoc(id: string): void {
    this.chunks.remove(id);
    this.db.prepare("DELETE FROM docs WHERE id = ?").run(id);
  }

  // F8:分块 BM25 检索。查询词 ≥3 字符走 fts5 trigram,更短的退回 LIKE。
  // 返回命中块的原文(不再整篇截断),带块序号与偏移,供 Work 模式注入与前端定位。
  searchDocs(query: string, limit = 3, workspace?: string): Array<WorkDoc & { snippet: string; text: string; ord?: number; start?: number; end?: number }> {
    const q = query.replace(/\s+/g, " ").trim();
    if (!q) return [];
    const hits = this.chunks.search(q, limit, workspace);
    if (!hits.length) return [];
    const out: Array<WorkDoc & { snippet: string; text: string; ord?: number; start?: number; end?: number }> = [];
    for (const h of hits) {
      const doc = this.getDoc(h.docId);
      if (!doc) continue;
      out.push({ ...doc, snippet: h.snippet, text: h.text, ord: h.ord, start: h.start, end: h.end });
    }
    return out;
  }

  // ---- 待办 ----

  addTodo(t: { title: string; due?: string; source?: string; workspace?: string; sessionId?: string }): Todo {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO todos (id, title, due, source, workspace, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, t.title, t.due ?? null, t.source ?? "", t.workspace ?? "", t.sessionId ?? null, new Date().toISOString());
    return this.getTodo(id)!;
  }

  getTodo(id: string): Todo | undefined {
    const r = this.db.prepare("SELECT * FROM todos WHERE id = ?").get(id) as TodoRow | undefined;
    return r ? toTodo(r) : undefined;
  }

  listTodos(workspace?: string, status?: Todo["status"]): Todo[] {
    let sql = "SELECT * FROM todos WHERE 1=1";
    const args: string[] = [];
    if (workspace) { sql += " AND workspace = ?"; args.push(workspace); }
    if (status) { sql += " AND status = ?"; args.push(status); }
    const rows = this.db.prepare(`${sql} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, due IS NULL, due, created_at DESC`).all(...args) as TodoRow[];
    return rows.map(toTodo);
  }

  setTodoStatus(id: string, status: Todo["status"]): void {
    this.db
      .prepare("UPDATE todos SET status = ?, done_at = ? WHERE id = ?")
      .run(status, status === "done" ? new Date().toISOString() : null, id);
  }

  removeTodo(id: string): void {
    this.db.prepare("DELETE FROM todos WHERE id = ?").run(id);
  }
}
