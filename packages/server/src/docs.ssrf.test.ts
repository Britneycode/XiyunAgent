import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertPublicUrl, WorkStore } from "./docs.ts";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";

// ---- 测试替身:网络层全部可控,任何真实外网请求都会显式失败 ----
const net = vi.hoisted(() => ({
  // guard: 拒绝一切真实请求(默认);rewrite: 改写连接目标;fake: 返回构造的流;
  // probe: 走真实 socket,但包一层实现的 lookup 观察其返回值,并把连接导向 redirectTo
  mode: "guard" as "guard" | "rewrite" | "fake" | "probe",
  rewriteTo: null as null | { hostname?: string; port: number },
  redirectTo: null as null | { hostname: string; port: number },
  fake: null as null | ((opts: Record<string, unknown>, cb: (res: IncomingMessage) => void) => unknown),
  captured: [] as Array<Record<string, unknown>>,
  lookupSeen: [] as Array<{ host: string; addrs: unknown }>,
  dns: null as null | ((host: string) => Array<{ address: string; family: number }>),
  dnsCalls: [] as string[],
}));

vi.mock("node:http", async (io) => {
  const actual = await io<typeof import("node:http")>();
  return {
    ...actual,
    request: (opts: Record<string, unknown>, cb: (res: IncomingMessage) => void) => {
      net.captured.push(opts);
      if (net.mode === "guard") throw new Error(`测试不应发起真实网络请求: ${String(opts.hostname)}`);
      if (net.mode === "fake") return net.fake!(opts, cb);
      if (net.mode === "probe") {
        // 保留 hostname(这样 Node 才会调用 lookup)与实现的 lookup(被测的钉住逻辑);
        // 记录实现 lookup 的返回值,再把地址替换成本地靶子,使连接真的能建立。
        const impl = opts.lookup as ((h: string, o: unknown, cb: (e: null, a: unknown) => void) => void) | undefined;
        if (!impl) throw new Error("实现没有向连接传入 lookup,无法钉住地址");
        const toLocal = (addrs: unknown) =>
          Array.isArray(addrs) ? addrs.map(() => ({ address: "127.0.0.1", family: 4 })) : "127.0.0.1";
        return (actual.request as (o: unknown, c: unknown) => unknown)(
          {
            ...opts,
            port: net.redirectTo!.port,
            lookup: (h: string, o: unknown, cb: (e: null, a: unknown) => void) =>
              impl(h, o, (err, addrs) => { net.lookupSeen.push({ host: h, addrs }); cb(err, toLocal(addrs)); }),
          },
          cb,
        );
      }
      // 只替换连接目标,其余选项(hostname/lookup/headers)原样透传。
      return (actual.request as (o: unknown, c: unknown) => unknown)({ ...opts, ...net.rewriteTo }, cb);
    },
  };
});

// 默认解析器直接报错:测试不依赖真实 DNS。
vi.mock("node:dns/promises", async (io) => {
  const actual = await io<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: (host: string) => {
      net.dnsCalls.push(host);
      if (!net.dns) throw new Error(`测试不应做真实 DNS 解析: ${host}`);
      return Promise.resolve(net.dns(host));
    },
  };
});

// 每个测试自建本地服务器,避免用例间共享 handler 互相干扰。
const servers: Server[] = [];
async function startServer(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  net.mode = "guard";
  net.rewriteTo = null;
  net.redirectTo = null;
  net.fake = null;
  net.captured = [];
  net.lookupSeen = [];
  net.dns = null;
  net.dnsCalls = [];
});

function setup() {
  // 用完整 schema(含 F8 分块表),WorkStore 导入文档时要写块
  return new WorkStore(openDb(":memory:"));
}

// 假解析器:不依赖真实 DNS,也保证测试不发起外网请求。
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const loopbackLookup = async () => [{ address: "127.0.0.1", family: 4 }];

