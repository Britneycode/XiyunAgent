import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUp,
  AtSign,
  Brain,
  Download,
  FileCode2,
  FileText,
  MessageSquareText,
  PenLine,
  Plus,
  Slash,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { SessionMeta, WorkDoc } from "@xiyun/shared";
import { api, type RefPayload } from "../api.ts";
import { cn } from "../ui/cn.ts";
import { Highlight, MenuGroupLabel, MenuItem, MenuList, PopoverSurface, useActiveIndex } from "../ui/menu.tsx";
import { Button, IconButton, Kbd, StatusDot } from "../ui/primitives.tsx";
import { ModelPicker, type ProviderOption } from "./ModelPicker.tsx";
import { TokenMeter } from "./TokenMeter.tsx";
import { contextBaseline, estimateTokens } from "./tokens.ts";
import type { UIMessage } from "./useChatStream.ts";

type RefItem = {
  key: string;
  refType: "message" | "doc" | "file";
  label: string;
  excerpt: string;
  detail?: string; // 文档 id 或文件路径
};

type CommandName = "new" | "export" | "memory";

const COMMANDS: Array<{ name: CommandName; desc: string; icon: LucideIcon }> = [
  { name: "new", desc: "新建会话", icon: Plus },
  { name: "export", desc: "导出当前会话为 Markdown", icon: Download },
  { name: "memory", desc: "从本会话提取记忆候选", icon: Brain },
];

const REF_ICON: Record<RefItem["refType"], LucideIcon> = {
  message: MessageSquareText,
  file: FileCode2,
  doc: FileText,
};

const REF_GROUP_LABEL: Record<RefItem["refType"], string> = {
  message: "消息",
  file: "文件",
  doc: "文档",
};

const MAX_CONTEXT = 8000;
const MAX_TEXTAREA_HEIGHT = 280;
const NOTE_TTL = 4000;

// 输入触发器:`@查询` 可出现在任意位置(前面是行首或空白);`/命令` 只在整段输入以 / 开头时生效。
type Trigger =
  | { kind: "at"; start: number; query: string }
  | { kind: "slash"; query: string; viaButton?: boolean };

function detectTrigger(value: string, caret: number, allowSlash: boolean): Trigger | null {
  const before = value.slice(0, caret);
  const at = /(^|\s)@([^\s@]{0,40})$/.exec(before);
  if (at) return { kind: "at", start: caret - at[2].length - 1, query: at[2] };
  if (allowSlash) {
    const slash = /^\/(\w*)$/.exec(value);
    if (slash && caret === value.length) return { kind: "slash", query: slash[1] };
  }
  return null;
}

const triggerKey = (t: Trigger | null) => (t ? (t.kind === "at" ? `at:${t.start}` : "slash") : null);

