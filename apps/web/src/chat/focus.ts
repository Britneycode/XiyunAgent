import { useCallback, useSyncExternalStore } from "react";

// 跳转到某条消息的请求(M7 消息搜索):侧栏点击命中 → 打开会话 → 对应 ChatPage 加载完消息后滚动并高亮。
// 用模块级存储而不是层层传 props:Chat / Code / Work 三个页面都内嵌 ChatPage。
export interface FocusRequest {
  sessionId: string;
  messageId: number;
  tick: number;
}

let pending: FocusRequest | null = null;
let tick = 0;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function requestFocus(sessionId: string, messageId: number) {
  pending = { sessionId, messageId, tick: ++tick };
  notify();
}

// 返回属于该会话的待处理请求;处理完调用 consume
export function useFocusRequest(sessionId: string): [FocusRequest | null, () => void] {
  const req = useSyncExternalStore(subscribe, () => pending);
  const mine = req && req.sessionId === sessionId ? req : null;
  const consume = useCallback(() => {
    if (pending && pending === mine) {
      pending = null;
      notify();
    }
  }, [mine]);
  return [mine, consume];
}
