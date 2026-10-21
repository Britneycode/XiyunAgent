// 主题系统:预设 token + 用户微调,全部由 CSS 变量落地,不在组件中硬编码颜色。
export interface ThemeTokens {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  codeBg: string;
  codeText: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  appearance: "light" | "dark" | "system";
  tokens: ThemeTokens;
  darkTokens?: ThemeTokens; // appearance=system 时使用
  fonts: { ui: string; reading: string; code: string };
}

const UI_FONT = "system-ui, sans-serif";
const SERIF = "Georgia, 'Songti SC', serif";
const MONO = "Consolas, 'Cascadia Mono', monospace";
// 工作台字体栈(Linen / Zinc 共用)。均为系统字体或可选本地安装字体,不依赖网络。
const WORKBENCH_UI = "Inter, 'Segoe UI Variable Text', 'Segoe UI', system-ui, 'PingFang SC', 'Microsoft YaHei UI', sans-serif";
const WORKBENCH_MONO = "'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'SF Mono', Consolas, Menlo, monospace";

export const PRESETS: ThemePreset[] = [
  {
    // Linen:默认主题。暖调中性灰(亚麻/羊皮纸)+ 赭陶强调色,浅深两套均满足 WCAG AA 正文对比度。
    id: "linen", name: "Linen", appearance: "system",
    tokens: { bg: "#fbfaf7", surface: "#f5f3ee", text: "#1d1c19", muted: "#6b675e", border: "#e3dfd5", accent: "#b0532f", codeBg: "#f3f1eb", codeText: "#1d1c19" },
    darkTokens: { bg: "#1a1917", surface: "#201f1c", text: "#ecebe5", muted: "#a29f96", border: "#35332f", accent: "#d97757", codeBg: "#151412", codeText: "#e6e4dc" },
    fonts: { ui: WORKBENCH_UI, reading: WORKBENCH_UI, code: WORKBENCH_MONO },
  },
  {
    id: "zinc", name: "Zinc", appearance: "system",
    tokens: { bg: "#ffffff", surface: "#fafafa", text: "#18181b", muted: "#71717a", border: "#e4e4e7", accent: "#4f6bed", codeBg: "#f4f4f5", codeText: "#18181b" },
    darkTokens: { bg: "#09090b", surface: "#111113", text: "#e4e4e7", muted: "#a1a1aa", border: "#27272a", accent: "#6d8cff", codeBg: "#0c0c0e", codeText: "#e4e4e7" },
    fonts: { ui: WORKBENCH_UI, reading: WORKBENCH_UI, code: WORKBENCH_MONO },
  },
  {
    id: "system", name: "System", appearance: "system",
    tokens: { bg: "#ffffff", surface: "#f6f7f9", text: "#1f2329", muted: "#646a73", border: "#d9dce1", accent: "#3b6ef6", codeBg: "#f3f4f6", codeText: "#1f2329" },
    darkTokens: { bg: "#14161a", surface: "#1c1f26", text: "#e3e6eb", muted: "#8a919e", border: "#2c313a", accent: "#6b94ff", codeBg: "#1a1d23", codeText: "#e3e6eb" },
    fonts: { ui: UI_FONT, reading: UI_FONT, code: MONO },
  },
  {
    id: "graphite", name: "Graphite", appearance: "dark",
    tokens: { bg: "#16171a", surface: "#1e2024", text: "#d6d8dc", muted: "#8b8f98", border: "#2e3138", accent: "#7d93a8", codeBg: "#101114", codeText: "#d6d8dc" },
    fonts: { ui: UI_FONT, reading: UI_FONT, code: MONO },
  },
  {
    id: "paper", name: "Paper", appearance: "light",
    tokens: { bg: "#faf8f4", surface: "#ffffff", text: "#2c2a26", muted: "#7a756a", border: "#e5e0d5", accent: "#b3542e", codeBg: "#f2efe8", codeText: "#2c2a26" },
    fonts: { ui: UI_FONT, reading: SERIF, code: MONO },
  },
  {
    id: "solarized-light", name: "Solarized Light", appearance: "light",
    tokens: { bg: "#fdf6e3", surface: "#eee8d5", text: "#586e75", muted: "#93a1a1", border: "#e0d9c3", accent: "#268bd2", codeBg: "#eee8d5", codeText: "#586e75" },
    fonts: { ui: UI_FONT, reading: UI_FONT, code: MONO },
  },
  {
    id: "solarized-dark", name: "Solarized Dark", appearance: "dark",
    tokens: { bg: "#002b36", surface: "#073642", text: "#93a1a1", muted: "#586e75", border: "#0d4350", accent: "#2aa198", codeBg: "#073642", codeText: "#93a1a1" },
    fonts: { ui: UI_FONT, reading: UI_FONT, code: MONO },
  },
  {
    id: "sakura", name: "Sakura", appearance: "light",
    tokens: { bg: "#fffafc", surface: "#ffffff", text: "#352b32", muted: "#82727b", border: "#eadde3", accent: "#c85b83", codeBg: "#2f2730", codeText: "#f0e6ec" },
    fonts: { ui: UI_FONT, reading: SERIF, code: MONO },
  },
  {
    id: "midnight", name: "Midnight", appearance: "dark",
    tokens: { bg: "#0b0e14", surface: "#131720", text: "#e8ecf4", muted: "#7d8595", border: "#232936", accent: "#4fc1ff", codeBg: "#0d1117", codeText: "#e8ecf4" },
    fonts: { ui: UI_FONT, reading: UI_FONT, code: MONO },
  },
];