function download(name: string, body: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "text/markdown" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function splitPath(path: string): { base: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { base: path, dir: "" } : { base: path.slice(i + 1), dir: path.slice(0, i) };
}

export function Composer(props: {
  session: SessionMeta;
  busy: boolean;
  editingId: number | null;
  editText: string;
  onEditText: (v: string) => void;
  onCancelEdit: () => void;
  onSubmit: (text: string, o?: { context?: string; refs?: RefPayload[] }) => void;
  onStop: () => void;
  onNewSession?: () => void;
  onCandidatesChanged?: () => void;
  messages: UIMessage[];
}) {
  const [text, setText] = useState("");
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [docs, setDocs] = useState<WorkDoc[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourceNote, setSourceNote] = useState("");
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [activeId, setActiveId] = useState("");
  const [note, setNote] = useState<{ text: string; tone: "info" | "err" } | null>(null);
  const [focused, setFocused] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const suppressRef = useRef<string | null>(null); // Esc 关闭的触发器,同一锚点不再自动弹出
  const submittingRef = useRef(false);
  const menuId = useId();

  const editing = props.editingId != null;
  const value = editing ? props.editText : text;
  const setValue = (v: string) => (editing ? props.onEditText(v) : setText(v));

  // ---- 提示条:命令结果、截断提示等,数秒后自动消失 ----
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_TTL);
    return () => clearTimeout(t);
  }, [note]);
  const flash = (msg: string, tone: "info" | "err" = "info") => setNote({ text: msg, tone });

  // ---- 自适应高度:内容增长到上限后出现滚动条 ----
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [value]);

  // 程序化修改文本后恢复光标位置
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el || pendingCaret.current === null) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    el.setSelectionRange(pos, pos);
  });

  // 切换会话(组件重建)与进入编辑模式时聚焦输入框
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [props.editingId]);

  // ---- 全局模型 ----
  useEffect(() => {
    void api
      .providers()
      .then((ps) => {
        setProviders(
          ps.map((p) => ({
            id: p.id,
            name: p.name,
            model: p.model,
            baseUrl: p.baseUrl,
            contextLength: p.contextLength,
            capabilities: p.capabilities,
          })),
        );
        // 以服务端 active 为准,刷新后下拉与实际生效的 Provider 保持一致
        setActiveId(ps.find((p) => p.active)?.id ?? ps[0]?.id ?? "");
      })
      .catch(() => {});
  }, []);

  const switchModel = async (id: string) => {
    setActiveId(id);
    await api.activateProvider(id).catch(() => {});
  };

  // ---- `@` 引用源:菜单打开时并行拉取文件与文档,失败只减少一类结果 ----
  const atOpen = trigger?.kind === "at";
  useEffect(() => {
    if (!atOpen) return;
    let cancelled = false;
    const ws = props.session.workspace;
    const notes: string[] = [];
    setSourcesLoading(true);
    const fileP = ws
      ? api
          .listFiles(ws)
          .then((r) => !cancelled && setFiles(r.files))
          .catch(() => {
            notes.push("文件源不可用");
          })
      : Promise.resolve();
    const docP = api
      .workDocs(ws || undefined)
      .then((d) => !cancelled && setDocs(d))
      .catch(() => {
        notes.push("文档源不可用");
      });
    void Promise.all([fileP, docP]).then(() => {
      if (cancelled) return;
      setSourceNote(notes.join(" · "));
      setSourcesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [atOpen, props.session.workspace]);

  const atQuery = trigger?.kind === "at" ? trigger.query : "";

  const atGroups = useMemo(() => {
    if (!atOpen) return [];
    const q = atQuery.toLowerCase();
    const msgHits: RefItem[] = props.messages
      .filter((m) => m.role === "user" && m.content.toLowerCase().includes(q))
      .slice(-5)
      .map((m, i) => ({
        key: `m-${m.id ?? i}`,
        refType: "message" as const,
        label: m.content.slice(0, 20) || "(空消息)",
        excerpt: m.content.slice(0, 200),
      }));
    const fileHits: RefItem[] = files
      .filter((f) => f.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({ key: `f-${f}`, refType: "file" as const, label: f, excerpt: f, detail: f }));
    const docHits: RefItem[] = docs
      .filter((d) => d.title.toLowerCase().includes(q))
      .slice(0, 8)
      .map((d) => ({
        key: `d-${d.id}`,
        refType: "doc" as const,
        label: d.title,
        excerpt: d.content.slice(0, 80),
        detail: d.id,
      }));
    return [
      { type: "file" as const, items: fileHits },
      { type: "doc" as const, items: docHits },
      { type: "message" as const, items: msgHits },
    ].filter((g) => g.items.length > 0);
  }, [atOpen, atQuery, files, docs, props.messages]);

  const atFlat = useMemo(() => atGroups.flatMap((g) => g.items), [atGroups]);

  // ---- `/` 命令 ----
  const availableCommands = COMMANDS.filter((c) => c.name !== "new" || props.onNewSession);
  const commandItems =
    trigger?.kind === "slash" ? availableCommands.filter((c) => c.name.startsWith(trigger.query.toLowerCase())) : [];

  const menu: "at" | "slash" | null =
    trigger?.kind === "at" ? "at" : trigger?.kind === "slash" && commandItems.length > 0 ? "slash" : null;
  const menuCount = menu === "at" ? atFlat.length : menu === "slash" ? commandItems.length : 0;
  const nav = useActiveIndex(menuCount);

  const refreshTrigger = (v: string, caret: number) => {
    const t = detectTrigger(v, caret, !editing);
    const key = triggerKey(t);
    if (suppressRef.current && key !== suppressRef.current) suppressRef.current = null;
    const next = t && key !== suppressRef.current ? t : null;
    // 触发器或查询变化时活动项回到第一项
    if (triggerKey(trigger) !== triggerKey(next) || trigger?.query !== next?.query) nav.reset();
    setTrigger(next);
  };

  const dismissMenu = () => {
    suppressRef.current = triggerKey(trigger);
    setTrigger(null);
  };

  const addRef = (r: RefItem) => {
    setRefs((prev) => (prev.some((p) => p.key === r.key) ? prev : [...prev, r]));
    if (trigger?.kind === "at") {
      // 用引用胶囊替换输入中的 `@查询`
      const caret = taRef.current?.selectionStart ?? value.length;
      const end = Math.max(caret, trigger.start + 1 + trigger.query.length);
      setValue(value.slice(0, trigger.start) + value.slice(end));
      pendingCaret.current = trigger.start;
    }
    setTrigger(null);
    taRef.current?.focus();
  };

  const removeRef = (key: string) => {
    setRefs((prev) => prev.filter((x) => x.key !== key));
    taRef.current?.focus();
  };

  // 命令执行与原逻辑一致:只在非编辑态生效;返回 false 表示不是可执行命令,按普通消息发送
  const runCommand = (name: string): boolean => {
    if (name === "new" && props.onNewSession) {
      setText("");
      props.onNewSession();
      return true;
    }
    if (name === "export") {
      setText("");
      download(`${props.session.title}.md`, toMarkdown(props.session.title, props.messages));
      flash("已导出为 Markdown");
      return true;
    }
    if (name === "memory") {
      setText("");
      flash("正在提取记忆候选…");
      void api
        .extract(props.session.id)
        .then((r) => {
          flash(`已提取 ${r.candidates} 条候选`);
          props.onCandidatesChanged?.();
        })
        .catch((e) => flash(`提取失败:${e instanceof Error ? e.message : e}`, "err"));
      return true;
    }
    return false;
  };

  const pickCommand = (name: CommandName) => {
    setTrigger(null);
    if (props.busy) {
      flash("正在生成,完成后再执行命令");
      return;
    }
    // 通过按钮打开命令菜单时保留草稿;由输入 `/xx` 触发时 runCommand 会清空输入
    if (trigger?.kind === "slash" && trigger.viaButton && !/^\/\w*$/.test(text)) {
      const draft = text;
      runCommand(name);
      setText(draft);
      return;
    }
    runCommand(name);
  };

  const buildContext = async (): Promise<{ context: string; refs: RefPayload[] }> => {
    const parts: string[] = [];
    const payload: RefPayload[] = [];
    for (const r of refs) {
      let body = r.excerpt;
      if (r.refType === "doc" && r.detail) {
        body = await api
          .workDoc(r.detail)
          .then((d) => d.content.slice(0, 2000))
          .catch(() => r.excerpt);
      } else if (r.refType === "file" && r.detail && props.session.workspace) {
        // 提前取出路径:闭包内访问可选属性会丢失收窄
        const path = r.detail;
        body = await api
          .readFile(props.session.workspace, path)
          .then((d) => d.content.slice(0, 2000))
          .catch(() => path);
      }
      parts.push(`## ${r.label}\n${body}`);
      payload.push({ refType: r.refType, label: r.label, excerpt: r.excerpt.slice(0, 80) });
    }
    let context = parts.join("\n\n");
    if (context.length > MAX_CONTEXT) {
      context = context.slice(0, MAX_CONTEXT);
      flash("引用内容过长,已截断");
    }
    return { context, refs: payload };
  };

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || props.busy || submittingRef.current) return;
    // `/` 命令:只在开头且无引用时生效
    const cmd = /^\/(\w+)\s*$/.exec(trimmed);
    if (cmd && !editing && runCommand(cmd[1])) {
      setTrigger(null);
      return;
    }
    submittingRef.current = true;
    try {
      const built = await buildContext();
      setText("");
      setRefs([]);
      setTrigger(null);
      props.onSubmit(trimmed, refs.length ? { context: built.context, refs: built.refs } : undefined);
    } finally {
      submittingRef.current = false;
    }
  };

  // ---- 工具栏按钮 ----
  const openMention = () => {
    const el = taRef.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const needSpace = s > 0 && !/\s/.test(value[s - 1] ?? "");
    const insert = `${needSpace ? " " : ""}@`;
    setValue(value.slice(0, s) + insert + value.slice(e));
    pendingCaret.current = s + insert.length;
    suppressRef.current = null;
    nav.reset();
    setTrigger({ kind: "at", start: s + insert.length - 1, query: "" });
    el.focus();
  };

  const toggleCommands = () => {
    if (menu === "slash") {
      setTrigger(null);
      return;
    }
    suppressRef.current = null;
    nav.reset();
    setTrigger({ kind: "slash", query: "", viaButton: true });
    taRef.current?.focus();
  };

  // ---- 键盘 ----
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字中的 Enter/方向键交给输入法
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (menu) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        nav.move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        if (menu === "at" && atFlat[nav.index]) {
          e.preventDefault();
          addRef(atFlat[nav.index]);
          return;
        }
        if (menu === "slash" && commandItems[nav.index]) {
          e.preventDefault();
          pickCommand(commandItems[nav.index].name);
          return;
        }
      }
      if (e.key === "Escape") {
        // 不冒泡到窗口:避免同时触发"Esc 停止生成"
        e.preventDefault();
        e.stopPropagation();
        dismissMenu();
        return;
      }
    }

    if (e.key === "Escape" && editing && !props.busy) {
      e.preventDefault();
      props.onCancelEdit();
      return;
    }

    // 光标在最前且无选区时,Backspace 删除最后一个引用胶囊
    const el = e.currentTarget;
    if (e.key === "Backspace" && refs.length > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      setRefs((prev) => prev.slice(0, -1));
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (props.busy) {
        flash("正在生成,按 Esc 停止后再发送");
        return;
      }
      void submit();
    }
  };

  // ---- Token 计数:实测基线 + 估算增量 ----
  const baseline = useMemo(() => contextBaseline(props.messages), [props.messages]);
  const refsEstimate = useMemo(() => refs.reduce((n, r) => n + estimateTokens(r.excerpt), 0), [refs]);
  const draftEstimate = estimateTokens(value);
  const contextLength = providers.find((p) => p.id === activeId)?.contextLength;

  const canSend = value.trim().length > 0;
  const activeOptionId = menu && nav.index >= 0 ? `${menuId}-${nav.index}` : undefined;

  let flatIndex = -1;

  return (
    <div data-ui className="@container relative mx-auto w-full max-w-[792px] shrink-0 px-4 pb-2 pt-1">
      <AnimatePresence>
        {menu === "at" && (
          <PopoverSurface
            key="at"
            id={menuId}
            role="listbox"
            aria-label="引用上下文"
            className="absolute bottom-full left-4 right-4 mb-2 max-h-[360px] @[560px]:right-auto @[560px]:w-[440px]"
          >
            <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-3 text-2xs text-subtle">
              <AtSign size={12} strokeWidth={1.75} aria-hidden />
              <span>引用上下文</span>
              {atQuery && <span className="truncate font-mono text-fg">{atQuery}</span>}
              <span className="flex-1" />
              <span className="hidden items-center gap-1 @[400px]:flex">
                <Kbd>↑↓</Kbd> 选择 <Kbd>Enter</Kbd> 引用 <Kbd>Esc</Kbd> 关闭
              </span>
            </div>
            <MenuList activeIndex={nav.index}>
              {atGroups.map((g) => (
                <div key={g.type} role="group" aria-label={REF_GROUP_LABEL[g.type]}>
                  <MenuGroupLabel>{REF_GROUP_LABEL[g.type]}</MenuGroupLabel>
                  {g.items.map((r) => {
                    flatIndex += 1;
                    const i = flatIndex;
                    const { base, dir } = splitPath(r.label);
                    return (
                      <MenuItem
                        key={r.key}
                        id={`${menuId}-${i}`}
                        active={i === nav.index}
                        icon={REF_ICON[r.refType]}
                        mono={r.refType === "file"}
                        label={<Highlight text={r.refType === "file" ? base : r.label} query={atQuery} />}
                        detail={
                          r.refType === "file"
                            ? dir || undefined
                            : r.refType === "doc"
                              ? r.excerpt.replace(/\s+/g, " ") || undefined
                              : undefined
                        }
                        onHover={() => nav.setIndex(i)}
                        onSelect={() => addRef(r)}
                      />
                    );
                  })}
                </div>
              ))}
              {atFlat.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-subtle">
                  {sourcesLoading ? "正在加载文件与文档…" : "无匹配结果"}
                </div>
              )}
            </MenuList>
            {sourceNote && (
              <div className="shrink-0 border-t border-line px-3 py-1.5 font-mono text-2xs text-warn">{sourceNote}</div>
            )}
          </PopoverSurface>
        )}
        {menu === "slash" && (
          <PopoverSurface
            key="slash"
            id={menuId}
            role="listbox"
            aria-label="命令"
            className="absolute bottom-full left-4 right-4 mb-2 @[560px]:right-auto @[560px]:w-[360px]"
          >
            <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-3 text-2xs text-subtle">
              <Slash size={12} strokeWidth={1.75} aria-hidden />
              <span>命令</span>
              <span className="flex-1" />
              <span className="hidden items-center gap-1 @[400px]:flex">
                <Kbd>Enter</Kbd> 执行
              </span>
            </div>
            <MenuList activeIndex={nav.index}>
              {commandItems.map((c, i) => (
                <MenuItem
                  key={c.name}
                  id={`${menuId}-${i}`}
                  active={i === nav.index}
                  icon={c.icon}
                  label={
                    <span className="font-mono text-xs">
                      /<Highlight text={c.name} query={trigger?.kind === "slash" ? trigger.query : ""} />
                    </span>
                  }
                  trailing={<span className="truncate text-2xs text-subtle">{c.desc}</span>}
                  onHover={() => nav.setIndex(i)}
                  onSelect={() => pickCommand(c.name)}
                />
              ))}
            </MenuList>
          </PopoverSurface>
        )}
      </AnimatePresence>

      <div
        className={cn(
          "relative flex flex-col rounded-2xl border bg-elevated shadow-composer transition-[border-color,box-shadow] duration-150",
          focused ? "border-line-strong" : "border-line",
          editing && "border-accent/50",
        )}
      >
        <AnimatePresence initial={false}>
          {editing && (
            <motion.div
              key="editing"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="flex items-center gap-2 border-b border-line px-3.5 py-1.5 text-xs text-muted">
                <PenLine size={13} strokeWidth={1.75} className="shrink-0 text-accent" aria-hidden />
                <span className="min-w-0 flex-1 truncate">正在编辑消息 · 发送后将替换该条及其后的对话</span>
                <Button variant="ghost" size="xs" onClick={props.onCancelEdit}>
                  取消
                  <Kbd>Esc</Kbd>
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {refs.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5" aria-label="已引用的上下文">
            <AnimatePresence initial={false} mode="popLayout">
              {refs.map((r) => {
                const Icon = REF_ICON[r.refType];
                const shown = r.refType === "file" ? splitPath(r.label).base : r.label;
                return (
                  <motion.span
                    key={r.key}
                    layout
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.14 }}
                    title={r.label}
                    className="inline-flex h-6 max-w-[240px] items-center gap-1 rounded-md border border-line bg-surface pl-1.5 pr-0.5 text-xs text-fg"
                  >
                    <Icon size={12} strokeWidth={1.75} className="shrink-0 text-subtle" aria-hidden />
                    <span className={cn("truncate", r.refType === "file" && "font-mono text-2xs")}>{shown}</span>
                    <button
                      type="button"
                      aria-label={`移除引用 ${r.label}`}
                      onClick={() => removeRef(r.key)}
                      className="grid size-4 shrink-0 place-items-center rounded text-subtle transition-colors hover:bg-surface-3 hover:text-fg"
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  </motion.span>
                );
              })}
            </AnimatePresence>
          </div>
        )}

        <textarea
          ref={taRef}
          rows={1}
          value={value}
          role="combobox"
          aria-label="消息输入"
          aria-autocomplete="list"
          aria-expanded={menu !== null}
          aria-controls={menu ? menuId : undefined}
          aria-activedescendant={activeOptionId}
          onChange={(e) => {
            setValue(e.target.value);
            refreshTrigger(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) => {
            const el = e.currentTarget;
            if (el.selectionStart === el.selectionEnd) refreshTrigger(el.value, el.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // 点击浮层选项时 mousedown 已阻止失焦;真正失焦时收起菜单
            setTrigger(null);
          }}
          placeholder={
            editing
              ? "编辑消息,Enter 重新生成"
              : props.busy
                ? "正在生成… 可以继续输入下一条"
                : "输入消息,@ 引用上下文,/ 使用命令"
          }
          className="block min-h-[44px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 leading-6 text-fg outline-none placeholder:text-subtle"
        />

        <div className="flex items-center gap-0.5 px-2 pb-2 pt-1">
          <IconButton
            label="引用上下文"
            kbd="@"
            size="sm"
            active={menu === "at"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={openMention}
          >
            <AtSign size={15} strokeWidth={1.75} />
          </IconButton>
          {!editing && (
            <IconButton
              label="命令"
              kbd="/"
              size="sm"
              active={menu === "slash"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleCommands}
            >
              <Slash size={14} strokeWidth={1.75} />
            </IconButton>
          )}
          <span className="mx-1 h-4 w-px bg-line" aria-hidden />
          <ModelPicker
            providers={providers}
            activeId={activeId}
            disabled={props.busy}
            onSelect={(id) => void switchModel(id)}
          />
          <span className="flex-1" />
          <TokenMeter
            baseline={baseline}
            refs={refsEstimate}
            draft={draftEstimate}
            contextLength={contextLength}
          />
          <motion.button
            type="button"
            whileTap={{ scale: 0.9 }}
            aria-label={props.busy ? "停止生成" : editing ? "重新生成" : "发送"}
            title={props.busy ? "停止生成(Esc)" : editing ? "重新生成(Enter)" : "发送(Enter)"}
            disabled={!props.busy && !canSend}
            onMouseDown={(e) => e.preventDefault()}
            onClick={props.busy ? props.onStop : () => void submit()}
            className={cn(
              "relative ml-1 grid size-8 shrink-0 place-items-center overflow-hidden rounded-full transition-colors duration-150",
              props.busy
                ? "bg-fg text-canvas hover:bg-fg/85"
                : canSend
                  ? "bg-accent text-accent-fg hover:bg-accent/90"
                  : "bg-surface-3 text-subtle",
            )}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {props.busy ? (
                <motion.span
                  key="stop"
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={{ duration: 0.14 }}
                  className="grid place-items-center"
                >
                  <Square size={11} fill="currentColor" strokeWidth={0} />
                </motion.span>
              ) : (
                <motion.span
                  key="send"
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={{ duration: 0.14 }}
                  className="grid place-items-center"
                >
                  <ArrowUp size={16} strokeWidth={2.25} />
                </motion.span>
              )}
            </AnimatePresence>
          </motion.button>
        </div>
      </div>

      <div className="mt-1.5 flex h-4 items-center gap-3 px-1.5 text-2xs text-subtle">
        <AnimatePresence mode="wait" initial={false}>
          {note ? (
            <motion.span
              key={`note-${note.text}`}
              role="status"
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
              className={cn("truncate font-mono", note.tone === "err" ? "text-err" : "text-muted")}
            >
              {note.text}
            </motion.span>
          ) : (
            <motion.span
              key="hints"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
              className="hidden min-w-0 items-center gap-1 truncate @[480px]:flex"
            >
              <Kbd>Enter</Kbd> 发送
              <span className="mx-1 text-line-strong">·</span>
              <Kbd>Shift</Kbd>
              <Kbd>Enter</Kbd> 换行
              <span className="mx-1 text-line-strong">·</span>
              <Kbd>@</Kbd> 引用
              <span className="mx-1 text-line-strong">·</span>
              <Kbd>/</Kbd> 命令
            </motion.span>
          )}
        </AnimatePresence>
        <span className="flex-1" />
        {props.busy && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono" role="status">
            <StatusDot tone="accent" pulse />
            生成中
            <Kbd>Esc</Kbd>
            停止
          </span>
        )}
      </div>
    </div>
  );
}

