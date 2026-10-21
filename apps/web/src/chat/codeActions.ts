import type { Preview } from "./blocks.tsx";

// Markdown 代码块是静态 HTML 字符串,其按钮通过事件委托处理:
// 复制 / 自动换行 / 展开全部 / 在预览中打开。状态直接写在 DOM 上(类名与 aria 属性),
// 已定稿的块不会再被 React 重写,状态得以保留。
const copyTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

const SELECTOR = "button[data-copy], button[data-wrap], button[data-expand], button[data-preview]";

export function handleCodeAction(target: EventTarget | null, onPreview?: (p: Preview) => void): boolean {
  if (!(target instanceof Element)) return false;
  const btn = target.closest<HTMLButtonElement>(SELECTOR);
  const block = btn?.closest<HTMLElement>(".code-block");
  const code = block?.querySelector("pre code");
  if (!btn || !block || !code) return false;
  // 每行 span 末尾带换行符,去掉最后一个,得到原始源码
  const text = (code.textContent ?? "").replace(/\n$/, "");

  if (btn.hasAttribute("data-copy")) {
    void navigator.clipboard.writeText(text).then(
      () => {
        btn.dataset.copied = "";
        clearTimeout(copyTimers.get(btn));
        copyTimers.set(btn, setTimeout(() => delete btn.dataset.copied, 1400));
      },
      () => {},
    );
  } else if (btn.hasAttribute("data-wrap")) {
    const on = block.classList.toggle("is-wrapped");
    btn.setAttribute("aria-pressed", String(on));
  } else if (btn.hasAttribute("data-expand")) {
    // 头部图标按钮与底部"展开剩余 N 行"共用同一状态
    const on = block.classList.toggle("is-expanded");
    const label = on ? "收起" : "展开全部";
    for (const b of block.querySelectorAll<HTMLButtonElement>("button[data-expand]")) {
      b.setAttribute("aria-expanded", String(on));
      if (b.classList.contains("code-btn")) {
        b.setAttribute("aria-label", label);
        b.title = label;
      }
    }
    // 从底部收起时块会变矮,保证代码块仍在视野内
    if (!on) block.scrollIntoView({ block: "nearest" });
  } else if (btn.hasAttribute("data-preview")) {
    if (!onPreview) return false;
    const lang = block.dataset.lang || "text";
    const lines = text === "" ? 1 : text.split("\n").length;
    onPreview({ kind: "artifact", title: `${lang} · ${lines} 行`, body: text, lang });
  }
  return true;
}