export interface ThemeSettings {
  presetId: string;
  accent: string; // 空串 = 跟随预设
  fontFamily: string; // 空串 = 跟随预设
  readingFontFamily: string;
  codeFontFamily: string;
  fontSize: "small" | "medium" | "large";
  density: "comfortable" | "compact";
}

// 新用户默认 Linen;已保存过主题的用户沿用其 presetId,不受影响。
const DEFAULT_THEME: ThemeSettings = {
  presetId: "linen",
  accent: "",
  fontFamily: "",
  readingFontFamily: "",
  codeFontFamily: "",
  fontSize: "medium",
  density: "comfortable",
};

const KEY = "xiyun-theme";
const CUSTOM_KEY = "xiyun-custom-themes";

// 兼容阶段 1 的旧设置(mode/accent/fontSize 数值)。
function migrate(old: Record<string, unknown>): Partial<ThemeSettings> {
  const out: Partial<ThemeSettings> = {};
  if (typeof old.mode === "string")
    out.presetId = old.mode === "dark" ? "graphite" : old.mode === "light" ? "paper" : "system";
  if (typeof old.accent === "string") out.accent = old.accent as string;
  if (typeof old.fontFamily === "string" && old.fontFamily !== UI_FONT) out.fontFamily = old.fontFamily as string;
  if (typeof old.codeFont === "string" && old.codeFont !== "Consolas, monospace") out.codeFontFamily = old.codeFont as string;
  if (typeof old.fontSize === "number") out.fontSize = old.fontSize <= 13 ? "small" : old.fontSize >= 16 ? "large" : "medium";
  if (old.density === "compact" || old.density === "comfortable") out.density = old.density;
  return out;
}

export function loadTheme(): ThemeSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    return { ...DEFAULT_THEME, ...migrate(raw), ...raw };
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveTheme(t: ThemeSettings): void {
  localStorage.setItem(KEY, JSON.stringify(t));
}

export function resetTheme(): ThemeSettings {
  localStorage.removeItem(KEY);
  return DEFAULT_THEME;
}

export function allPresets(): ThemePreset[] {
  try {
    const custom = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]") as ThemePreset[];
    return [...PRESETS, ...custom];
  } catch {
    return PRESETS;
  }
}

const FONT_SIZES = { small: "13px", medium: "14.5px", large: "16.5px" } as const;

// ---- 强调色前景:按 WCAG 相对亮度在白字与深字之间取对比度更高者 ----
const ON_ACCENT_LIGHT = "#ffffff";
const ON_ACCENT_DARK = "#1a1917";

