# Agent 工作台界面与流式协议设计

- 日期：2026-10-21
- 状态：待实现
- 范围：`packages/runtime`、`packages/shared`、`packages/server`、`apps/web`
- 决策依据：本轮确认的方案 A（结构化流块）、不做工具执行循环

## 1. 目标与约束

### 目标

把 Chat 从纯文本流升级为工作台形态：消息流中可渲染思考过程、工具调用卡片、正文与代码产物；Composer 支持 `@` 上下文引用与 `/` 内置命令；右侧预览面板可查看产物、工具详情与 Diff。

### 约束

- 保留现有业务逻辑与前端 API 方法签名（`api.ts` 中已有方法不变，仅 `streamChat` 增加可选回调）。
- 不引入 Tailwind、Framer Motion 或新的 UI 依赖；沿用原生 CSS 变量主题系统（`apps/web/src/theme.ts` 的 7 套预设）。
- 兼容旧数据与旧客户端：`messages` 旧记录、旧 SSE 事件形状继续有效。

### 非目标（本轮不做）

- 工具执行循环：Agent 不自主调用工具、不回灌工具结果。
- 按会话切换模型：模型下拉使用现有全局 `activateProvider`。
- token 用量统计：不请求 `stream_options`，不展示 token 计数。
- 改造 CodePage 为共享 Diff 组件：复用其底层 API `api.gitDiff` 即可。
- 前端自动化测试：前端无测试框架，本轮不引入。

## 2. 数据与事件协议

### 2.1 Provider 事件

`packages/runtime/src/index.ts` 新增：

```ts
export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_args"; id: string; delta: string }
  | { type: "tool_end"; id: string; args: string };
```

`ChatProvider` 增加可选方法：

```ts
streamEvents?(messages: ChatMessage[], opts?: ChatStreamOptions): AsyncIterable<ProviderEvent>;
```

- `createOpenAIProvider` 实现 `streamEvents`：
  - `choices[0].delta.content` → `{type:"text"}`。
  - `choices[0].delta.reasoning_content`（DeepSeek 风格）→ `{type:"thinking"}`。
  - `choices[0].delta.tool_calls[]`：首次出现时产出 `{type:"tool_start"}`，`function.arguments` 分片逐段产出 `{type:"tool_args"}`，流结束时产出 `{type:"tool_end"}`，`args` 为拼接后的原始 JSON 字符串。
- `streamChat` 保留原签名，实现为 `streamEvents` 的包装器，只透传 `text`。`extract.ts`、`memchat.ts`、`tasks.ts` 三个调用点不需要改动。

### 2.2 共享类型

`packages/shared/src/index.ts` 新增：

```ts
export type ChatBlock =
  | { id: string; kind: "thinking"; text: string; durationMs?: number }
  | {
      id: string;
      kind: "tool";
      name: string;
      args: unknown;
      status: "pending" | "success" | "error";
      target?: { workspace?: string; path?: string };
    }
  | { id: string; kind: "text"; text: string };
```

`ChatMessage` 增加可选字段 `blocks?: ChatBlock[]`。

### 2.3 SSE 事件（`POST /chat`）

在现有事件基础上增量扩展，旧事件形状不变：

```text
{ "delta": "..." }                                     // 正文增量，保留
{ "type": "block", "id": "...", "block": { "kind": "thinking" } }
{ "type": "block_delta", "id": "...", "delta": "..." } // thinking 与 tool args 增量
{ "type": "block_end", "id": "...", "meta": { "durationMs": 1234, "status": "pending" } }
{ "done": true }
{ "error": "..." }
```

规则：

- 正文仍同时发 `{delta}`，并作为 `kind:"text"` 块参与 `blocks` 顺序。
- `thinking` 块在首个 reasoning 增量到达时发 `block`，增量发 `block_delta`，结束时发 `block_end` 带耗时。
- `tool` 块：`tool_start` 发 `block`（含 `name`、`status:"pending"`），`tool_args` 发 `block_delta`，`tool_end` 发 `block_end`（`meta.status` 固定 `pending`，`args` 解析失败时 `meta.status:"error"` 且保留原始字符串）。本轮不执行工具。
- 未知 `type` 与坏 JSON 由客户端跳过；服务端不依赖客户端确认。

