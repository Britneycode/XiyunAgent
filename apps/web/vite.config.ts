import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // 打包态 Electron 用 loadFile 加载 file:// 协议的 index.html,绝对路径 /assets 会被解析到盘根导致 404。
  // base: './' 让产物引用变为相对路径,dev 下 vite 仍以 / 服务,行为不变。
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // 第三方库独立分块:业务代码改动时不影响 vendor 缓存,也避免单块超过体积告警
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
          motion: ["motion/react"],
          icons: ["lucide-react"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:3777", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
