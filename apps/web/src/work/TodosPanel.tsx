import { useState } from "react";
import { CalendarDays, ChevronRight, FolderOpen, Plus, SquareCheckBig, Trash2, X } from "lucide-react";
import type { Todo } from "@xiyun/shared";
import { cn } from "../ui/cn.ts";
import { Checkbox, Notice, PanelEmpty, PanelHeader, SectionLabel, TextInput } from "../ui/panel.tsx";
import { Badge, Button, IconButton } from "../ui/primitives.tsx";

export interface TodosPanelProps {
  workspace: string;
  error: string;
  onDismissError: () => void;
  busy: boolean;
  todos: Todo[];
  title: string;
  onTitle: (v: string) => void;
  due: string;
  onDue: (v: string) => void;
  onAdd: () => void;
  onSetStatus: (id: string, done: boolean) => void;
  onDelete: (id: string) => void;
}

// 本地日期 YYYY-MM-DD,用于判断是否逾期
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function TodoRow({ todo, onSetStatus, onDelete }: { todo: Todo; onSetStatus: (done: boolean) => void; onDelete: () => void }) {
  const done = todo.status === "done";
  const overdue = !done && !!todo.due && todo.due < today();
  return (
    <li className="group flex items-start gap-2.5 rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-2">
      <Checkbox
        checked={done}
        onChange={(e) => onSetStatus(e.target.checked)}
        aria-label={done ? `标记为未完成:${todo.title}` : `标记为完成:${todo.title}`}
        className="mt-[3px]"
      />
      <div className="min-w-0 flex-1">
        <p className={cn("break-words text-ui leading-snug", done ? "text-subtle line-through" : "text-fg")}>{todo.title}</p>
        {(todo.due || todo.source) && (
          <p className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-subtle">
            {todo.due && (
              <span className={cn("inline-flex shrink-0 items-center gap-1 font-mono", overdue && "text-err")}>
                <CalendarDays size={11} strokeWidth={1.75} aria-hidden />
                {todo.due}
                {overdue && " 逾期"}
              </span>
            )}
            {todo.source && (
              <span className="min-w-0 truncate font-mono" title={todo.source}>
                来源:{todo.source}
              </span>
            )}
          </p>
        )}
      </div>
      <IconButton
        label="删除待办"
        size="xs"
        tone="danger"
        className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onDelete}
      >
        <Trash2 size={12} strokeWidth={1.75} />
      </IconButton>
    </li>
  );
}

// Work 模式"待办"面板:新增(标题 + 截止日期)、未完成 / 已完成分组
export function TodosPanel(props: TodosPanelProps) {
  const [showDone, setShowDone] = useState(false);
  const open = props.todos.filter((t) => t.status === "open");
  const done = props.todos.filter((t) => t.status === "done");

  const header = (
    <PanelHeader icon={SquareCheckBig} title="待办" meta={open.length > 0 && <Badge tone="accent">{open.length} 未完成</Badge>} />
  );

  if (!props.workspace) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <PanelEmpty icon={FolderOpen} title="尚未绑定工作目录" description="待办按工作目录归档。请先在主区顶部绑定工作目录。" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <form
        className="flex shrink-0 flex-col gap-1.5 border-b border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (props.title.trim()) props.onAdd();
        }}
      >
        <TextInput value={props.title} onChange={(e) => props.onTitle(e.target.value)} placeholder="添加待办事项" aria-label="待办事项" />
        <div className="flex items-center gap-1.5">
          <TextInput
            type="date"
            value={props.due}
            onChange={(e) => props.onDue(e.target.value)}
            aria-label="截止日期"
            className="h-7 w-auto flex-1 font-mono text-xs"
          />
          <Button type="submit" variant="primary" size="sm" disabled={props.busy || !props.title.trim()}>
            <Plus size={13} strokeWidth={2} />
            添加
          </Button>
        </div>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {props.error && (
          <Notice
            tone="err"
            className="m-1"
            action={
              <IconButton label="关闭" size="xs" onClick={props.onDismissError}>
                <X size={12} strokeWidth={1.75} />
              </IconButton>
            }
          >
            {props.error}
          </Notice>
        )}
        {props.todos.length === 0 ? (
          <PanelEmpty icon={SquareCheckBig} title="还没有待办" description="可以手动添加,也可以让助手从资料或对话中整理。" />
        ) : (
          <>
            {open.length === 0 ? (
              <p className="px-1.5 py-2 text-xs text-subtle">全部完成。</p>
            ) : (
              <ul className="flex flex-col">
                {open.map((t) => (
                  <TodoRow key={t.id} todo={t} onSetStatus={(d) => props.onSetStatus(t.id, d)} onDelete={() => props.onDelete(t.id)} />
                ))}
              </ul>
            )}
            {done.length > 0 && (
              <div className="mt-2 border-t border-line pt-1">
                <button
                  type="button"
                  aria-expanded={showDone}
                  onClick={() => setShowDone(!showDone)}
                  className="flex h-7 w-full items-center gap-1 px-1.5 text-left"
                >
                  <ChevronRight
                    size={12}
                    strokeWidth={1.75}
                    className={cn("text-subtle transition-transform duration-200", showDone && "rotate-90")}
                    aria-hidden
                  />
                  <SectionLabel className="flex-1">
                    已完成 <span className="font-mono tabular-nums">{done.length}</span>
                  </SectionLabel>
                </button>
                {showDone && (
                  <ul className="flex flex-col">
                    {done.map((t) => (
                      <TodoRow key={t.id} todo={t} onSetStatus={(d) => props.onSetStatus(t.id, d)} onDelete={() => props.onDelete(t.id)} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
