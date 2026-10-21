// 极简 ZIP 读取(M1):只为从 ChatGPT / Claude 的导出 ZIP 里取出 conversations.json。
// 读中央目录定位条目,支持 stored(0)与 deflate(8);解压用浏览器自带的 DecompressionStream。
// 不支持 ZIP64 与加密(导出包用不到)。

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number; // 本地文件头偏移
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

export function listZip(buf: Uint8Array): ZipEntry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error("暂不支持 ZIP64 格式,请解压后选择 conversations.json");
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || v.getUint32(p, true) !== CENTRAL) throw new Error("ZIP 目录已损坏");
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    out.push({
      method: v.getUint16(p + 10, true),
      compressedSize: v.getUint32(p + 20, true),
      size: v.getUint32(p + 24, true),
      offset: v.getUint32(p + 42, true),
      name: dec.decode(buf.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export async function readZipEntry(buf: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint32(e.offset, true) !== LOCAL) throw new Error(`ZIP 条目 ${e.name} 已损坏`);
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data;
  if (e.method !== 8) throw new Error(`不支持的压缩方式(${e.method})`);
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 取出导出包里的 conversations.json:优先层级最浅的那个
export async function conversationsFromZip(buf: Uint8Array): Promise<string> {
  const hits = listZip(buf)
    .filter((e) => /(^|\/)conversations\.json$/i.test(e.name) && !e.name.startsWith("__MACOSX/"))
    .sort((a, b) => a.name.split("/").length - b.name.split("/").length);
  if (!hits.length) throw new Error("ZIP 里没有 conversations.json:请确认是 ChatGPT / Claude 的数据导出包");
  return new TextDecoder().decode(await readZipEntry(buf, hits[0]!));
}

// 设置页用:ZIP 解出 conversations.json,否则按文本读取
export async function readExportFile(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return isZip(buf) ? conversationsFromZip(buf) : new TextDecoder().decode(buf);
}
