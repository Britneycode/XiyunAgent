import { createContext, useContext, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Preview } from "../chat/blocks.tsx";
import type { InspectorTabId, PanelId } from "./types.ts";

// 主区页面与右侧检查器之间的桥:
// Code / Work 页把自己的面板(变更、终端、资料、待办)通过 portal 渲染进检查器的标签页槽位,
// 状态与请求逻辑仍留在页面组件内,检查器只负责布局与标签切换。
export interface InspectorBridge {
  slots: Partial<Record<PanelId, HTMLElement>>;
  open: boolean;
  active: InspectorTabId;
  openPanel: (id: InspectorTabId) => void;
  togglePanel: (id: InspectorTabId) => void;
  setBadge: (id: PanelId, count: number | undefined) => void;
  showPreview: (p: Preview) => void;
}

const BridgeContext = createContext<InspectorBridge | null>(null);

export const InspectorBridgeProvider = BridgeContext.Provider;

export function useInspectorBridge(): InspectorBridge | null {
  return useContext(BridgeContext);
}

// 面板当前是否可见(检查器展开且停在该标签页)
export function usePanelVisible(id: PanelId): boolean {
  const bridge = useContext(BridgeContext);
  return !!bridge?.slots[id];
}

// 把面板内容渲染到检查器对应标签页;标签页未挂载时不渲染
export function InspectorPortal({ id, children }: { id: PanelId; children: ReactNode }) {
  const el = useContext(BridgeContext)?.slots[id];
  return el ? createPortal(children, el) : null;
}

// 标签页角标:页面卸载时自动清除
export function useInspectorBadge(id: PanelId, count: number | undefined) {
  const setBadge = useContext(BridgeContext)?.setBadge;
  useEffect(() => {
    setBadge?.(id, count);
  }, [setBadge, id, count]);
  useEffect(() => () => setBadge?.(id, undefined), [setBadge, id]);
}
