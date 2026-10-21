// 快捷键清单(M6):帮助面板(Ctrl+/)从这里渲染;实际绑定分散在 App / ChatPage / Composer。
// 修改绑定时同步更新这里。
export interface ShortcutDef {
  keys: string[]; // 依次按住的键,如 ["Ctrl", "Shift", "O"]
  alt?: string[]; // 等价的另一组键
  desc: string;
}

export const SHORTCUT_GROUPS: Array<{ title: string; items: ShortcutDef[] }> = [
  {
    title: "通用",
    items: [
      { keys: ["Ctrl", "Shift", "O"], desc: "新建会话" },
      { keys: ["Ctrl", "K"], desc: "搜索会话" },
      { keys: ["Ctrl", "B"], alt: ["Ctrl", "Shift", "S"], desc: "切换侧栏" },
      { keys: ["Ctrl", "J"], desc: "切换检查器" },
      { keys: ["Ctrl", "1 / 2 / 3"], desc: "切换模式(Chat / Work / Code)" },
      { keys: ["Ctrl", "/"], desc: "显示快捷键" },
    ],
  },
  {
    title: "对话",
    items: [
      { keys: ["Enter"], desc: "发送" },
      { keys: ["Shift", "Enter"], desc: "换行" },
      { keys: ["Esc"], desc: "停止生成 / 取消编辑" },
      { keys: ["Shift", "Esc"], desc: "聚焦输入框" },
      { keys: ["↑"], desc: "输入框为空时编辑上一条消息" },
      { keys: ["Ctrl", "Shift", "C"], desc: "复制最后一条回复" },
      { keys: ["Ctrl", "Shift", ";"], desc: "复制最后一个代码块" },
      { keys: ["@"], desc: "引用消息、文件或文档" },
      { keys: ["/"], desc: "命令菜单" },
    ],
  },
  {
    title: "会话列表",
    items: [
      { keys: ["F2"], desc: "重命名" },
      { keys: ["Delete"], desc: "删除" },
    ],
  },
];

// 取消息里最后一个围栏代码块的内容(不含语言标记行);没有则返回 null
export function lastCodeBlock(markdown: string): string | null {
  const re = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1?\2[ \t]*$/gm;
  let last: string | null = null;
  for (const m of markdown.matchAll(re)) last = m[3]!.replace(/\n$/, "");
  return last;
}
