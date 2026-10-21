# 设计决策

## D-001：以 Pi 作为运行时

XiyunAgent 使用 Pi 提供模型适配、Agent Loop 和工具运行基础；Pi 先作为依赖或 workspace package，不直接 Fork。这样可以保持自己的产品层，同时降低上游合并成本。

## D-002：三种模式

产品固定为 `Chat`、`Work`、`Code`。会话固定模式和工作区，跨模式使用任务交接摘要，避免权限和上下文边界混乱。

## D-003：主 Agent 与子智能体分工

主 Agent 负责意图、人格、调度和汇总。子智能体按角色使用模型池，最多三个并行；子智能体不能直接写长期记忆。

## D-004：记忆四层模型

规则、事实、事件和索引分开保存。规则文件优先于自动记忆；事实保留来源、置信度和有效时间，更新时结束旧事实的有效期。

## D-005：本地优先

第一版单用户、本机运行、默认不登录、不云同步。支持自定义数据目录、加密导出和恢复。

## D-006：Skill 与插件分离

Skill 表达工作流程和提示；插件注册工具、Provider、页面、路由或后台任务。插件安装和启用分开，远程脚本默认不执行。

## D-007：设置和主题

设置页借鉴 OpenHanako 的分区与体验，支持浅色、深色、系统主题、主题色、普通字体、代码字体、字号、行距、密度以及主题导入导出。

## D-008：打包运行策略（2026-10-06）

开发态 Server 用系统 Node 24 直接运行 TypeScript 源码。打包态用 esbuild 把 `packages/server/src/index.ts` 打成单文件 `apps/desktop/server.mjs`，由 Electron 内置 Node（加 `--experimental-sqlite`）运行，Electron 以 `ELECTRON_RUN_AS_NODE` 方式复用，不要求用户安装 Node。打包应用的数据目录指向 `%APPDATA%\XiyunAgent`（`XIYUN_DATA_DIR`），安装目录保持只读。桌面端启动时先探测 `/health`，已有 Server 则不重复拉起。

## D-009:子智能体模型路由策略(2026-10-07)

子任务严格按角色标签解析模型,未绑定即失败,不自动回退未授权模型(验收要求);临时覆盖需显式 `providerId`。同角色内已授权模型构成回退链(`byRoleAll`),依次尝试执行;仅当同角色全部模型失败时才标记任务失败。例外:记忆提取流水线允许 `memory -> main -> 激活 Provider` 的回退链,因为它在后台运行、失败只记事件,不直接影响用户请求。`ModelRole` 在原能力标签(main/subagent/vision/memory/embedding)上扩展 coder/reviewer/tester/researcher/tutor 作为绑定标签。

## D-010:子智能体用户交互节点(2026-10-07)

子智能体可通过结构化结果中的 `question` 字段向用户请求补充信息。任务进入 `waiting_for_user` 状态,在 Web 任务面板显示提问内容和回答输入框;用户提交回答后通过 `POST /tasks/:id/resume` 恢复执行,回答作为 `extraContext` 注入子智能体 prompt。此机制避免子智能体因信息不足而失败,同时保持任务的可审计性(提问和回答均落库)。

## D-011:Chat SSE 结构化块协议(2026-10-21)

/chat 流式响应从纯文本 token 升级为结构化块:text 块带稳定 id 增量下发,`block_end` 事件携带该块完整快照,思考(reasoning)与工具调用独立成块。客户端按 id 合块渲染,rAF 合批减抖动。取舍:协议与前端渲染耦合加深,换来思考链/工具卡片/耗时等 UI 所需的一手数据;旧纯文本形态由服务端兜底(无块时 content 字段仍是完整文本)。

## D-012:主对话工具只展示不执行(2026-10-21)

