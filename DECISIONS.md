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

## D-023:消息附件(图片 / 文本文件),从 ChatGPT / Claude 导入历史对话(2026-10-21)

附件:`POST /attachments`(multipart 字段 `file`)上传,返回 `{id, name, mime, size, kind}`;发送时 `/chat` 带 `attachments: id[]`(≤8),有附件时 `message` 可以为空。存储按内容寻址:id = sha256,文件放 `<dataDir>/attachments/<id>`,元信息在 `attachments` 表,同内容只存一份。类型按内容判定,不信任文件名和声明类型:文件头是 PNG / JPEG / GIF / WebP 的算图片(≤10MB);否则扩展名或类型像文本、能按 UTF-8 严格解码且不含 NUL 的算文本(≤1MB,统一以 text/plain 保存与返回);其余 415。`GET /attachments/:id` 只接受 64 位十六进制 id,带 `nosniff`,文本一律按纯文本返回,避免把上传的 HTML / SVG 当页面执行。user 消息的 blocks 里记录 `attachment` 块(附件 id、文件名、类型、大小),`content` 仍只存原话。构造模型请求时:文本附件正文以"# 附件 / ## 附件:文件名"并入本轮(单个截断到 2 万字);图片读成 base64 放进 `ChatMessage.images`(只在请求里出现,不落库),runtime 分别转成 OpenAI 的 `image_url` data URL、Anthropic 的 base64 image 块、Gemini 的 `inlineData`。历史与引用上下文同口径:最近 3 条带引用 / 附件的 user 消息完整带入(图片与文本附件),更早的只留"[附件:名称]"占位;每张图片按 1200 tokens 计入预算。模型能力声明了但不含 `vision` 时,带图片的请求直接 400(历史里的图片也只留占位);未声明能力时不拦,以服务商实际报错为准。重新生成沿用原消息的附件;编辑时不带 `attachments` 字段沿用原附件,显式传空数组表示去掉。清理:删除会话后检查它引用过的附件,没有其他消息引用就删除;启动时清理一天前上传但没有随任何消息发出的附件。导出包带 `data.attachments`(含 base64 内容,包版本仍为 v2,旧版本应用会忽略该字段),导入在主事务提交后逐个写入,内容哈希与 id 不符的跳过并计入 `invalid`。前端:输入框回形针 / 粘贴 / 拖放,选中即上传,附件条显示缩略图、上传中、错误与移除;上传中或当前模型不支持图片时不能发送;编辑消息时不能更换附件。取舍:不做 PDF / Office 解析与图片压缩(超过 10MB 直接拒绝);附件随会话存储,不进入记忆与全文搜索。

外部导入:前端解开官方导出 ZIP(`settings/zip.ts`,只读中央目录,支持 stored / deflate,用浏览器自带 `DecompressionStream`,不支持 ZIP64,此时提示先解压),取层级最浅的 `conversations.json` 原文发给 `POST /admin/import/external/preview`(返回来源、对话数、消息数、重复数、空对话数、时间范围)与 `POST /admin/import/external`(`external.ts`)。按结构识别来源:每项有 `mapping` 是 ChatGPT,有 `chat_messages` 是 Claude,否则 400"无法识别的导出文件"。ChatGPT:mapping 本身是树,只保留 author 为 user / assistant、recipient 为 all、未标记隐藏、content_type 为 text / multimodal_text 的节点,图片部分记为"[图片]";被跳过的节点(系统提示、自定义指令、工具调用与结果、思考)的子节点接到最近的可见祖先上;同角色且是唯一子节点的连续消息合并(一次回复中间夹工具调用时会被拆成多条);`current_node` 映射为 head。Claude:有 `parent_message_uuid` 时按它成树(根哨兵 uuid 视为无父),否则按顺序成单链;sender human / assistant 对应 user / assistant;正文取 content 里的 text 块(跳过 thinking / tool_use),没有则用 text;附件抽取的文本按"[附件:文件名]"并入(单个 2 万字截断),上传的文件记为"[文件:文件名]";`current_leaf_message_uuid` 映射为 head。每个有内容的对话成为一个 Chat 会话(标题、创建时间沿用原对话,更新时间取原对话与最后一条消息的较晚者),v12 迁移给 sessions 加 `external_source` / `external_id` 并建部分唯一索引,同一来源同一对话重复导入直接跳过;整批在一个事务里,失败回滚。导入的消息走已有触发器进入全文索引,不提取记忆(避免一次导入大量历史时消耗模型调用)。取舍:不导入原图与 Claude 的项目 / 知识库;时间戳统一转成 ISO;请求体就是 conversations.json 原文,很大的导出(数百 MB)会占用相应内存,暂不做流式解析。


## D-024:Agent 工具循环、权限规则与终端流式输出(2026-10-22)