describe("assertPublicUrl", () => {
  it("放行公网 IP 与未指定/80/443 端口,并回传已校验地址", async () => {
    await expect(assertPublicUrl("http://93.184.216.34/", publicLookup)).resolves.toMatchObject({ addrs: ["93.184.216.34"] });
    await expect(assertPublicUrl("https://93.184.216.34/a/b", publicLookup)).resolves.toMatchObject({ addrs: ["93.184.216.34"] });
    await expect(assertPublicUrl("http://example.com:80/", publicLookup)).resolves.toBeTruthy();
    await expect(assertPublicUrl("https://example.com:443/", publicLookup)).resolves.toBeTruthy();
  });

  it("拒绝环回、私网、链路本地、未指定地址与 IPv4 映射的 IPv6", async () => {
    const blocked = [
      "http://127.0.0.1/", "http://127.1.2.3/", "http://10.1.2.3/", "http://172.16.0.1/", "http://192.168.1.1/",
      "http://169.254.169.254/", "http://0.0.0.0/",
      "http://[::1]/", "http://[::]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/",
    ];
    for (const url of blocked) await expect(assertPublicUrl(url, publicLookup)).rejects.toThrow("内网地址");
  });

  it("拒绝 IPv4 兼容地址与 NAT64 映射,但不误伤公网映射地址", async () => {
    // ::a.b.c.d(IPv4 兼容)与 64:ff9b::/96(NAT64)都能指到内网
    for (const url of ["http://[::127.0.0.1]/", "http://[::7f00:1]/", "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::c0a8:101]/"]) {
      await expect(assertPublicUrl(url, publicLookup)).rejects.toThrow("内网地址");
    }
    // ::ffff:0:0/96 是 IPv4 映射,BlockList 会归一成 IPv4 比对:公网映射地址必须仍然放行
    for (const url of ["http://[::ffff:8.8.8.8]/", "http://[2606:4700::1111]/"]) {
      await expect(assertPublicUrl(url, publicLookup)).resolves.toBeTruthy();
    }
  });

  it("域名解析结果落在内网时拒绝,任一地址命中即拒绝", async () => {
    for (const url of ["http://localhost/", "http://intranet.test/"]) {
      await expect(assertPublicUrl(url, loopbackLookup)).rejects.toThrow("内网地址");
    }
    const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
    await expect(assertPublicUrl("http://mixed.test/", mixed)).rejects.toThrow("内网地址");
  });

  it("拒绝非 http(s) 协议与非标端口", async () => {
    for (const url of ["ftp://example.com/", "file:///etc/passwd", "ws://example.com/"]) {
      await expect(assertPublicUrl(url, publicLookup)).rejects.toThrow();
    }
    for (const url of ["http://example.com:8080/", "https://example.com:8443/", "http://example.com:22/"]) {
      await expect(assertPublicUrl(url, publicLookup)).rejects.toThrow("端口");
    }
    await expect(assertPublicUrl("不是 URL", publicLookup)).rejects.toThrow("URL 格式无效");
  });
});

// 被拒的 URL 一律指向本地靶子:断言既不写库,也没有真的连上去。
describe("importUrl 拒绝本地靶子", () => {
  it("直接导入环回地址被拒(命中地址规则,而非端口规则),不写库也不发请求", async () => {
    let hits = 0;
    const { port } = await startServer((_q, res) => { hits++; res.writeHead(200); res.end("ok"); });
    const store = setup();
    await expect(store.importUrl(`http://127.0.0.1:${port}/`)).rejects.toThrow("内网地址");
    expect(store.listDocs()).toHaveLength(0);
    expect(hits).toBe(0);
    expect(net.captured).toHaveLength(0);
  });

  it("302 重定向到环回地址被拒,不写库也不发请求", async () => {
    let hits = 0;
    const { port } = await startServer((_q, res) => { hits++; res.writeHead(200); res.end("ok"); });
    const store = setup();
    // 首跳改写到本地靶子(校验阶段用的是公网地址,能通过);Location 指向环回:第二跳必须被拒。
    net.mode = "rewrite";
    net.rewriteTo = { hostname: "127.0.0.1", port };
    net.fake = (_opts, cb) => {
      const fake = Readable.from([Buffer.from("")]) as unknown as IncomingMessage;
      fake.statusCode = 302;
      fake.headers = { location: `http://127.0.0.1:${port}/` };
      queueMicrotask(() => cb(fake));
      return { on() { return this; }, end() {} };
    };
    net.mode = "fake";
    await expect(store.importUrl("http://93.184.216.34/start")).rejects.toThrow("内网地址");
    expect(store.listDocs()).toHaveLength(0);
    expect(hits).toBe(0);
  });
});

