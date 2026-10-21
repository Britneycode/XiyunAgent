import { CodeXml, ListChecks, MessageCircle, type LucideIcon } from "lucide-react";

export type Mode = "chat" | "work" | "code";
export type Page = "main" | "memory" | "settings";
// 检查器标签页:预览 / 子任务 / 候选为通用页;其余为模式专属面板,由对应页面通过 portal 填充
export type PanelId = "changes" | "terminal" | "docs" | "todos";
export type InspectorTabId = "preview" | PanelId | "tasks" | "candidates";

export const MODES: Mode[] = ["chat", "work", "code"];

export const MODE_META: Record<Mode, { label: string; icon: LucideIcon; hint: string }> = {
  chat: { label: "Chat", icon: MessageCircle, hint: "对话、备考与资料整理" },
  work: { label: "Work", icon: ListChecks, hint: "文件、网页、文档与待办" },
  code: { label: "Code", icon: CodeXml, hint: "代码、终端、Git 与提交" },
};
