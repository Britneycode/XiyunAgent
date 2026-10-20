import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // 打包态 Electron 用 loadFile 加载 file:// 协议的 index.html,绝对路径 /assets 会被解析到盘根导致 404。
  // base: './' 让产物引用变为相对路径,dev 下 vite 仍以 / 服务,行为不变。
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:3777", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
