import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { SHORTCUT_GROUPS } from "../shortcuts.ts";
import { IconButton, Kbd } from "../ui/primitives.tsx";

// 快捷键帮助面板(Ctrl+/):内容来自 shortcuts.ts 清单。Esc 或点遮罩关闭。
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    // 捕获阶段拦下 Esc:只关闭面板,不触发"停止生成"等页面级处理
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // portal 到 body:避免祖先的 transform / overflow 影响 fixed 定位
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="shortcuts"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="键盘快捷键"
            tabIndex={-1}
            initial={{ y: 8, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 8, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="max-h-[80vh] w-full max-w-[600px] overflow-y-auto rounded-xl border border-line bg-elevated p-5 shadow-pop outline-none"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-medium text-fg">键盘快捷键</h2>
              <IconButton label="关闭" size="xs" onClick={onClose}>
                <X size={14} strokeWidth={1.75} />
              </IconButton>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              {SHORTCUT_GROUPS.map((g) => (
                <section key={g.title} className={g.title === "对话" ? "sm:row-span-2" : undefined}>
                  <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-subtle">{g.title}</h3>
                  <ul className="flex flex-col gap-1.5">
                    {g.items.map((it) => (
                      <li key={`${it.keys.join("+")}-${it.desc}`} className="flex items-center justify-between gap-3 text-xs">
                        <span className="text-muted">{it.desc}</span>
                        <span className="flex shrink-0 items-center gap-0.5">
                          {it.keys.map((k) => (
                            <Kbd key={k}>{k}</Kbd>
                          ))}
                          {it.alt && <span className="px-1 text-2xs text-subtle">或</span>}
                          {it.alt?.map((k) => (
                            <Kbd key={`alt-${k}`}>{k}</Kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
