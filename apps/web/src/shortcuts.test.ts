import { describe, expect, it } from "vitest";
import { lastCodeBlock } from "./shortcuts.ts";
import { loadDraft, readDrafts, saveDraft, DRAFTS_KEY } from "./chat/drafts.ts";

const memStore = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
};

describe("lastCodeBlock", () => {
  it("取最后一个围栏代码块,支持 ~~~ 与更长的围栏", () => {
    const md = "前文\n```ts\nconst a = 1;\n```\n中间\n~~~\nb\n~~~\n";
    expect(lastCodeBlock(md)).toBe("b");
    expect(lastCodeBlock("```js\nx()\n\ny()\n```")).toBe("x()\n\ny()");
    expect(lastCodeBlock("````md\n```inner```\n````")).toBe("```inner```");
    expect(lastCodeBlock("没有代码")).toBeNull();
  });
});

describe("drafts", () => {
  it("保存、读取、清空即删除", () => {
    const s = memStore();
    saveDraft("s1", { text: "写到一半", refs: [{ key: "f-a" }] }, s, 1);
    expect(loadDraft("s1", s)).toEqual({ text: "写到一半", refs: [{ key: "f-a" }], t: 1 });
    saveDraft("s1", { text: "  ", refs: [] }, s, 2);
    expect(loadDraft("s1", s)).toBeNull();
    expect(s.raw.has(DRAFTS_KEY)).toBe(false);
  });
  it("只保留最近 30 个会话;坏数据按空处理", () => {
    const s = memStore();
    for (let i = 0; i < 35; i++) saveDraft(`s${i}`, { text: `d${i}`, refs: [] }, s, i);
    const all = readDrafts(s);
    expect(Object.keys(all)).toHaveLength(30);
    expect(all.s0).toBeUndefined();
    expect(all.s34?.text).toBe("d34");
    s.setItem(DRAFTS_KEY, "{bad json");
    expect(readDrafts(s)).toEqual({});
  });
});
