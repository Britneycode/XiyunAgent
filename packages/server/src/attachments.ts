import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AttachmentKind, AttachmentMeta } from "@xiyun/shared";

// ---- 附件(B2 / D-023)----
// 内容寻址:id = sha256(内容),文件存 <dataDir>/attachments/<id>,同内容只存一份。
// 支持两类:图片(png / jpeg / webp / gif,按文件头识别,不信任声明的类型)发给支持视觉的模型;
// 文本 / 代码文件(UTF-8、无 NUL)正文并入引用上下文。其余类型拒绝。

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_PER_MESSAGE = 8;
export const TEXT_INJECT_CHARS = 20_000; // 单个文本附件并入上下文的上限
export const ID_RE = /^[0-9a-f]{64}$/;

const TEXT_EXT = new Set(
  (
    "txt md markdown mdx rst csv tsv json jsonl yaml yml toml ini cfg conf env log xml html htm css scss less " +
    "js mjs cjs jsx ts tsx vue svelte py rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh fish ps1 bat " +
    "sql graphql proto lua r dart scala clj ex exs erl hs ml tex gradle dockerfile makefile gitignore"
  ).split(" "),
);

export class AttachmentError extends Error {
  readonly status: 400 | 413 | 415;
  constructor(message: string, status: 400 | 413 | 415 = 400) {
    super(message);
    this.status = status;
  }
}

// 按文件头识别图片;不是图片返回 null
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && String.fromCharCode(...b.subarray(0, 4)) === "GIF8") return "image/gif";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP")
    return "image/webp";
  return null;
}

// 文本判定:扩展名 / 声明类型像文本,且能按 UTF-8 严格解码、不含 NUL
export function asText(name: string, mime: string, b: Uint8Array): string | null {
  const ext = extname(name).slice(1).toLowerCase() || name.toLowerCase();
  const looks = TEXT_EXT.has(ext) || mime.startsWith("text/") || /json|xml|yaml|javascript|typescript|csv|markdown/.test(mime);
  if (!looks || b.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

const cleanName = (name: string) =>
  (name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f]/g, "").trim() || "未命名").slice(0, 200);

export class AttachmentStore {
  readonly dir: string;
  private db: DatabaseSync;
  constructor(db: DatabaseSync, dataDir: string) {
    this.db = db;
    this.dir = join(dataDir, "attachments");
  }

  save(name: string, declaredMime: string, bytes: Uint8Array): AttachmentMeta {
    if (!bytes.length) throw new AttachmentError("文件为空");
    const image = sniffImage(bytes);
    let kind: AttachmentKind;
    let mime: string;
    if (image) {
      if (bytes.length > MAX_IMAGE_BYTES) throw new AttachmentError("图片超过 10MB", 413);
      kind = "image";
      mime = image;
    } else {
      if (bytes.length > MAX_TEXT_BYTES) throw new AttachmentError("文本文件超过 1MB", 413);
      if (asText(name, declaredMime, bytes) == null)
        throw new AttachmentError("不支持的附件类型:目前支持图片(PNG / JPEG / WebP / GIF)和文本 / 代码文件", 415);
      kind = "text";
      mime = "text/plain";
    }
    const id = createHash("sha256").update(bytes).digest("hex");
    const meta: AttachmentMeta = { id, name: cleanName(name), mime, size: bytes.length, kind };
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, id);
    if (!existsSync(file)) writeFileSync(file, bytes);
    this.db
      .prepare("INSERT OR IGNORE INTO attachments (id, name, mime, size, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, meta.name, mime, meta.size, kind, new Date().toISOString());
    return meta;
  }

  get(id: string): AttachmentMeta | undefined {
    if (!ID_RE.test(id)) return undefined;
    const r = this.db.prepare("SELECT id, name, mime, size, kind FROM attachments WHERE id = ?").get(id) as
      | AttachmentMeta
      | undefined;
    return r && existsSync(join(this.dir, id)) ? { ...r } : undefined;
  }

  read(id: string): Buffer {
    if (!ID_RE.test(id)) throw new AttachmentError("附件 id 无效");
    return readFileSync(join(this.dir, id));
  }

  text(id: string): string {
    return this.read(id).toString("utf8");
  }

  // 导出:全部仍有文件的附件(含 base64 内容)
  exportAll(): Array<AttachmentMeta & { created_at: string; data: string }> {
    const rows = this.db.prepare("SELECT id, name, mime, size, kind, created_at FROM attachments ORDER BY created_at").all() as unknown as Array<
      AttachmentMeta & { created_at: string }
    >;
    const out: Array<AttachmentMeta & { created_at: string; data: string }> = [];
    for (const r of rows) {
      const file = join(this.dir, r.id);
      if (existsSync(file)) out.push({ ...r, data: readFileSync(file).toString("base64") });
    }
    return out;
  }

  // 导入:内容必须与 id(sha256)一致,类型按内容重新判定;已存在返回 false
  restore(r: Record<string, unknown>): boolean {
    if (typeof r.id !== "string" || !ID_RE.test(r.id) || typeof r.data !== "string") throw new AttachmentError("附件数据无效");
    if (this.get(r.id)) return false;
    const bytes = Buffer.from(r.data, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== r.id) throw new AttachmentError(`附件 ${r.id.slice(0, 8)} 内容校验失败`);
    const meta = this.save(String(r.name ?? "附件"), String(r.mime ?? ""), bytes);
    if (typeof r.created_at === "string") this.db.prepare("UPDATE attachments SET created_at = ? WHERE id = ?").run(r.created_at, meta.id);
    return true;
  }

  // 清理没有被任何消息引用的附件;ids 缺省时检查 olderThanMs 之前上传的全部附件(上传了但没发送)
  prune(opts: { ids?: string[]; olderThanMs?: number } = {}): number {
    const rows = opts.ids
      ? opts.ids.filter((id) => ID_RE.test(id)).map((id) => ({ id }))
      : (this.db
          .prepare("SELECT id FROM attachments WHERE created_at < ?")
          .all(new Date(Date.now() - (opts.olderThanMs ?? 86_400_000)).toISOString()) as Array<{ id: string }>);
    const used = this.db.prepare("SELECT 1 FROM messages WHERE blocks LIKE ? LIMIT 1");
    let n = 0;
    for (const { id } of rows) {
      if (used.get(`%"attachmentId":"${id}"%`)) continue;
      this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
      rmSync(join(this.dir, id), { force: true });
      n++;
    }
    return n;
  }
}