### 2.4 持久化

- `messages` 表新增 `blocks TEXT`（JSON）：新建库在 `CREATE TABLE` 中直接包含，已有库沿用 `db.ts` 现有 `pragma table_info` + `ALTER TABLE` 幂等迁移。
- `content` 继续存正文拼接结果；`blocks` 存完整有序块（含 text 块），保证回放时顺序可还原。
- `GET /sessions/:id/messages` 返回 `blocks`（JSON 解析后），旧记录为 `undefined`。

### 2.5 工具定义的门控

- 仅当 `provider.config.capabilities` 含 `"tools"` 时，`/chat` 才向模型传工具定义。
- 本轮工具定义限定为只读：`list_files`、`read_file`（复用 `workspace` 边界）；不传 shell/git 等写操作。
- 模型返回的 `tool_calls` 只展示为 `pending` 卡片，不执行。
- 已知上限：下一轮不把 `tool_calls` 回传给模型，模型不会记住上次的工具请求。

## 3. 前端设计

### 3.1 文件划分

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/web/src/chat/blocks.tsx` | 新增 | `MessageBody`、`ThinkingBlock`、`ToolBlock` |
| `apps/web/src/chat/Composer.tsx` | 新增 | 输入框、`@` 面板、`/` 菜单、模型下拉、发送/停止 |
| `apps/web/src/chat/PreviewPanel.tsx` | 新增 | 右栏产物/工具详情/终端/Diff |
| `apps/web/src/ChatPage.tsx` | 改造 | 事件状态机、历史回放、右栏联动 |
| `apps/web/src/App.tsx` | 改造 | aside 增加"预览"tab、`preview` 状态、向 ChatPage 传 `session` |
| `apps/web/src/api.ts` | 改造 | `streamChat` 增加可选 `onEvent`，原签名保留 |
| `apps/web/src/styles.css` | 改造 | 新组件样式，全部使用现有 CSS 变量 |

### 3.2 布局

沿用现有三栏 shell（左会话栏 / 中主区 / 右 aside），不推翻布局：

- 右 aside 保留"候选""子任务"，新增"预览"tab；窄窗口沿用现有浮层逻辑。
- Composer 固定在主区底部，不悬浮出内容区。

### 3.3 流式渲染

- 增量先写入 `ref`，用 `requestAnimationFrame` 合并为每帧最多一次 `setState`。
- 已完成消息用 `memo` 隔离，流式过程中不重解析历史消息。
- 仅当用户距底部小于 80px 时自动滚动。
- 代码块：自定义 `marked` renderer 输出 `<pre data-lang>`；挂载后按 DOM 文本节点拆分为 `.line` 包装，CSS counter 生成行号；代码块头部显示语言标签与复制按钮（容器事件委托）。
- `diff` 语言块使用 hljs `diff` 高亮；hljs 未加载该语言时回退纯文本，不影响复制与行号。

### 3.4 思考块（CoT）

- 折叠头：CSS 呼吸灯、"思考中"/"已思考"、耗时（等宽字体）。
- 流式中默认展开；`block_end` 后自动收起。用户手动展开后，本会话内不再自动收起。
- 正文使用 `--muted`、等宽小字号、限高滚动。

### 3.5 工具块

- 单行条：状态点 + 工具名（等宽）+ 参数摘要 + 状态文案（待执行/完成/错误）。
- 点击展开 Arguments（JSON）、Output、`target`。
- 右侧"在预览中查看"按钮写入 App 的 `preview` 状态并切换到"预览"tab。
- 跨页联动通过 `PreviewPanel` 调 `api.gitDiff(workspace)` 实现，不改造 CodePage。

### 3.6 Composer

- `@`：三源并行搜索——当前会话消息（本地）、`api.listFiles`、`api.workDocs`；任一远程源失败只减少该类结果并显示一行提示，不阻塞输入。选中后生成胶囊，输入框内以 `@[type:label]` 展示。
  - **引用展开**：发送时由客户端把引用展开为上下文，追加在用户消息末尾的 `# 引用上下文` 段：消息引用取前 200 字，文档引用取 `api.workDoc` 内容前 2000 字，文件引用仅注入相对路径（当前没有前端可用的文件读取接口）。展开后的文本随消息一起落库，模型可见。
