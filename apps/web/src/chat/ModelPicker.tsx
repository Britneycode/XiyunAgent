import { AnimatePresence } from "motion/react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../ui/cn.ts";
import { MenuItem, MenuList, PopoverSurface, useActiveIndex, useDismiss } from "../ui/menu.tsx";
import { formatTokens } from "./tokens.ts";

export interface ProviderOption {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  contextLength?: number;
  capabilities?: string[];
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const CAPABILITY_LABEL: Record<string, string> = { tools: "工具", vision: "视觉", json: "JSON" };

// 全局模型下拉:按钮保持输入框焦点之外的独立焦点,键盘 ↑↓ 选择、Enter 确认、Esc 关闭。
export function ModelPicker({
  providers,
  activeId,
  disabled,
  onSelect,
}: {
  providers: ProviderOption[];
  activeId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const nav = useActiveIndex(providers.length);
  const current = providers.find((p) => p.id === activeId);

  useDismiss(open, rootRef, () => setOpen(false));

  const show = () => {
    if (disabled) return;
    nav.setIndex(Math.max(0, providers.findIndex((p) => p.id === activeId)));
    setOpen(true);
  };

  const choose = (id: string) => {
    setOpen(false);
    if (id !== activeId) onSelect(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      nav.move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const p = providers[nav.index];
      if (p) choose(p.id);
    } else if (e.key === "Escape") {
      // 不冒泡到窗口:避免同时触发"Esc 停止生成"
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const label = current?.model ?? (providers.length ? "选择模型" : "未配置模型");

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && nav.index >= 0 ? `${listId}-${nav.index}` : undefined}
        title={current ? `全局模型:${current.name} · ${current.model}` : "全局模型"}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={cn(
          "inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg px-2 font-mono text-2xs transition-colors duration-150",
          "text-muted hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-50",
          open && "bg-surface-2 text-fg",
        )}
      >
        <Cpu size={12} strokeWidth={1.75} className="shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
        <ChevronDown
          size={12}
          strokeWidth={2}
          aria-hidden
          className={cn("shrink-0 transition-transform duration-150", open && "rotate-180")}
        />
      </button>
      <AnimatePresence>
        {open && (
          <PopoverSurface
            id={listId}
            role="listbox"
            aria-label="选择全局模型"
            className="absolute bottom-full left-0 mb-2 w-80 max-w-[calc(100vw-2rem)]"
          >
            <div className="flex h-8 shrink-0 items-center border-b border-line px-3 text-2xs text-subtle">
              全局模型 · 切换后对所有会话生效
            </div>
            {providers.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs leading-relaxed text-subtle">
                尚未配置模型
                <br />
                请在「设置 → 模型」中添加 Provider
              </div>
            ) : (
              <MenuList activeIndex={nav.index} className="max-h-72">
                {providers.map((p, i) => (
                  <MenuItem
                    key={p.id}
                    id={`${listId}-${i}`}
                    active={i === nav.index}
                    selected={p.id === activeId}
                    mono
                    label={p.model}
                    detail={`${p.name} · ${host(p.baseUrl)}`}
                    trailing={
                      <span className="flex shrink-0 items-center gap-1.5">
                        {(p.capabilities ?? [])
                          .filter((c) => c in CAPABILITY_LABEL)
                          .map((c) => (
                            <span
                              key={c}
                              className="rounded border border-line px-1 text-[10px] leading-4 text-subtle"
                            >
                              {CAPABILITY_LABEL[c]}
                            </span>
                          ))}
                        {p.contextLength ? (
                          <span className="font-mono text-2xs tabular-nums text-subtle">
                            {formatTokens(p.contextLength)}
                          </span>
                        ) : null}
                        <Check
                          size={14}
                          strokeWidth={2}
                          aria-hidden
                          className={cn("text-accent", p.id === activeId ? "opacity-100" : "opacity-0")}
                        />
                      </span>
                    }
                    onHover={() => nav.setIndex(i)}
                    onSelect={() => choose(p.id)}
                  />
                ))}
              </MenuList>
            )}
          </PopoverSurface>
        )}
      </AnimatePresence>
    </div>
  );
}