工具循环:`packages/server/src/agent.ts` 定义 `AgentTool { def; perm; run }`,内置 read_file / list_files / grep / edit_file / write_file / bash / git_status / git_diff 八个工具,按会话模式下发——code 全部,work 只读五项,chat 不给。下发条件从旧的 `XIYUN_EXPOSE_TOOLS=1` 门控改为:模式为 code / work、会话有工作区、Provider 有 `streamEvents`、capabilities 未声明或含 tools、且 `XIYUN_AGENT !== "0"`(保留一个整体关闭开关用于排错)。`runAgent` 逐轮调用 `provider.streamEvents`,收到工具调用后先把 assistant 消息(含 toolCalls 与协议 raw)压入请求,再逐个执行并回传 `role: "tool"` 结果;首步尚无输出却报 400/422 时去掉工具重试一次(网关不支持 function calling);多步用量求和并填 `steps` / `contextTokens`,单步保持原样以免破坏旧测试的精确比较;达到步数上限追加「回复"继续"」提示。

块与流式:`BlockBuilder` 从 app.ts 原有的 closeOpen / ensureText / finishTool 抽出,新增三点——状态每次变化都发 `block_end` 快照(前端按 id 覆盖),`tool_output` 按 80ms 合并节流,块 id 与回传给模型的 wireId 分开保存(各协议调用 id 跨步可能重复,如 Gemini 每步都是 `call_0`,块 id 用全局递增的 `tc<n>`)。

权限:每次工具执行前重新 `loadPermissions` + `decide`,这样「本项目始终允许」写入后立即生效。deny 直接拒绝且不可被 allow 覆盖(`DENY_RE` 优先);ask 时若有确认回调则置 `awaiting`、下发 `runId` / `rule`(suggestRule 给出的建议规则)/ `reason`,挂起等 `POST /runs/:id/confirm`;选 always 时 `addAllowRule` 写入 `<ws>/.xiyun/settings.json`;没有确认通道(子任务)时交给 policy 钩子,默认拒绝并说明当前环境无法确认。子任务里 coder 的 Edit / Write 放行(等价于原 files.write),其余角色的写操作与需要确认的 bash 一律拒绝。

确认通道:`Run.awaitConfirm(callId)` / `confirm(callId, decision)` / `awaiting()`;中断时所有等待中的确认按 `deny` 收尾,避免 agent 循环挂死;确认不设超时。`POST /runs/:id/confirm` 同时接受 `{callId, decision}` 与 `{callId, allow, remember}` 两种写法,run 不存在 404、callId 不在等待中 409。

终端:shellExec 的 `onData` / `signal` 在 E4 已就位,本批新增 `POST /tools/shell/stream`(SSE 逐块推 `{type:"output",stream,data}`,最后一条 `{type:"result"}`),客户端断开时结束进程树;`/tools/shell` 改为先按规则判定,deny 403、ask 且未确认 409 并带回 `rule` / `reason`;新增 `GET /tools/permissions` 与 `POST /tools/permissions/allow`。`gitExec` 从模块私有改为导出,供 git_status / git_diff 使用(argv 直传,不经 shell)。

审计与安全:每次工具执行写一条 `tool.agent` 事件,内容为 `{sessionId, name, 参数摘要(截断 300 字符), status, exitCode}`,**不记录文件内容**;所有路径经 `assertInside` 校验,越界路径不填 `target.path` 并返回错误结果。

前端:ToolBlock 补 awaiting(警告色、自动展开、显示 reason 与将要写入的规则原文、允许 / 本项目始终允许 / 拒绝三个按钮,点击后禁用等服务端 block_end)、running(等宽输出区自动滚动)、rejected 与 result 展示(edit_file 的 diff 按 -/+ 着色,bash 显示 exit 徽标与耗时);删除「当前版本不会自动执行」文案,pending 改为「未执行(当前会话未开放工具)」。终端面板改用流式接口,运行中实时显示输出,确认条增加「本项目始终允许」。

