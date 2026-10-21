import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, loadTheme } from "./theme.ts";
import "./index.css";
import "./styles.css";

// 首帧前落主题变量,避免默认色闪一下再切换
applyTheme(loadTheme());
// 跟随系统外观的预设(System / Zinc)在系统切换深浅色时即时刷新
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(loadTheme()));

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