- `/`：客户端内置命令表：
  - `/new`：新建会话（App 回调）。
  - `/export`：导出当前会话为 Markdown（客户端生成并下载）。
  - `/memory`：调用 `api.extract(sessionId)`。
- 模型下拉：`api.providers()` + `api.activateProvider(id)`，UI 注明"全局模型"。
- 发送/停止：沿用 `AbortController`；忙碌时发送按钮变为停止；`Esc` 中断保留。

### 3.7 预览面板

`preview` 状态：

```ts
type Preview =
  | { kind: "artifact"; title: string; body: string; lang?: string }
  | { kind: "tool"; title: string; args: unknown; output?: string }
  | { kind: "diff"; title: string; workspace: string; path?: string }
  | { kind: "terminal"; title: string; body: string }
  | null;
```

- `diff` 调用 `api.gitDiff(workspace)`；`terminal` 纯文本等宽；`artifact` 渲染 Markdown 或代码；`tool` 展示入参/输出。
- 空态提示："点击工具卡片或代码块查看详情"。

## 4. 错误处理与兼容

- 流中异常：发 `{error}`，不落库 assistant 消息；前端保留已流出内容并显示错误条，可重试。
- 用户中断：客户端关流，服务端不落库；前端删除空 assistant 气泡，保留已流出内容。
- 工具参数解析失败：`status:"error"`，`args` 存原始字符串，不阻断其余流。
- 事件容错：未知事件类型、坏 JSON 跳过。
- 旧数据：`blocks` 为 `NULL` 时按纯文本渲染。
- 自定义 Provider 无 `streamEvents`：`/chat` 回退到 `streamChat`，只输出正文。
- 旧客户端：忽略未知事件，`{delta}/{error}/{done}` 行为不变。

## 5. 测试与验收

### 自动化

- `packages/runtime/src/index.test.ts`（或现有测试文件）：合成 SSE 分片，覆盖 `reasoning_content` 跨 chunk、`tool_calls` 参数分片，断言 `streamEvents` 合并结果与 `streamChat` 只输出正文。
- `packages/server/src/chat-stream.test.ts`：假 Provider 依次产出 thinking/text/tool_call，断言 SSE 顺序与字段、`messages.blocks` 落库、无 `tools` capability 时不产生工具块、`{delta}` 仍存在。
- 全量检查：`pnpm test`、`pnpm typecheck`、`pnpm build` 通过。

### 手工验收

1. 思考流式出现，完成后自动收起并显示耗时。
2. 工具卡片 `pending` 状态，展开可见入参，点击"预览"右栏打开。
3. 代码块具备语言标签、复制、行号；`diff` 块高亮可读。
4. `@` 可检索消息/文件/文档并生成胶囊；`/new`、`/export`、`/memory` 生效。
5. 模型下拉切换后，下一条消息使用新 Provider。
6. 流式输出不抖动；用户上翻后不被抢滚动。
7. 打开无 `blocks` 的旧会话正常显示。
8. 中断、重试、编辑重发行为与改造前一致。

## 6. 记录更新

实现完成后按 `AGENTS.md` 更新：

- `NOW.md`：阶段进展、完成项、待验收。
- `MAP.md`：`apps/web/src/chat/` 新目录与运行时/服务端职责变化。
- `RUNBOOK.md`：若测试命令或构建步骤变化。
- `DECISIONS.md`：追加"SSE 结构化块协议"与"工具只展示不执行"两条决策。
- `RISKS.md`：记录 Provider 对 `reasoning_content`/`tool_calls` 支持不一致的风险。