取舍:`toolDigest` 把上一轮的工具调用摘要附在 assistant 内容后(而不是新增字段),这样历史装配与预算计算无需改动;结果回传模型截到 30k(保留开头 40% 与结尾 60%),界面展示截到 10k;流式输出只保留尾部 64KB;子任务步数上限 12、主对话 30。tasks.ts 的旧文本 ```tool 协议与 ROLE_TOOLS / runTool 一并删除,`tools.test.ts` 保留其余用例。

## D-025:工作区快照与回退,以及 MCP 客户端(2026-10-22)

工作区快照(L1):每个工作区一个影子仓库 `<dataDir>/checkpoints/<sha1(realpath(ws)) 前16位>.git`,所有命令都用 `--git-dir` / `--work-tree` 指向它,**完全不碰用户自己的 `.git`**(有测试断言用户仓库的 HEAD 与工作区状态在快照前后不变)。`info/exclude` 固定写入 `.git/ node_modules/ .xiyun-wt/ dist/ build/ .next/ target/ .xiyun/`,并设 `core.autocrlf=false`(避免 Windows 上换行配置造成内容漂移)。快照 = `add -A` + `write-tree`,树与 HEAD 相同就复用 HEAD,否则 `commit-tree -p HEAD` + `update-ref HEAD`;超时 30 秒,失败只记审计事件、不影响对话。保护:工作区是用户主目录或磁盘根目录、或文件数超过 2 万时关闭快照并给出原因(`CheckpointStore.ensure` 返回原因,`snapshot` 返回 null)。拍快照的时机:code 模式每轮开始前一次(user 消息落 `messages.checkpoint_sha`,v13 迁移新增),以及 write_file / edit_file / bash 执行前一次(记在工具块的 `checkpoint` 字段)。

回退:`POST /sessions/:id/rewind {messageId, code, chat}`。`code=true` 时先拍一份 `pre-rewind` 快照得到 `undoSha`,再 `read-tree -u --reset <sha>`;**`read-tree` 不会删除快照之后新增的文件**,所以先 `add -A` 并用 `diff --name-only --diff-filter=A` 找出这些路径逐个删除(被忽略的目录不在快照里,因此不受影响)。`chat=true` 把 head 直接设为该消息的父消息——不能用 `switchHead`,它在消息已位于当前路径上时不做任何事。返回 `{ok, undoSha, text, messages}`,前端直接用返回的 messages 替换本地列表。`POST /sessions/:id/rewind/undo {sha}` 撤销回退。`GET /checkpoints/diff?sessionId&from` 列出将要还原的文件与 patch,供确认对话框展示。

`loadTree` 的 head 兜底语义修正:原来"head 为 null 且不是老库"会自动回退到最新一条消息,这会让"回退到第一条消息之前"(head=null)立刻被撤销。改为只在 head **指向已删除消息**时失效;老库(所有消息都没有 parent)仍按 id 顺序取最后一条作为 head。同时 `linear` 收紧为"老库单链"——它只用于让展示层省略 parentId / siblings,head 为 null 的新库是空会话,路径为空,不能当单链。

MCP(B3):依赖 `@modelcontextprotocol/sdk`。配置分两级——用户级 `~/.xiyun/mcp.json`(与 `claude_desktop_config.json` 同格式,另支持 `{type: "http" | "sse", url, headers}`)、项目级 `<ws>/.mcp.json`(Claude Code 格式)。项目级配置**首次使用前必须在设置里批准**,批准结果按"配置内容的 sha256 前 16 位"记到 `~/.xiyun/mcp-trust.json`,配置一改就失效、需要重新批准——这样别人在仓库里塞一个 `.mcp.json` 不会静默执行命令。合并规则:项目级同名覆盖用户级;未信任时整个项目级被忽略。

连接:stdio 用 `StdioClientTransport`,环境变量 = `getDefaultEnvironment()` + 配置的 env(不带 `process.env`,避免泄漏本机密钥);**Windows 下 `npx` / `npm` / `pnpm` / `yarn` / `bunx` 必须包一层 `cmd /c`**,否则 spawn 找不到 `.cmd`。http 用 `StreamableHTTPClientTransport`,失败时回退 `SSEClientTransport` 一次。惰性连接(首次需要工具时才启动),连接超时 30 秒,stderr 保留尾部 8KB 用于排错。工具列表处理 `nextCursor` 分页。工具名规范化为 `mcp__<server>__<tool>`,字符限定 `[a-zA-Z0-9_-]`,超过 64 字符时截断并追加 8 位短哈希(原名与规范名的映射保留在 `McpToolInfo.originalName`)。`callTool` 超时 120 秒、支持 signal 中断;返回内容 text 拼接、image 转 `[图片 mime]` 占位、resource 取 text 或 uri,整体截到 30k。

接入 agent:MCP 工具并入工具注册表,code / work 模式默认开放;权限类型为 `Mcp`,默认需要确认;规则沿用 E3 的 `mcp__github` / `mcp__github__*` / `mcp__github__create_issue`。接口:`GET /mcp/servers`(状态 / 工具数 / 错误 / stderr)、`GET` / `PUT /mcp/config`(写入前校验每个服务器必须有 command 或 url)、`POST /mcp/servers/:name/restart`、`POST /mcp/trust`、`POST /mcp/import/claude-desktop/preview` 与 `/apply`(同名只列冲突、不覆盖)。设置页的「插件」占位替换为 MCP 区块。

两处顺带修复:`shellExec` 中断时原来只 `killTree` 不 settle,进程树杀不干净时 `close` 事件迟迟不来,Promise 会挂住——改为中断立即以 AbortError 拒绝(仍调用 killTree 结束进程),并用 `settled` 标志避免重复 settle。新增 `vitest.config.ts` 设 `fileParallelism: false`:测试会启动真实子进程(git / node / shell)并操作临时目录,并行时互相抢 CPU 与磁盘,表现为随机超时(排查时观察到失败文件在漂移)。

取舍:快照不记录被忽略的目录,所以 `node_modules` 之类的改动无法回退(符合预期);影子仓库每个工作区一份,工作区移动后 key 变化会重新建仓;MCP 的 http 传输不做 OAuth;工具列表在连接后缓存,收到 `notifications/tools/list_changed` 时自动重新拉取;chat 模式默认不开放 MCP 工具。

## D-026:用导入历史初始化记忆,以及文档分块检索(2026-10-22)

L2(导入历史初始化记忆):记忆事实与候选各加 `source_message_id` / `source_kind` / `source_session_id` 三列(v14 迁移),`extract.ts` 的提示词要求模型为每条事实标注它来自对话里的第几条消息(字段 `index`),解析后映射回原消息 id;长会话按约 6k tokens 分片(chunkHistory),避免一次塞爆上下文。`MemoryJobRunner` 一次只跑一个会话,会话之间默认间隔 2 秒(可配);429 指数退避重试最多 3 次;支持暂停 / 继续 / 取消;**服务重启后状态为 running 的作业转为 paused**(构造时改一次),不会在没人看着的情况下继续烧额度。`shouldProcess` 钩子过滤"至少 2 轮"(2 条 user)的会话,单轮的寒暄不值得调模型。作业的 `source` 固定为 `import:chatgpt` / `import:claude`,`scope` 为 global。触发点在 M1 的导入预览对话框:勾选「导入后从这些对话中提取记忆」后随 `?extract=1` 传参(请求体是原始导出数组,放不下这个标志),预览同时给出可提取会话数与 token 估算。

撤销按来源批量做:`POST /memory/facts/revoke {sourceKind}` 走软删除(与单条删除同语义,数据保留、检索不可见),返回撤销条数并写 `memory.revoke` 审计;前端做两次确认。「查看出处」用 `source_session_id` + `source_message_id` 定位到原会话的原消息:先切到该会话所在模式,再用已有的 `requestFocus` 机制滚动并高亮——不新造跳转通道。`GET /sessions/:id` 补了单会话元信息接口(记忆页按 id 查会话标题与模式)。

F8(文档检索):`doc_chunks(id, doc_id, ord, start, end, text)` 按段落累积到约 800 字符、相邻块重叠 100 字符;`doc_chunks_fts` 用 FTS5 `trigram` 分词(中文子串可搜),触发器与 `doc_chunks` 同步,导入或更新文档时重建该文档的块,启动时给缺块的老文档补建(可重复执行,补建失败不影响启动)。检索:查询词 ≥3 字符时每个词加引号转义、OR 连接、按 `bm25()` 排序,**每篇文档只取得分最高的块**;不足 3 字符退回 LIKE;整句自然语言提问(没有空格的长串)拼不出短语时再退化为 3 字滑窗 OR——沿用旧的 LIKE 兜底口径,保持召回行为不变。高亮由 `highlight()` 统一生成:相邻或重叠的命中合并成一段(否则 3 字滑窗会把词切碎),用 `\u0001` / `\u0002` 包住,前端拆成 `<mark>`。

Work 模式注入改为**命中块的原文**(不再整篇截断),并标注「来源:标题 §段号」,让结论能回链到具体段落。`GET /work/docs/search` 返回命中块(必须注册在 `/work/docs/:id` 之前,否则 "search" 会被当成 id),前端在资料面板里显示高亮片段、点击定位到该块并高亮。

PDF / Word 转换新建 `convert.ts`(依赖 `unpdf` 与 `mammoth`):PDF 用 `extractText` 逐页取文字,docx 用 `extractRawText`;**每页提取出的文字少于 50 字时提示"可能是扫描件(没有文字层),需要 OCR"**——扫描件不是解析失败,必须让用户知道原因;单文件上限 30MB。转换路径只有一条:Work 导入、B2 附件上传、Work 页拖入 PDF / Word 都走 `convertToText`,转成文本后按文本处理(附件存为 `原名.txt`,拖入的资料来源记文件名)。拖入的 PDF / Word **只转文本存为资料,不写进用户工作区**——避免污染用户目录。

取舍:记忆作业不追求并发,一次一个会话 + 2 秒间隔是刻意的保守选择(批量调模型容易触发限流且难以观察);限流退避只针对 429,其它错误直接记 failed 继续下一个会话;文档检索不做向量检索,BM25 + trigram 够用且零额外依赖;`unpdf` / `mammoth` 引入后打包体积增加,只在这两条路径动态 import,不用 PDF 的用户不承担加载成本。