// 打桩网络层:外网不可达,但保留真实的流式读取与连接选项。
describe("importUrl 重定向、上限与地址钉住", () => {
  const html = (body = "正文") => `<html><title>标题</title><body>${body}</body></html>`;

  // 把公网目标改写到本地靶子:保持 http.request 的真实行为,又不产生外网流量。
  const toLocal = (port: number) => { net.mode = "rewrite"; net.rewriteTo = { hostname: "127.0.0.1", port }; };

  it("重定向每一跳都重新校验并拒绝内网跳", async () => {
    const { port } = await startServer((_q, res) => {
      res.writeHead(302, { location: "http://127.0.0.1/secret" });
      res.end();
    });
    const store = setup();
    toLocal(port);
    await expect(store.importUrl("http://93.184.216.34/start")).rejects.toThrow("内网地址");
    expect(net.captured).toHaveLength(1); // 第二跳在校验阶段就被拦下,没有发出
    expect(store.listDocs()).toHaveLength(0);
  });

  it("相对 Location 按当前跳解析,成功返回 { doc, finalUrl, bytes }", async () => {
    const { port } = await startServer((req, res) => {
      if (req.url === "/start") { res.writeHead(302, { location: "/next" }); return res.end(); }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html());
    });
    const store = setup();
    toLocal(port);
    const r = await store.importUrl("http://93.184.216.34/start", { workspace: "w1", sessionId: "s1" });
    expect(r.finalUrl).toBe("http://93.184.216.34/next");
    expect(r.doc.title).toBe("标题");
    expect(r.doc.content).toContain("正文");
    expect(r.doc.kind).toBe("url");
    expect(r.doc.source).toBe("http://93.184.216.34/start");
    expect(r.bytes).toBeGreaterThan(0);
    expect(store.listDocs("w1")).toHaveLength(1);
  });

  it("钉住地址但不改 Host:hostname 仍为原域名", async () => {
    const { port } = await startServer((_q, res) => { res.writeHead(200); res.end(html()); });
    const store = setup();
    toLocal(port);
    await store.importUrl("http://93.184.216.34/ok");
    // 钉住只替换 DNS 结果,hostname/Host 保持原样(HTTPS 的 SNI 同理不受影响)。
    expect(net.captured[0].hostname).toBe("93.184.216.34");
  });

  it("重定向超过 5 跳中止", async () => {
    const { port } = await startServer((_q, res) => { res.writeHead(302, { location: "/loop" }); res.end(); });
    const store = setup();
    toLocal(port);
    await expect(store.importUrl("http://93.184.216.34/loop")).rejects.toThrow("重定向次数");
    expect(net.captured).toHaveLength(6); // 首跳 + 5 跳
    expect(store.listDocs()).toHaveLength(0);
  });

  it("响应体超过上限不写库", async () => {
    const { port } = await startServer((_q, res) => { res.writeHead(200); res.end("x".repeat(600 * 1024)); });
    const store = setup();
    toLocal(port);
    await expect(store.importUrl("http://93.184.216.34/big")).rejects.toThrow("响应过大");
    expect(store.listDocs()).toHaveLength(0);
  });

  it("超过上限立即中止读取,不等响应体发完", async () => {
    const store = setup();
    let produced = 0;
    let cancelled = false;
    net.mode = "fake";
    net.fake = (_opts, cb) => {
      // 有限但远超上限:回归时读取会读完 40 块而抛不出「响应过大」,断言随即失败,
      // 不会像无界流那样把测试进程拖死。
      async function* gen() {
        try {
          for (let i = 0; i < 40; i++) { produced++; yield Buffer.alloc(128 * 1024); }
        } finally { cancelled = true; }
      }
      const fake = Readable.from(gen()) as unknown as IncomingMessage;
      fake.statusCode = 200;
      fake.headers = {};
      queueMicrotask(() => cb(fake));
      return { on() { return this; }, end() {} };
    };
    await expect(store.importUrl("http://93.184.216.34/big")).rejects.toThrow("响应过大");
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThanOrEqual(5); // 500KB 上限 / 128KB ≈ 4 块后中止
    expect(store.listDocs()).toHaveLength(0);
  });

  it("非 2xx 报错且不写库", async () => {
    const { port } = await startServer((_q, res) => { res.writeHead(500); res.end("boom"); });
    const store = setup();
    toLocal(port);
    await expect(store.importUrl("http://93.184.216.34/err")).rejects.toThrow("HTTP 500");
    expect(store.listDocs()).toHaveLength(0);
  });

  it("连接失败(如端口无监听)报错且不写库", async () => {
    const store = setup();
    net.mode = "rewrite";
    net.rewriteTo = { hostname: "127.0.0.1", port: 1 }; // 保留端口,无监听
    await expect(store.importUrl("http://93.184.216.34/ok")).rejects.toThrow();
    expect(store.listDocs()).toHaveLength(0);
  });

  // ---- DNS 重绑定(TOCTOU)----
  // 判别力来源:rebind.test 不可解析,而探针会把连接导向本地靶子。
  // 因此成功只可能来自「实现把自己的 lookup 交给连接」;若实现依赖系统 DNS 或连接前重新解析,
  // 探针根本不会拿到 lookup,连接会以 ENOTFOUND 失败,测试随即失败。
  it("解析一次后即钉住:连接用的 lookup 直接返回已校验地址", async () => {
    const { port } = await startServer((_q, res) => { res.writeHead(200); res.end(html()); });
    const store = setup();
    net.dns = () => [{ address: "93.184.216.34", family: 4 }];
    net.mode = "probe";
    net.redirectTo = { hostname: "127.0.0.1", port };

    const r = await store.importUrl("http://rebind.test/ok");
    expect(r.doc.content).toContain("正文");

    // 校验阶段只解析一次:重绑定(第二次解析返回内网)没有机会发生。
    expect(net.dnsCalls).toEqual(["rebind.test"]);
    // 连接实际调用了实现的 lookup,且它返回的是已校验地址,而不是重新解析的结果。
    expect(net.lookupSeen).toEqual([{ host: "rebind.test", addrs: [{ address: "93.184.216.34", family: 4 }] }]);
    expect(net.dnsCalls).toHaveLength(1);
  });

  it("重绑定在校验后才发生也无效:连接仍用首次校验的地址", async () => {
    // 模型化重绑定:同一域名的第二次解析返回内网地址。
    // 若实现依赖连接前再解析,这里就会拿到 127.0.0.1 并打到内网;钉住后第二次解析根本不会发生。
    const { port } = await startServer((_q, res) => { res.writeHead(200); res.end(html()); });
    const store = setup();
    let nth = 0;
    net.dns = () => (++nth === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    net.mode = "probe";
    net.redirectTo = { hostname: "127.0.0.1", port };

    const r = await store.importUrl("http://rebind.test/ok");
    expect(r.doc.content).toContain("正文");
    expect(net.dnsCalls).toHaveLength(1); // 只解析一次,重绑定无窗口
    expect(net.lookupSeen).toEqual([{ host: "rebind.test", addrs: [{ address: "93.184.216.34", family: 4 }] }]);
  });

  it("校验前解析到内网时被拦下(对照组)", async () => {
    const store = setup();
    net.dns = () => [{ address: "127.0.0.1", family: 4 }];
    await expect(store.importUrl("http://rebind.test/ok")).rejects.toThrow("内网地址");
    expect(net.captured).toHaveLength(0);
    expect(store.listDocs()).toHaveLength(0);
  });
});

