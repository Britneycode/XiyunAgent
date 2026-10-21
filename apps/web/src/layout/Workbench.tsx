import { AnimatePresence, MotionConfig, motion, type Transition } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../ui/cn.ts";
import { useResizable, useViewportWidth } from "../ui/hooks.ts";

export const SIDE_WIDTH = 272;
export const RAIL_WIDTH = 52; // 与 index.css 中 --w-rail 保持一致
const MAIN_MIN = 420; // 主交互流的最小保留宽度
const INSPECTOR = { initial: 440, min: 320, max: 760 } as const;

const tween: Transition = { type: "tween", duration: 0.22, ease: [0.16, 1, 0.3, 1] };
const fade: Transition = { duration: 0.12 };
const instant: Transition = { duration: 0 };

interface WorkbenchProps {
  rail: ReactNode; // 收起态窄栏
  sidebar: ReactNode; // 展开态侧栏
  sideOpen: boolean;
  sideOverlay: boolean; // 窄窗口:侧栏以浮层形式覆盖主区,窄栏常驻
  onSideClose: () => void;
  inspector: ReactNode;
  inspectorOpen: boolean;
  inspectorOverlay: boolean; // 窄窗口:检查器以浮层形式覆盖主区
  onInspectorClose: () => void;
  statusBar: ReactNode;
  children: ReactNode;
}

// 工作台骨架:侧栏(展开 272px / 收起为 52px 窄栏)| 主交互流 | 检查器,底部状态栏。
// 只负责布局、动画与拖拽宽度,不持有业务状态。
export function Workbench(props: WorkbenchProps) {
  const { sideOpen, sideOverlay, inspectorOpen, inspectorOverlay } = props;
  const { width, dragging, handleProps } = useResizable({
    storageKey: "xiyun.layout.inspectorWidth",
    initial: INSPECTOR.initial,
    min: INSPECTOR.min,
    max: INSPECTOR.max,
    edge: "left",
  });
  const viewport = useViewportWidth();

  const sideDocked = sideOpen && !sideOverlay;
  // 停靠模式下按剩余空间夹紧,保证主区不被挤到不可用
  const sideSpace = sideDocked ? SIDE_WIDTH : RAIL_WIDTH;
  const dockedWidth = Math.max(INSPECTOR.min, Math.min(width, viewport - sideSpace - MAIN_MIN));

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-full flex-col overflow-hidden bg-canvas text-fg">
        <div className="relative flex min-h-0 flex-1">
          <motion.aside
            aria-label="侧栏"
            initial={false}
            animate={{ width: sideDocked ? SIDE_WIDTH : RAIL_WIDTH }}
            transition={tween}
            className="relative shrink-0 overflow-hidden border-r border-line bg-surface"
          >
            <AnimatePresence initial={false}>
              {sideDocked ? (
                <motion.div
                  key="sidebar"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { ...fade, delay: 0.06 } }}
                  exit={{ opacity: 0, transition: fade }}
                  className="absolute inset-y-0 left-0"
                  style={{ width: SIDE_WIDTH }}
                >
                  {props.sidebar}
                </motion.div>
              ) : (
                <motion.div
                  key="rail"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { ...fade, delay: 0.06 } }}
                  exit={{ opacity: 0, transition: fade }}
                  className="absolute inset-y-0 left-0"
                  style={{ width: RAIL_WIDTH }}
                >
                  {props.rail}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.aside>

          <main className="flex min-w-0 flex-1 flex-col">{props.children}</main>

          <AnimatePresence initial={false}>
            {inspectorOpen && !inspectorOverlay && (
              <motion.aside
                key="inspector-docked"
                aria-label="检查器"
                initial={{ width: 0 }}
                animate={{ width: dockedWidth }}
                exit={{ width: 0 }}
                transition={dragging ? instant : tween}
                className="relative shrink-0 overflow-hidden border-l border-line bg-surface"
              >
                <div className="absolute inset-y-0 right-0" style={{ width: dockedWidth }}>
                  {props.inspector}
                </div>
                <div {...handleProps} className="group absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize outline-none">
                  <span
                    className={cn(
                      "absolute inset-y-0 left-0 w-px transition-colors duration-150",
                      "group-hover:bg-accent/70 group-focus-visible:bg-accent",
                      dragging && "bg-accent",
                    )}
                  />
                </div>
              </motion.aside>
            )}
          </AnimatePresence>

          {/* 窄窗口浮层:遮罩点击关闭 */}
          <AnimatePresence>
            {((sideOpen && sideOverlay) || (inspectorOpen && inspectorOverlay)) && (
              <motion.div
                key="scrim"
                aria-hidden
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tween}
                className="fixed inset-x-0 top-0 bottom-[var(--h-status)] z-30 bg-black/30 backdrop-blur-[1px]"
                onClick={() => {
                  if (sideOverlay) props.onSideClose();
                  if (inspectorOverlay) props.onInspectorClose();
                }}
              />
            )}
            {sideOpen && sideOverlay && (
              <motion.aside
                key="side-overlay"
                aria-label="侧栏"
                initial={{ x: -16, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -16, opacity: 0 }}
                transition={tween}
                className="fixed top-0 bottom-[var(--h-status)] left-0 z-40 border-r border-line bg-surface shadow-pop"
                style={{ width: SIDE_WIDTH }}
              >
                {props.sidebar}
              </motion.aside>
            )}
            {inspectorOpen && inspectorOverlay && (
              <motion.aside
                key="inspector-overlay"
                aria-label="检查器"
                initial={{ x: 24, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 24, opacity: 0 }}
                transition={tween}
                className="fixed top-0 right-0 bottom-[var(--h-status)] z-40 border-l border-line bg-surface shadow-pop"
                style={{ width: `min(${width}px, calc(100vw - ${RAIL_WIDTH}px))` }}
              >
                {props.inspector}
              </motion.aside>
            )}
          </AnimatePresence>
        </div>
        {props.statusBar}
      </div>
    </MotionConfig>
  );
}
