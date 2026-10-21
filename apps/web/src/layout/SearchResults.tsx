import type { SearchHit } from "@xiyun/shared";

// 服务端用 \u0001 / \u0002 包住命中词;这里拆分成文本节点 + <mark>,不拼 HTML
function Highlight({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("\u0001") ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-px text-accent">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p.replace(/[\u0001\u0002]/g, "")}</span>
        ),
      )}
    </>
  );
}

// 侧栏搜索的"消息内容"分组(M7):会话标题之外再按消息全文匹配
export function SearchResults({ hits, onOpen }: { hits: SearchHit[]; onOpen: (h: SearchHit) => void }) {
  return (
    <div role="presentation">
      <div className="px-2.5 pb-1 pt-3 text-2xs font-medium text-subtle">
        消息内容{hits.length ? ` · ${hits.length}` : ""}
      </div>
      {hits.length === 0 ? (
        <div className="px-2.5 py-1 text-2xs text-subtle">没有匹配的消息</div>
      ) : (
        hits.map((h) => (
          <button
            key={h.messageId}
            type="button"
            role="listitem"
            onClick={() => onOpen(h)}
            className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-surface-2/70"
          >
            <span className="flex w-full items-center gap-1.5 text-2xs text-subtle">
              <span className="min-w-0 flex-1 truncate font-medium text-muted">{h.session.title}</span>
              <span className="shrink-0">{h.role === "user" ? "我" : "回复"}</span>
            </span>
            <span className="line-clamp-2 break-words text-xs leading-snug text-muted">
              <Highlight text={h.snippet} />
            </span>
          </button>
        ))
      )}
    </div>
  );
}
