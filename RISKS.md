# 风险登记

## R-001：Pi 上游接口变化

**影响**：运行时适配层可能需要调整。

**触发条件**：Pi 的包结构、Agent Loop 或 Provider 接口发生破坏性变化。

**处理**：集中在 `packages/runtime/` 封装；锁定版本；升级前运行最小 Chat 验收。

## R-002：第三方模型接收客户资料

**影响**：客户代码、文档或密钥可能被错误外发。

**触发条件**：Work/Code 调用外部模型、插件或网页工具。

**处理**：按工作区控制；显示文件范围；默认脱敏；高风险外发必须确认；审计记录脱敏摘要。

## R-003：Electron 与本地 Server 权限边界

**影响**：网页或插件可能获得超出预期的本地能力。

**触发条件**：新增 IPC、局域网监听、外部网页或 full-access 插件。

**处理**：默认回环监听；最小 IPC；插件声明权限；工作区路径守卫；新增高权限能力时更新本文件。

## R-004：自动记忆错误

**影响**：错误事实影响后续回答或项目操作。

**触发条件**：模型从闲聊或不完整上下文推断事实。

**处理**：记录来源和置信度；低置信度只参与检索；高价值候选提示确认；支持“彻底忘记”。

## R-005：Windows 工具差异

**影响**：PowerShell、Git Bash、WSL 的命令和路径行为不一致。

**触发条件**：Code 模式跨 Shell 执行命令或访问路径。

**处理**：记录 shell 类型和工作目录；执行前展示实际命令；按 shell 分别测试；默认限制在当前工作区。

## R-006：打包态 Server 依赖 Electron 内置 Node 的实验特性

**影响**：Electron 升级后 `--experimental-sqlite` 或 `node:sqlite` 行为变化，安装包内 Server 无法启动。

**触发条件**：Electron 大版本升级、Node 内置 SQLite 特性调整。

**处理**：每次 `pnpm dist` 后对 `win-unpacked` 做冒烟验收（窗口出现且 `/health` 返回 200）；失败时优先核对标志兼容性，必要时改用独立打包的 SQLite 依赖。

## R-007：shell 工具可读取工作区外文件 [已修复 2026-10-07]

**影响**：PathGuard 只拦截 `/tools/read`、`/tools/write`；shell 工具仅把 cwd 限制在工作区内，`cat`、`Get-Content` 等读命令带工作区外路径即可读出文件内容，且按 safe/confirm 分类可能免确认。与 RUNBOOK「高风险操作验收：工作区外路径须确认或拒绝」存在差距。

**触发条件**：Code 模式下子智能体（或 `/tools/shell` 直接调用）执行带工作区外路径的读命令。2026-10-07 验收实测确认：`cat D:/<仓库外>/package.json` 经 Git Bash 返回文件全文、exitCode 0。

**处理**（已采用参数路径校验）：`classifyCommand` 新增 `OUTSIDE_PATH_RE`——命令参数中出现盘符(`D:/`)、POSIX 绝对路径(`/`)、`~/`、`..` 时，即使是白名单命令也升级为 confirm 级（前端弹确认条）；相对路径读文件仍免确认。已知边界：Git Bash `/c/...` 与 Windows 盘符无法互相解析，统一按"需确认"处理而不精确判定越界；deny 级命令不受影响。回归测试见 `tools.test.ts`。

## R-008：Provider 对思考/工具字段支持不一

**影响**：OpenAI-compatible 解析依赖 `reasoning_content`/`reasoning`/`tool_calls` 字段，不同 Provider（或代理层）字段名与形态不一致时，思考块不出现或工具卡片缺失，主对话退化为纯文本。

**触发条件**：接入非标准 OpenAI 兼容 Provider 或经网关改写响应。

**处理**：退化形态可正常使用（content 兜底）；接入新 Provider 时用一条含推理的提问实测流式事件，必要时在 runtime 的解析层补字段映射。

## R-009：正文内 `<think>` 标签不解析

**影响**：模型把思考过程以 `<think>...</think>` 写在正文（而非 reasoning 字段）时，标签按正文 Markdown 原文显示，不产生思考块。

**触发条件**：使用将思考写进正文的模型（部分开源模型的默认行为）。

**处理**：当前不做正文标签解析（解析会与 Markdown 渲染的转义约束冲突）；如出现此类模型接入需求，在 runtime 解析层把 `<think>` 段转为 thinking 块，不在前端做。

## R-010：开启工具下发后模型可能反复请求同一工具

**影响**：`XIYUN_EXPOSE_TOOLS=1` 时主对话无执行循环，模型拿不到工具结果可能在同一轮反复发起相同 tool_calls，产生连续工具卡片直到回复结束。

**触发条件**：开启开关且模型强烈依赖工具结果作答。

**处理**：开关默认关闭；需要执行型工具调用时使用 Code 模式（有 ≤5 轮执行循环）。若后续要支持主对话执行循环，需先设计权限与确认交互，不临时放开。

## R-011：Markdown 原始 HTML 转义约束

**影响**：`apps/web/src/chat/markdown.ts` 的 renderMarkdown 依赖"原始 HTML 一律 escapeHtml + 图片/链接属性全转义"防注入；后续改动 renderer（新增覆写、升级 marked、放行某些标签）可能静默打开注入面。

**触发条件**：修改 markdown.ts 渲染链或升级 vendor 依赖。

**处理**：改动 renderMarkdown 时必须保持：HTML 注解标签不解析、image 的 href/text/title 与 code 内容全过 escapeHtml；新增任何 dangerouslySetInnerHTML 使用点需说明输入来源。既有遗留：链接 href 不过滤 `javascript:` 协议（2026-10-21 裁决不修，如需处理应在 link renderer 做协议白名单）。
