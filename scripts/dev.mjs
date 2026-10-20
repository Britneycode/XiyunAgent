import { spawn } from "node:child_process";

const procs = [
  spawn("node", ["packages/server/src/index.ts"], { stdio: "inherit" }),
  spawn("pnpm", ["--filter", "@xiyun/web", "dev"], { stdio: "inherit", shell: true }),
];
for (const p of procs) p.on("exit", (code) => { if (code) process.exitCode = code; for (const q of procs) if (q !== p) q.kill(); });
