import { readFileSync } from "node:fs";
import { extname } from "node:path";

// ---- F8:PDF / Word 转文本(D-026)----
// PDF 用 unpdf.extractText,docx 用 mammoth.extractRawText。
// 每页提取文字少于 50 字时视为扫描件(没有文字层),给出提示而不是返回空串。

export const MAX_CONVERT_BYTES = 30 * 1024 * 1024;

export interface ConvertResult {
  text: string;
  warning?: string;
}

// 单页少于此字符数时认为可能是扫描件
const SCANNED_PAGE_CHARS = 50;

export function isConvertible(nameOrPath: string): boolean {
  return /\.(pdf|docx)$/i.test(nameOrPath);
}

export async function convertToText(name: string, buf: Buffer): Promise<ConvertResult> {
  if (buf.length > MAX_CONVERT_BYTES) throw new Error(`文件过大(${buf.length}B),上限 30MB`);
  const ext = extname(name).toLowerCase();
  if (ext === ".pdf") return fromPdf(buf);
  if (ext === ".docx") return fromDocx(buf);
  throw new Error(`不支持的格式:${ext || name}`);
}

async function fromPdf(buf: Buffer): Promise<ConvertResult> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const empty = pages.filter((p) => (p ?? "").trim().length < SCANNED_PAGE_CHARS).length;
  const joined = pages.join("\n\n").trim();
  return {
    text: joined,
    ...(empty > 0
      ? { warning: `${empty}/${totalPages} 页几乎没有文字,可能是扫描件(没有文字层),需要 OCR 才能检索` }
      : {}),
  };
}

async function fromDocx(buf: Buffer): Promise<ConvertResult> {
  const mammoth = await import("mammoth");
  const r = await mammoth.extractRawText({ buffer: buf });
  return { text: (r.value ?? "").trim() };
}

// 从工作区相对路径读取并转换(调用方负责 assertInside)
export async function convertFile(absPath: string): Promise<ConvertResult> {
  return convertToText(absPath, readFileSync(absPath));
}