/chat 不向模型自动下发工具定义;仅当 `XIYUN_EXPOSE_TOOLS=1` 且 Provider 声明 tools 能力且会话绑定工作区时,下发只读工具子集。模型返回 tool_calls 后前端渲染工具卡片(状态/参数/耗时),不进入执行循环。取舍:主对话不具备 Code 模式 ```tool 循环的执行能力,换取主对话行为的可预期性与权限边界的清晰;执行型工具调用仍归 Code 模式子智能体。

## D-013:/chat 选模型以激活 Provider 优先(2026-10-21)

主对话未显式指定 providerId 时,取激活 Provider(`activeProviderId` 或列表首个),不使用角色回退链。取舍:用户在设置页切换激活 Provider 即切换主对话模型,符合直觉;代价是主对话无多模型容错(失败即报错,前端提供重试)。

## D-014:用户中断落半截回复并标记 aborted(2026-10-21)

停止生成时,已产出的内容(含已完成块)原样落库,消息标记 `aborted`,UI 显示"已中断"。取舍:保留半截回复供参考与导出,而非丢弃;regenerate 走既有"删上一条 assistant 重生成"路径,半截消息不残留。竞态说明:服务端可能已完成落库并发 `done` 后客户端 abort 才到达,此时 UI 显示"已中断"而库中 `aborted=0`;内容不丢,刷新后标记消失,属良性竞态。

## D-015:引用上下文与记忆链路隔离(2026-10-21)

Composer 的 @ 引用(文件/文档)内容只注入当次 /chat 请求的 context,不写入消息正文、不进入记忆提取链路;落库 blocks 仅保存引用元数据(kind/label/path),不保存引用内容。取舍:引用内容不进长期记忆,避免大段文件内容污染记忆库;代价是历史消息重新渲染时引用只显示胶囊,不还原内容。

## D-016:Token 用量以模型实测为准,估算只做增量(2026-10-21)

/chat 请求默认携带 `stream_options.include_usage`,模型在流末返回的 usage 归一化为 `TokenUsage`(输入/输出/合计,可选缓存命中与推理),经 SSE `{type:"usage"}` 事件在 `done` 之前下发,并随 assistant 消息落库(messages v6 迁移新增 `usage` 列;分支/导出/导入全链路携带)。网关以 400/422 拒绝该参数时去掉重试一次,成功后按 baseUrl+model 在进程内记住、不再携带。前端以最近一次实测为基线(输入 + 输出 − 推理,即下一轮会再次带入的部分),基线之后的新消息、引用与当前输入按本地经验比例估算叠加;会话中从未拿到实测时整体退回估算并以 "≈" 标注。取舍:实测值包含系统提示、记忆与引用,比纯估算准确;代价是严格网关首个请求多一次往返,且中断的回复通常拿不到用量(usage 在最后一个分片)。

## D-017:工作台 UI 只改视图层,面板经 Portal 挂到右侧检查器(2026-10-21)

Qoder 风格重构(feat/qoder-workbench-ui)只替换视图层:API、SSE 协议、`useChatStream` 对外接口与各页业务逻辑保持不变。Code/Work 页把"变更 / 终端 / 资料 / 待办"面板通过 `layout/inspectorBridge.tsx` 的 InspectorPortal 渲染进右侧检查器的对应 tab,状态仍归页面所有(切换 tab 不丢输入,未挂载时不请求 Diff)。流式 Markdown 按顶层块切分并逐块 memo(`chat/StreamingMarkdown.tsx`),只有尾块随增量重渲染;未闭合代码块与完成态共用同一外框和限高,闭合时不跳动。Markdown 代码块是静态 HTML,复制 / 换行 / 展开 / 送预览通过事件委托(`chat/codeActions.ts`)把状态写在 DOM 上。取舍:Portal 让面板与页面状态同生命周期,代价是检查器内容依赖页面挂载;代码块不走 React 组件,换来流式时零额外渲染,代价是按钮状态不进 React state。

## D-018:生成出错保留半截,Provider 错误可读且首 token 前自动重试(2026-10-21)

/chat 在 Provider 报错(非用户中断)时,已产出的内容按 D-014 的方式落库,但标记 `error`(messages v7 迁移新增 `error` 列,分支/导出/导入携带),SSE 的 error 事件带回 `messageId` 与 `userMessageId`;出错前没有任何内容时不落 assistant。例外:regenerate 失败时,若末条是一条完整回答(非中断、非出错),不覆盖它,宁可保留旧答案;末条本身是出错半截时照常替换,不累积。SSE 首个事件 `{type:"meta", userMessageId}` 下发本轮 user 消息 id,前端 `applyStream` 在 meta/done/error 时把落库 id 回填到气泡(新发出的消息无需刷新即可编辑、分支;气泡用 `localKey` 作 React key,回填 id 不重挂载)。runtime 抛 `ProviderError`:状态码 + 中文原因提示 + 服务端原文(API Key / Bearer 凭据脱敏,HTML 错误页只取标题,截断 300 字);只在拿到响应流之前重试 408/429/5xx/529 与网络层错误,默认 2 次指数退避,遵守 Retry-After(超过 20s 不等直接报错),额度耗尽不重试;流式读取 5 分钟无数据主动断开;HTTP 200 后流内下发的 error 对象抛错而非静默结束成空回复。取舍:流开始后不重试,避免重复计费与内容错乱,由用户在出错气泡上点「重试」;中断(用户停止)时客户端收不到 done,assistant 半截的 id 仍需刷新后才有(user 消息 id 已由 meta 事件提前拿到)。
