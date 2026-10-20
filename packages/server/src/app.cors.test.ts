import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";

function setup() {
  const db = openDb(":memory:");
  return createApp(db, new MemoryStore(db), new ProviderStore(mkdtempSync(join(tmpdir(), "xiyun-cors-"))));
}

describe("CORS 白名单", () => {
  it("外部来源不下发 Access-Control-Allow-Origin", async () => {
    const res = await setup().request("/health", { headers: { Origin: "http://evil.com" } });
    expect(res.headers.get("access-control-allow-origin") ?? "").not.toContain("evil.com");
  });

  it("localhost 与 127.0.0.1/[::1] 来源放行", async () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
      const res = await setup().request("/health", { headers: { Origin: origin } });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("Origin 为 null(file:// 沙箱页面)被拒", async () => {
    const res = await setup().request("/health", { headers: { Origin: "null" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("无 Origin 头(非浏览器/curl/Electron 主进程)正常通过", async () => {
    const res = await setup().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("外部来源预检不通过", async () => {
    const res = await setup().request("/health", {
      method: "OPTIONS",
      headers: { Origin: "http://evil.com", "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin") ?? "").not.toContain("evil.com");
  });

  it("本地来源预检通过", async () => {
    const res = await setup().request("/health", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
});
