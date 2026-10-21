import { useCallback, useEffect, useRef, useState } from "react";

// 距底部小于该值视为"在底部"
const THRESHOLD = 48;

// 消息流贴底滚动:
// - 内容高度变化(流式增量、折叠动画、图片加载)时,若处于贴底状态则瞬时定位到底部;
// - 用户上滑(滚轮/键盘/拖动滚动条)即解除贴底,回到底部附近自动恢复;
// - 返回 atBottom 供"回到底部"按钮使用。
// 以 ResizeObserver 驱动而不是依赖 messages 变化,折叠动画等非数据变化同样能跟随。
export function useStickToBottom<S extends HTMLElement, C extends HTMLElement>() {
  const scrollRef = useRef<S>(null);
  const contentRef = useRef<C>(null);
  const stuck = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    stuck.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // 跳转到历史消息前调用:解除贴底,避免随后的内容高度变化把视图拉回底部
  const release = useCallback(() => {
    stuck.current = false;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let lastTop = el.scrollTop;

    const measure = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD;
      setAtBottom(bottom);
      return bottom;
    };
    const onScroll = () => {
      const bottom = measure();
      if (bottom) stuck.current = true;
      else if (el.scrollTop < lastTop - 1) stuck.current = false;
      lastTop = el.scrollTop;
    };
    // 滚轮上滑在内容不足一屏时不会产生 scroll 事件,单独处理
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && el.scrollHeight > el.clientHeight) stuck.current = false;
    };
    const ro = new ResizeObserver(() => {
      if (stuck.current) {
        el.scrollTop = el.scrollHeight;
        lastTop = el.scrollTop;
      }
      measure();
    });
    ro.observe(content);
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  return { scrollRef, contentRef, atBottom, scrollToBottom, release };
}