describe("import-url 路由审计", () => {
  function app() {
    const db = openDb(":memory:");
    return { db, app: createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-url-")))) };
  }
  const post = (url: string) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const payloads = (db: DatabaseSync, type: string) =>
    (db.prepare("SELECT payload FROM events WHERE type = ?").all(type) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload));

  it("成功记录 finalUrl/bytes;拒绝记录 reason 且不写库", async () => {
    const { db, app: a } = app();
    const { port } = await startServer((_q, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>t</title>ok");
    });
    net.mode = "rewrite";
    net.rewriteTo = { hostname: "127.0.0.1", port };

    const ok = await a.request("/work/docs/import-url", post("http://93.184.216.34/a"));
    expect(ok.status).toBe(200);
    expect(payloads(db, "work.doc.import")).toEqual([
      { kind: "url", source: "http://93.184.216.34/a", finalUrl: "http://93.184.216.34/a", bytes: 18 },
    ]);

    const bad = await a.request("/work/docs/import-url", post("http://127.0.0.1/"));
    expect(bad.status).toBe(400);
    const rejected = payloads(db, "work.doc.import.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].url).toBe("http://127.0.0.1/");
    expect(rejected[0].reason).toContain("内网地址");
    expect((db.prepare("SELECT COUNT(*) AS n FROM docs").get() as { n: number }).n).toBe(1); // 只有成功那次写库
  });
});
