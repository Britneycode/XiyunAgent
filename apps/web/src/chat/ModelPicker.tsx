import { AnimatePresence } from "motion/react";
import { Check, ChevronDown, Cpu, Shuffle } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../ui/cn.ts";
import { MenuItem, MenuList, PopoverSurface, useActiveIndex, useDismiss } from "../ui/menu.tsx";
import type { ModelOption } from "./modelOptions.ts";
import { formatTokens } from "./tokens.ts";

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const CAPABILITY_LABEL: Record<string, string> = { tools: "工具", vision: "视觉", json: "JSON" };

const PROTOCOL_LABEL: Record<string, string> = { anthropic: "Anthropic", gemini: "Gemini" };

// 模型下拉(M3):默认是会话级选择,首项"跟随全局默认";compact 用于"换个模型重新生成",只显示图标、不含首项。
// 按钮保持输入框焦点之外的独立焦点,键盘 ↑↓ 选择、Enter 确认、Esc 关闭。
export function ModelPicker({
  options,
  value,
  globalOption,
  disabled,
  compact = false,
  onSelect,
}: {
  options: ModelOption[];
  value: string | null; // 选中项的 key;null = 跟随全局默认
  globalOption?: ModelOption; // 全局默认对应的模型,用于首项说明与按钮文字
  disabled: boolean;
  compact?: boolean;
  onSelect: (o: ModelOption | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  // 列表项:非 compact 时首项为"跟随全局默认"(null)
  const items: Array<ModelOption | null> = compact ? options : options.length ? [null, ...options] : [];
  const nav = useActiveIndex(items.length);
  const current = value ? options.find((o) => o.key === value) : globalOption;

  useDismiss(open, rootRef, () => setOpen(false));

  const selectedIndex = () => Math.max(0, items.findIndex((o) => (o ? o.key === value : value === null)));
  const show = () => {
    if (disabled) return;
    nav.setIndex(selectedIndex());
    // 上方空间不够(如消息流顶部的"换个模型重新生成")时向下展开,避免被滚动容器裁掉
    setDropUp((rootRef.current?.getBoundingClientRect().top ?? 1000) > 360);
    setOpen(true);
  };

  const choose = (o: ModelOption | null) => {
    setOpen(false);
    if (compact || (o?.key ?? null) !== value) onSelect(o);
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
      if (nav.index >= 0 && nav.index < items.length) choose(items[nav.index] ?? null);
    } else if (e.key === "Escape") {
      // 不冒泡到窗口:避免同时触发"Esc 停止生成"
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const label = current?.model ?? (options.length ? "选择模型" : "未配置模型");
  const title = compact
    ? "换个模型重新生成"
    : current
      ? `${value ? "本会话模型" : "跟随全局默认"}:${current.providerName} · ${current.model}`
      : "本会话模型";

  const trailing = (o: ModelOption, selected: boolean) => (
    <span className="flex shrink-0 items-center gap-1.5">
      {PROTOCOL_LABEL[o.protocol] && (
        <span className="rounded border border-line px-1 text-[10px] leading-4 text-subtle">{PROTOCOL_LABEL[o.protocol]}</span>
      )}
      {(o.capabilities ?? [])
        .filter((c) => c in CAPABILITY_LABEL)
        .map((c) => (
          <span key={c} className="rounded border border-line px-1 text-[10px] leading-4 text-subtle">
            {CAPABILITY_LABEL[c]}
          </span>
        ))}
      {o.contextLength ? <span className="font-mono text-2xs tabular-nums text-subtle">{formatTokens(o.contextLength)}</span> : null}
      {!compact && (
        <Check size={14} strokeWidth={2} aria-hidden className={cn("text-accent", selected ? "opacity-100" : "opacity-0")} />
      )}
    </span>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label={compact ? title : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && nav.index >= 0 ? `${listId}-${nav.index}` : undefined}
        title={title}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={cn(
          "inline-flex items-center rounded-lg transition-colors duration-150",
          "text-muted hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-50",
          compact ? "size-6 justify-center rounded-md" : "h-7 max-w-[240px] gap-1.5 px-2 font-mono text-2xs",
          open && "bg-surface-2 text-fg",
        )}
      >
        {compact ? (
          <Shuffle size={13} strokeWidth={1.75} aria-hidden />
        ) : (
          <>
            <Cpu size={12} strokeWidth={1.75} className="shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
            {value && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden title="本会话单独指定了模型" />}
            <ChevronDown
              size={12}
              strokeWidth={2}
              aria-hidden
              className={cn("shrink-0 transition-transform duration-150", open && "rotate-180")}
            />
          </>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <PopoverSurface
            id={listId}
            role="listbox"
            aria-label={compact ? "选择重新生成用的模型" : "选择本会话模型"}
            className={cn("absolute left-0 z-20 w-80 max-w-[calc(100vw-2rem)]", dropUp ? "bottom-full mb-2" : "top-full mt-2")}
          >
            <div className="flex h-8 shrink-0 items-center border-b border-line px-3 text-2xs text-subtle">
              {compact ? "用所选模型重新生成这条回复" : "本会话模型 · 全局默认在「设置 → 模型」"}
            </div>
            {items.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs leading-relaxed text-subtle">
                尚未配置模型
                <br />
                请在「设置 → 模型」中添加 Provider
              </div>
            ) : (
              <MenuList activeIndex={nav.index} className="max-h-72">
                {items.map((o, i) =>
                  o ? (
                    <MenuItem
                      key={o.key}
                      id={`${listId}-${i}`}
                      active={i === nav.index}
                      selected={!compact && o.key === value}
                      mono
                      label={o.model}
                      detail={`${o.providerName} · ${host(o.baseUrl)}`}
                      trailing={trailing(o, o.key === value)}
                      onHover={() => nav.setIndex(i)}
                      onSelect={() => choose(o)}
                    />
                  ) : (
                    <MenuItem
                      key="__global"
                      id={`${listId}-${i}`}
                      active={i === nav.index}
                      selected={value === null}
                      label="跟随全局默认"
                      detail={globalOption ? `${globalOption.providerName} · ${globalOption.model}` : "未配置全局默认"}
                      trailing={
                        <Check size={14} strokeWidth={2} aria-hidden className={cn("text-accent", value === null ? "opacity-100" : "opacity-0")} />
                      }
                      onHover={() => nav.setIndex(i)}
                      onSelect={() => choose(null)}
                    />
                  ),
                )}
              </MenuList>
            )}
          </PopoverSurface>
        )}
      </AnimatePresence>
    </div>
  );
}
