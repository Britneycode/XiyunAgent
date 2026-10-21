import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { IconButton, Tabs } from "../ui/primitives.tsx";

export interface InspectorTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  badge?: number;
  flush?: boolean; // 内容自行管理内边距与滚动(如带底部输入框的面板),占满内容区高度
  content: ReactNode;
}

// 右侧检查器:标签页 + 内容区。宽度、滑入滑出与拖拽由 Workbench 负责。
export function Inspector<T extends string>({
  tabs,
  active,
  onActiveChange,
  onClose,
}: {
  tabs: Array<InspectorTab<T>>;
  active: T;
  onActiveChange: (id: T) => void;
  onClose: () => void;
}) {
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-stretch gap-1 border-b border-line pl-1 pr-1.5">
        <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Tabs
            items={tabs.map(({ id, label, icon, badge }) => ({ id, label, icon, badge }))}
            value={current.id}
            onChange={onActiveChange}
            layoutId="inspector-tab"
            className="w-max"
          />
        </div>
        <div className="flex items-center">
          <IconButton label="关闭面板" kbd="Ctrl+J" size="xs" onClick={onClose}>
            <X size={14} strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.id}
            role="tabpanel"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
            className={current.flush ? "h-full" : "p-3"}
          >
            {current.content}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
