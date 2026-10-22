import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { convertToText, isConvertible, MAX_CONVERT_BYTES } from "./convert.ts";

// ---- 最小 fixture 生成:不依赖外部文件,测试自包含 ----

// 最小可用 PDF:一个页面 + 一段文字。页面要够宽,否则超出页宽的文字会被裁掉
function makePdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 900] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// 最小可用 docx:一个 zip,含 word/document.xml
function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const files: Array<[string, string]> = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/document.xml", doc],
  ];
  return zip(files);
}

// 最小 zip 写入器(deflate + 本地头 + 中央目录)
function zip(files: Array<[string, string]>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(body, "utf8");
    const comp = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(8, 6); // flags(bit3:data descriptor)
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

describe("isConvertible", () => {
  it("只认 pdf / docx", () => {
    expect(isConvertible("a.pdf")).toBe(true);
    expect(isConvertible("A.DOCX")).toBe(true);
    expect(isConvertible("a.md")).toBe(false);
    expect(isConvertible("a.txt")).toBe(false);
  });
});

describe("convertToText", () => {
  it("PDF 提取文字", async () => {
    // 超过每页 50 字阈值,不应提示扫描件
    const long = "Hello XiyunAgent. This is a paragraph with more than fifty characters for the threshold check.";
    const r = await convertToText("x.pdf", makePdf(long));
    expect(r.text).toContain("Hello XiyunAgent");
    expect(r.warning).toBeUndefined();
  });

  it("PDF 几乎没有文字时提示可能是扫描件", async () => {
    const r = await convertToText("scan.pdf", makePdf("ab"));
    expect(r.text.length).toBeLessThan(50);
    expect(r.warning).toContain("扫描件");
  });

  it("docx 提取文字", async () => {
    const r = await convertToText("x.docx", makeDocx(["第一段内容", "第二段内容"]));
    expect(r.text).toContain("第一段内容");
    expect(r.text).toContain("第二段内容");
  });

  it("超过 30MB 上限直接报错", async () => {
    const big = Buffer.alloc(MAX_CONVERT_BYTES + 1);
    await expect(convertToText("big.pdf", big)).rejects.toThrow("上限 30MB");
  });

  it("不支持的格式报错", async () => {
    await expect(convertToText("x.txt", Buffer.from("hi"))).rejects.toThrow("不支持的格式");
  });
});
