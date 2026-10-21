import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { conversationsFromZip, isZip, listZip, readZipEntry } from "./zip.ts";

// 按 ZIP 规范手工拼一个包(CRC 不校验,填 0)
function buildZip(files: Array<{ name: string; data: string; deflate?: boolean }>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const raw = Buffer.from(f.data);
    const body = f.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(f.deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, cd, end]));
}

describe("ZIP 读取(M1)", () => {
  it("列出条目并解出 stored / deflate 内容(含中文文件名)", async () => {
    const zip = buildZip([
      { name: "说明.txt", data: "你好" },
      { name: "data/big.json", data: JSON.stringify({ x: "y".repeat(5000) }), deflate: true },
    ]);
    expect(isZip(zip)).toBe(true);
    const entries = listZip(zip);
    expect(entries.map((e) => [e.name, e.method])).toEqual([["说明.txt", 0], ["data/big.json", 8]]);
    expect(new TextDecoder().decode(await readZipEntry(zip, entries[0]!))).toBe("你好");
    const big = JSON.parse(new TextDecoder().decode(await readZipEntry(zip, entries[1]!))) as { x: string };
    expect(big.x).toHaveLength(5000);
  });

  it("取层级最浅的 conversations.json;没有时报错;不是 ZIP 时报错", async () => {
    const zip = buildZip([
      { name: "__MACOSX/conversations.json", data: "bad" },
      { name: "export/old/conversations.json", data: "[2]", deflate: true },
      { name: "conversations.json", data: '[{"mapping":{}}]', deflate: true },
      { name: "chat.html", data: "<html>" },
    ]);
    expect(await conversationsFromZip(zip)).toBe('[{"mapping":{}}]');
    await expect(conversationsFromZip(buildZip([{ name: "a.txt", data: "x" }]))).rejects.toThrow("conversations.json");
    expect(() => listZip(new Uint8Array(100))).toThrow("ZIP");
    expect(isZip(new TextEncoder().encode("[]"))).toBe(false);
  });
});
