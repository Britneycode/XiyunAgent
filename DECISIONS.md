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

## D-019:规则与 Skill 兼容生态格式,会话按最近活动排序并自动命名(2026-10-21)

规则层(D-004 第一层)在 全局 → 模式 之后依次加载:用户级 `~/.claude/CLAUDE.md`(仅 Code 模式,避免把编码偏好带进 Chat / Work)→ 项目根 `AGENTS.md`、`CLAUDE.md`、`.cursorrules`、`.github/copilot-instructions.md` → `.cursor/rules/**/*.mdc` 与 `.github/instructions/*.instructions.md`(frontmatter:`alwaysApply: true` 或 globs/applyTo 为 `**` 时总是加载;globs/applyTo 只在本轮 @ 引用的文件命中时加载;只有 description 的列入"按需规则"索引,不注入正文)→ 被引用文件各级祖先目录的 `AGENTS.md` / `CLAUDE.md`(由浅到深)→ `CLAUDE.local.md`。后加载的优先级更高。规则正文中的 `@路径`(代码块与行内代码除外)展开为 `### 导入:路径` 附在该文件后,相对所在文件解析,`~/` 按用户目录解析;解析结果必须仍在该文件所属根目录内(项目规则不能导入用户目录文件,防止把 `~/.ssh` 之类带进提示词),按真实路径判定以挡住软链接越界,最多 5 层并防环。同一路径或同样内容只注入一次;单文件 20k 字截断,总量超过 60k 字时省略靠后的文件并注明。引用文件随 /chat 的 file ref 以 `path` 字段上传。取舍:不实现 Cursor 的"模型自选规则"(Agent Requested),只给索引;frontmatter 用自带的极简解析器(`frontmatter.ts`),不引入 YAML 依赖,嵌套映射忽略。

Skill:目录或 ZIP 只有 `SKILL.md` 时,从 frontmatter 的 name / description(可选 version、modes、roles)合成 manifest,id 依次取 slug(name)、slug(目录名 / ZIP 文件名),都不合法时用名称哈希;有 `skill.json` 仍以它为准,缺 description 时用 frontmatter 补。ZIP 根目录识别也认 SKILL.md,并跳过 `__MACOSX`。静态检查递归子目录(≤4 层、≤200 项)。注入去掉 frontmatter;启用 Skill 正文合计 ≤12k 字时与原来一样全量注入,超出时改为渐进注入:先列出全部 Skill 的"名称(id):用途",再按相关度附全文(消息点名 name / id 直接命中;否则 ASCII 词与中文二元组重合 ≥2),受同一预算限制。主对话以用户原话、子智能体以任务 prompt 作为相关度依据。

会话:sessions v8 迁移加 `updated_at`,老会话回填为最后一条消息时间;user 消息与 assistant 回复落库时刷新,`GET /sessions` 按 `COALESCE(updated_at, created_at)` 倒序,返回 `updatedAt`,列表分组与时间按它显示;导入旧导出包时同样回填。重命名不算活动。标题仍为默认"新会话"时,首条消息落库即写入启发式标题(首行去 Markdown,30 字截断);消息较长(>20 字或多行)且配置了模型时,用记忆提取同一个模型异步起短标题(20s 超时),只在标题仍是该启发式标题时覆盖,流未关闭就推 `{type:"title"}`;回复结束后最多再等 1.5s,超时只落库,下次刷新列表可见。前端在 meta / title 事件时刷新会话列表。

前端:未发送草稿(文本 + 引用)按会话存 localStorage `xiyun.drafts`,保留最近 30 个会话,随改随存,发送后删除;编辑旧消息的文本不进草稿。快捷键以 `apps/web/src/shortcuts.ts` 为清单(Ctrl+/ 面板据此渲染),新增 Ctrl+Shift+O / S / C / ;、Shift+Esc、空输入框 ↑;`useHotkey` 同时匹配 `e.code`,Shift 会改变符号键 `e.key` 的键用 code 名注册。取舍:网页版里 Ctrl+Shift+O 等可能被浏览器先占用,桌面版(Electron)不受影响。

## D-020:生成与 HTTP 连接解耦(运行注册表),消息全文搜索(2026-10-21)

