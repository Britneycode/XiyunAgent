import { app, BrowserWindow, dialog } from "electron";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
const isDev = !app.isPackaged;
const HEALTH = "http://127.0.0.1:3777/health";

async function healthy() {
  try {
    return (await fetch(HEALTH)).ok;
  } catch {
    return false;
  }
}

// Agent Server 独立进程运行,便于桌面端、Web 和 CLI 复用。
// 开发:系统 Node 24 直接运行 TS 源码。
// 打包:Electron 自带 Node 运行打包后的 server.mjs,数据目录指向可写的 userData。
let server = null;
let quitting = false;
let restarts = 0;
const MAX_RESTARTS = 5;
app.on("before-quit", () => { quitting = true; });

function spawnServer() {
  const args = isDev
    ? [join(root, "packages/server/src/index.ts")]
    : ["--experimental-sqlite", join(here, "server.mjs")];
  server = spawn(isDev ? "node" : process.execPath, args, {
    cwd: isDev ? root : app.getPath("userData"),
    stdio: "inherit",
    env: {
      ...process.env,
      ...(isDev ? {} : { ELECTRON_RUN_AS_NODE: "1", XIYUN_DATA_DIR: app.getPath("userData") }),
    },
  });
  server.on("error", () => {}); // 端口竞争等由 waitForServer 兜底
  // 打包态崩溃自动重启(递增退避,上限 5 次);超过上限提示用户。
  server.on("exit", (code) => {
    server = null;
    if (quitting || isDev || code === 0) return;
    if (restarts++ < MAX_RESTARTS) setTimeout(spawnServer, 1000 * restarts);
    else dialog.showErrorBox("XiyunAgent", "本地服务反复崩溃,请重启应用;数据已自动备份在数据目录 backups/ 下。");
  });
}
app.on("will-quit", () => server?.kill());

async function waitForServer(tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("agent server failed to start");
}

app.whenReady().then(async () => {
  if (!(await healthy())) spawnServer();
  await waitForServer();
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  if (isDev) await win.loadURL(DEV_URL);
  else await win.loadFile(join(here, "web", "index.html"));
});
