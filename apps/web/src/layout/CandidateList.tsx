import { Brain, Check, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { MemoryCandidate } from "@xiyun/shared";
import { Button } from "../ui/primitives.tsx";

const LIMIT = 8;

// 待确认记忆候选。确认/忽略期间锁定该条按钮,防止重复提交。
export function CandidateList({
  candidates,
  onResolve,
  onOpenMemory,
}: {
  candidates: MemoryCandidate[];
  onResolve: (id: string, action: "confirm" | "reject") => Promise<void>;
  onOpenMemory: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);

  const resolve = async (id: string, action: "confirm" | "reject") => {
    setPending(id);
    try {
      await onResolve(id, action);
    } finally {
      setPending(null);
    }
  };

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <Brain size={18} strokeWidth={1.6} className="text-subtle" aria-hidden />
        <p className="text-xs text-muted">对话中产生的候选记忆会出现在这里。</p>
      </div>
    );
  }

  const shown = candidates.slice(0, LIMIT);
  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {shown.map((c) => (
          <motion.div
            key={c.id}
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: 16, transition: { duration: 0.15 } }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="rounded-lg border border-line bg-canvas p-3"
          >
            <p className="text-ui leading-relaxed text-fg">{c.content}</p>
            <div className="mt-2 flex items-center gap-2 font-mono text-2xs text-subtle">
              <span className="min-w-0 flex-1 truncate" title={c.reason || "提取自对话"}>
                {c.reason || "提取自对话"}
              </span>
              <span className="flex shrink-0 items-center gap-1.5" title="置信度">
                <span className="h-1 w-10 overflow-hidden rounded-full bg-surface-3">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${Math.round(Math.min(1, Math.max(0, c.confidence)) * 100)}%` }}
                  />
                </span>
                {c.confidence.toFixed(2)}
              </span>
            </div>
            <div className="mt-2.5 flex gap-1.5">
              <Button
                variant="primary"
                size="xs"
                disabled={pending === c.id}
                onClick={() => void resolve(c.id, "confirm")}
              >
                <Check size={12} strokeWidth={2} />
                确认
              </Button>
              <Button variant="ghost" size="xs" disabled={pending === c.id} onClick={() => void resolve(c.id, "reject")}>
                <X size={12} strokeWidth={2} />
                忽略
              </Button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      {candidates.length > LIMIT && (
        <Button variant="ghost" size="xs" className="self-start" onClick={onOpenMemory}>
          还有 {candidates.length - LIMIT} 条,在记忆管理中查看
        </Button>
      )}
    </div>
  );
}