function luminance(hex: string): number | null {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const channel = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// 用户自定义强调色同样适用;无法解析的颜色回退白字。
export function readableOn(accent: string): string {
  const l = luminance(accent);
  if (l === null) return ON_ACCENT_LIGHT;
  const light = contrast(l, luminance(ON_ACCENT_LIGHT) ?? 1);
  const dark = contrast(l, luminance(ON_ACCENT_DARK) ?? 0);
  return light >= dark ? ON_ACCENT_LIGHT : ON_ACCENT_DARK;
}

export function applyTheme(t: ThemeSettings): void {
  const preset = allPresets().find((p) => p.id === t.presetId) ?? PRESETS[0];
  const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = preset.appearance === "dark" || (preset.appearance === "system" && systemDark);
  const tokens = dark && preset.darkTokens ? preset.darkTokens : preset.tokens;
  const r = document.documentElement;
  r.dataset.theme = dark ? "dark" : "light";
  r.dataset.density = t.density;
  r.style.setProperty("--bg", tokens.bg);
  r.style.setProperty("--surface", tokens.surface);
  r.style.setProperty("--text", tokens.text);
  r.style.setProperty("--muted", tokens.muted);
  r.style.setProperty("--border", tokens.border);
  const accent = t.accent || tokens.accent;
  r.style.setProperty("--accent", accent);
  r.style.setProperty("--accent-fg", readableOn(accent));
  r.style.setProperty("--code-bg", tokens.codeBg);
  r.style.setProperty("--code-text", tokens.codeText);
  r.style.setProperty("--font", t.fontFamily || preset.fonts.ui);
  r.style.setProperty("--reading-font", t.readingFontFamily || preset.fonts.reading);
  r.style.setProperty("--code-font", t.codeFontFamily || preset.fonts.code);
  r.style.setProperty("--font-size", FONT_SIZES[t.fontSize]);
}

// 主题包(theme.json)校验:白名单 token 键 + 十六进制颜色,不具备执行能力。
const TOKEN_KEYS: Array<keyof ThemeTokens> = ["bg", "surface", "text", "muted", "border", "accent", "codeBg", "codeText"];
const HEX = /^#[0-9a-fA-F]{3,8}$/;

export function importThemePackage(json: string): ThemePreset {
  const pkg = JSON.parse(json) as Partial<ThemePreset> & { version?: number };
  if (!pkg.id || !pkg.name || typeof pkg.version !== "number") throw new Error("主题包缺少 id/name/version");
  if (pkg.appearance !== "light" && pkg.appearance !== "dark") throw new Error("appearance 只支持 light/dark");
  if (!pkg.tokens || typeof pkg.tokens !== "object") throw new Error("缺少 tokens");
  const tokens = {} as ThemeTokens;
  for (const k of TOKEN_KEYS) {
    const v = (pkg.tokens as unknown as Record<string, unknown>)[k];
    if (typeof v !== "string" || !HEX.test(v)) throw new Error(`token ${k} 必须是十六进制颜色`);
    tokens[k] = v;
  }
  const preset: ThemePreset = {
    id: `custom-${pkg.id}`,
    name: pkg.name,
    appearance: pkg.appearance,
    tokens,
    fonts: {
      ui: pkg.fonts?.ui || UI_FONT,
      reading: pkg.fonts?.reading || pkg.fonts?.ui || UI_FONT,
      code: pkg.fonts?.code || MONO,
    },
  };
  const custom = allPresets().filter((p) => p.id.startsWith("custom-"));
  localStorage.setItem(CUSTOM_KEY, JSON.stringify([...custom.filter((p) => p.id !== preset.id), preset]));
  return preset;
}

export function exportThemePackage(t: ThemeSettings): void {
  const preset = allPresets().find((p) => p.id === t.presetId) ?? PRESETS[0];
  const pkg = {
    id: preset.id.replace(/^custom-/, ""),
    name: preset.name,
    version: 1,
    appearance: preset.appearance === "system" ? "light" : preset.appearance,
    tokens: preset.tokens,
    fonts: preset.fonts,
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" }));
  a.download = `${pkg.id}-theme.json`;
  a.click();
}