生成:`/chat` 不再把生成绑定在这次 HTTP 请求上。服务端 `RunRegistry`(`runs.ts`)为每次生成建一个 Run,生成在后台执行,事件按序号缓存(上限 5 万条),SSE 响应只是订阅者:关窗、切会话、刷新页面、网络抖动都不会中止生成。停止只走 `POST /runs/:id/cancel`(会话被删除时也会取消)。同一会话同时只允许一个运行,再发返回 409。`GET /runs/:id/events?after=` 或 `Last-Event-ID` 从指定序号回放;前端断线后按 1s/2s/4s 自动续订最多 3 次,回到会话时用 `GET /sessions/:id/active-run` 查到运行中的生成并接着显示。运行结束后保留 5 分钟供补齐回放再回收。`GET /sessions` 返回 `running`,侧栏把该会话的时间换成转圈;有运行中的会话时前端每 2s 查一次 `GET /runs`,有会话结束就刷新列表。meta 事件带回 `runId`;取消时推 `{type:"cancelled"}`。取舍:运行只在内存里,服务重启时未完成的生成丢失(已落库的 user 消息保留);不做多端同时编辑同一会话的冲突处理。

搜索:sessions v9 迁移建 `messages_fts`(FTS5,trigram 分词,中英文都按子串匹配),插入 / 更新 / 删除触发器同步,建表时回填已有消息。`GET /search?q=&mode=&limit=&archived=all` 只搜 user / assistant 消息,默认排除已归档会话;每个词都 ≥3 个字符时走 FTS(词加引号按短语、词间 AND,按 bm25 排序),有更短的词时退回 LIKE 子串匹配(按新到旧)。片段的命中词用 \u0001 / \u0002 包住,前端拆成 `<mark>`,不拼 HTML。命中带完整会话信息,所以不在已加载分页里的会话也能直接打开。侧栏搜索框输入 ≥2 个字符、停顿 250ms 后在会话标题结果下方列出"消息内容",点击打开对应会话并滚到该消息、短暂高亮。取舍:trigram 索引会让库文件变大(约为消息文本的 2~3 倍);两个字的中文词走 LIKE 全表扫描,本地单用户数据量下可接受。

## D-021:Provider 按协议适配(OpenAI 兼容 / Anthropic / Gemini),模型按会话选择(2026-10-21)

协议:`ProviderConfig` 增加 `protocol`(缺省 openai,老配置不变)、`models`(可选模型列表,每项可单独设上下文长度与能力)、`headers` / `query`(附加请求头与查询参数,值里的 `{apiKey}` 在请求时替换;自定义了鉴权头时不再发默认鉴权头,Azure 即 `api-key: {apiKey}` + `api-version`)、`params`(temperature / maxTokens / reasoningEffort)。`model` 字段保留为默认模型,不另起 `defaultModel`,老的 config.json 无需迁移;`modelsOf()` 把默认模型放首位并继承 Provider 级上下文与能力,`withModel()` 选定模型(不在列表里回退默认)。runtime 拆出 `http.ts`(错误归一化、首 token 前重试、SSE 逐行读取、URL / 头拼装),`createProvider()` 按协议分发到适配器:anthropic 走 `/v1/messages`(x-api-key + anthropic-version,system 顶层,相邻同角色合并、首条补 user,max_tokens 缺省 8192;reasoningEffort 换算成 thinking 预算 2k/8k/24k,此时不发 temperature),content_block / message_delta 映射成统一事件,缓存读命中计入 cachedTokens;gemini 走 `models/{model}:streamGenerateContent?alt=sse`(x-goog-api-key,systemInstruction,assistant→model,思考预算同上,工具 schema 去掉 Gemini 不认的关键字)。三种协议都支持 `listModels()`,`GET /providers/:id/models` 供设置页"获取模型列表"。附加头回显时掩码(引用 `{apiKey}` 的除外),保存掩码值时保留原值。

会话模型:sessions v10 迁移加 `provider_id` / `model`(NULL = 跟随全局),messages 加 `model`。`/chat` 的模型优先级为 请求体 providerId/model > 会话设置 > 全局激活(D-013)> main 角色;会话指向的 Provider 已删除时回退全局。assistant 消息落库记录所用模型,meta 事件带回 `model`,气泡底部显示。`PATCH /sessions/:id {providerId, model}`,providerId 为 null 恢复跟随全局;分支会话、导出 / 导入都带上这些字段。前端输入框的模型下拉从"切全局"改为"本会话模型",首项"跟随全局默认",会话单独指定时按钮带小圆点;全局默认仍在设置页"设为默认"。末条回复多一个"换个模型重新生成"按钮,只影响这一次,不改会话设置。取舍:标题生成、记忆提取、子智能体仍按角色 / 全局选模型,不跟随会话;per-model 参数(温度等)暂时只到 Provider 级。

