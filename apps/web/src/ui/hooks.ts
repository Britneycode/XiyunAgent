import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";

// 订阅媒体查询;useSyncExternalStore 保证首帧即为正确值,不会先渲染错误布局再跳变。
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

// 持久化到 localStorage 的 state;读取失败或校验不通过时回退初始值。
export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  validate: (raw: unknown) => raw is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (validate(parsed)) return parsed;
      }
    } catch {
      // 损坏的持久化值直接忽略
    }
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 存储不可用(隐私模式/配额)时只保留内存态
    }
  }, [key, value]);
  return [value, setValue];
}

export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface HotkeyOptions {
  mod?: boolean; // Ctrl(Windows/Linux)或 ⌘(macOS)
  shift?: boolean;
  enabled?: boolean;
}

// 全局快捷键。处理函数存在 ref 中,调用方无需 useCallback 也不会重复绑定监听。
export function useHotkey(key: string, handler: (e: KeyboardEvent) => void, opts: HotkeyOptions = {}): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  const { mod = false, shift = false, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.altKey) return;
      if ((e.ctrlKey || e.metaKey) !== mod) return;
      if (e.shiftKey !== shift) return;
      // 同时匹配 e.code:Shift 会改变符号键的 e.key(Shift+; 得到 ":"),这类键用 code 名注册,如 "Semicolon"
      if (e.key.toLowerCase() !== key.toLowerCase() && e.code !== key) return;
      e.preventDefault();
      handlerRef.current(e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, mod, shift, enabled]);
}

export interface ResizableOptions {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  // 拖拽手柄所在的边:left = 手柄在面板左缘(右侧面板),向左拖变宽
  edge: "left" | "right";
}

export interface ResizeHandleProps {
  role: "separator";
  tabIndex: number;
  "aria-orientation": "vertical";
  "aria-valuemin": number;
  "aria-valuemax": number;
  "aria-valuenow": number;
  "aria-label": string;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
}

const KEY_STEP = 16;

// 面板宽度拖拽:指针拖动、双击复位、方向键微调,宽度持久化。
export function useResizable(opts: ResizableOptions): {
  width: number;
  dragging: boolean;
  handleProps: ResizeHandleProps;
} {
  const { storageKey, initial, min, max, edge } = opts;
  const [stored, setStored] = usePersistentState<number>(storageKey, initial, isNumber);
  const [dragging, setDragging] = useState(false);
  const clamp = useCallback((w: number) => Math.round(Math.min(max, Math.max(min, w))), [min, max]);
  const width = clamp(stored);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      setDragging(true);
      const body = document.body;
      const prevCursor = body.style.cursor;
      const prevSelect = body.style.userSelect;
      body.style.cursor = "col-resize";
      body.style.userSelect = "none";
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        setStored(clamp(edge === "left" ? startWidth - dx : startWidth + dx));
      };
      const onUp = () => {
        setDragging(false);
        body.style.cursor = prevCursor;
        body.style.userSelect = prevSelect;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [width, edge, clamp, setStored],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const grow = (e.key === "ArrowLeft") === (edge === "left");
      setStored(clamp(width + (grow ? KEY_STEP : -KEY_STEP)));
    },
    [width, edge, clamp, setStored],
  );

  return {
    width,
    dragging,
    handleProps: {
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical",
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": width,
      "aria-label": "调整面板宽度",
      onPointerDown,
      onDoubleClick: () => setStored(initial),
      onKeyDown,
    },
  };
}

const subscribeResize = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};

// 视口宽度(用于按剩余空间夹紧可拖拽面板)
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth);
}