// 导出格式:正文原样;thinking 引用块;tool 单行;ref 引用标记;aborted 标注
function toMarkdown(title: string, messages: UIMessage[]): string {
  const out: string[] = [`# ${title}`, ""];
  for (const m of messages) {
    out.push(`## ${m.role === "user" ? "用户" : "助手"}`, "");
    // 带 refs 的 user 消息 content 存原话、blocks 只有 ref 块,正文必须始终取自 content
    const blocks =
      m.role === "user"
        ? [{ id: "", kind: "text" as const, text: m.content }, ...(m.blocks ?? [])]
        : m.blocks?.length
          ? m.blocks
          : [{ id: "", kind: "text" as const, text: m.content }];
    for (const b of blocks) {
      if (b.kind === "text") out.push(b.text, "");
      else if (b.kind === "ref") out.push(`> @${b.label}`, "");
      else if (b.kind === "thinking") {
        out.push(`> 思考（${((b.durationMs ?? 0) / 1000).toFixed(1)}s）`);
        out.push(...b.text.split("\n").map((l) => `> ${l}`), "");
      } else if (b.kind === "tool") out.push(`\`${b.name}(${b.rawArgs})\``, "");
    }
    if (m.aborted) out.push("（已中断）", "");
  }
  return out.join("\n");
}