## D-022:消息改为树结构(编辑 / 重新生成保留旧版本),历史按 token 预算装入并滚动摘要(2026-10-21)

消息树:messages v11 迁移加 `parent_id`(首条为 NULL),sessions 加 `head_id`(当前分支末条);老会话按 id 顺序回填成单链,head 为最后一条。会话展示和发给模型的历史都是从 head 沿 parent 回溯到根的路径(`tree.ts`)。新消息挂在 head 下;`/chat` 带 `editOf`(user 消息 id)时新 user 消息作为它的兄弟,原消息和它后面的回复保留;regenerate 取当前分支末尾的 user 消息(原文与引用都从库里取,请求体的 message 可省略),新回复作为旧回复的兄弟。例外:旧回复本身是出错半截(且没有后续)时直接替换,不累积失败版本;D-018 的"regenerate 失败不覆盖完整旧回答"由兄弟版本自然满足,失败的半截也作为新版本保留,可切回旧回答。落库后 head 移到新消息。`GET /sessions/:id/messages` 只返回当前路径,每条带 `parentId`,同一父消息下有多个版本时带 `siblings`(升序 id);`POST /sessions/:id/head {messageId}` 切分支:消息已在当前路径上不变,否则落到它下面最新的末端(沿最大 id 的子消息往下),生成中返回 409。删除 `/messages/:mid/truncate`。分支会话复制当前路径(或指定消息的祖先链)并重新串成单链;导出包升到 v2,消息带 `id` / `parent_id` / `ref_context` / `ctx_trim`,会话带 `head_id` 与摘要,导入时重映射 id;v1 包没有 id,按会话内顺序串成单链。head 为空且所有消息都没有 parent 的会话(外部直接写库)按 id 顺序视为单链,第一次写入时就地补齐。记忆提取的最近 12 条也只取当前分支。前端:气泡上"‹ i/n ›"切换版本(常显,生成中禁用);编辑直接发送新版本,不再先截断;生成结束后拉一次消息列表补上版本信息(`mergeTree`,只更新 parentId / siblings / trim,保留 localKey);搜索命中不在当前分支上的消息时先切到该分支再定位。

上下文预算:历史不再固定取最近 20 条。预算 = 上下文长度(所选模型的 `contextLength`,未配置按 32k)× 0.8 − 回复预留(`params.maxTokens`,缺省 4096)− 系统提示 − 本轮消息;沿路径从新到旧装入,assistant 有实测用量时以输出 tokens(扣除推理部分)计,否则用与前端相同的估算(`estimateTokens` 移到 shared);空消息跳过,装入的历史保证从 user 开始。有消息装不下时:会话的滚动摘要(sessions `summary` / `summary_upto_id`,覆盖点必须在当前路径上才有效)作为"早先对话摘要"并入系统提示,预算相应扣减;回复完成后若有未被摘要覆盖的被裁剪消息,后台用记忆提取同一个模型把它们并入摘要(单次输入 ≤24k 字,超出时先摘要最早的一段,之后几轮继续补齐;同一会话同时只跑一个;失败不影响对话)。本轮的裁剪情况 `{dropped, summary}` 随 meta 事件下发并落到 assistant 的 `ctx_trim`,气泡底部显示"摘要 / 省略 N 条"。引用上下文:user 消息落库时保存 `ref_context`(引用原文),文件引用块记录当时文件内容的 sha256 前 16 位;之后构造历史时,最近 3 条带引用的 user 消息重新附上引用上下文,文件指纹变了就注明"在引用之后已修改,内容可能过时"。重新生成沿用库里的引用上下文;编辑时没带新引用则沿用原消息的引用。取舍:token 是估算值,所以只用窗口的 80%;摘要只有一份(跟随最近一次需要摘要的分支),切到另一分支时覆盖点不在路径上就视为无效并重新生成;摘要生成会额外消耗一次模型调用,只在历史确实超出预算时发生。

