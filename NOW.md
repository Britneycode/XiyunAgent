# 当前进度

## 当前阶段

**迁移审计 Step 2 第三批已交付(2026-10-21,feat/qoder-workbench-ui 分支,见 D-022):F6 消息树——编辑消息与重新生成不再删除旧内容,而是在同一位置新增版本,气泡上用"‹ 2/3 ›"切换,切到旧版本时连同它后面的对话一起恢复;搜索命中旧版本时自动切到该分支;分支 / 导出 / 导入保留树结构(导出包升到 v2,v1 包按单链导入);v11 迁移加 messages.parent_id、sessions.head_id 并把老会话回填成单链。F4 上下文管理——历史不再固定取最近 20 条,而是按所选模型的上下文长度算 token 预算从新到旧装入,装不下的早先消息由后台滚动摘要代替(回复底部显示"摘要 / 省略 N 条");引用上下文随消息落库,之后 3 轮继续带入,引用的文件改过时提示模型内容可能过时;重新生成与编辑沿用原消息的引用。新增 tree.ts / context.ts 与对应测试(263/265 通过,2 个为既有的 Windows 路径用例)。**

**迁移审计 Step 2 第二批已交付(2026-10-21,feat/qoder-workbench-ui 分支,见 D-021):M2 多协议 Provider——除 OpenAI 兼容外原生支持 Anthropic Messages 与 Gemini API(流式文本 / 思考 / 工具调用 / 用量全打通),一个 Provider 可配多个模型(各自上下文与能力),支持附加请求头 / 查询参数(Azure OpenAI 预设)与温度 / 回复上限 / 思考强度,设置页加协议选择、常用服务商预设和"获取模型列表"。M3 会话级模型——每个会话可单独选模型(默认跟随全局),回复气泡显示生成模型,末条回复可"换个模型重新生成";v10 迁移加 sessions.provider_id / model、messages.model。新增 runtime http.ts / anthropic.ts / gemini.ts、settings/providerForm.ts 与对应测试(247/249 通过,2 个为既有的 Windows 路径用例)。**

**迁移审计 Step 2 第一批已交付(2026-10-21,feat/qoder-workbench-ui 分支,见 D-020):F1 生成不再随连接中断——服务端运行注册表让生成在后台执行,关窗 / 切会话 / 刷新都不会中止;回到会话自动接上正在生成的内容,断线自动续订并从断点回放;停止按钮走取消接口;同一会话同时只允许一个生成(409);侧栏对生成中的会话显示转圈。M7 消息全文搜索——v9 迁移建 FTS5 trigram 索引(触发器同步、回填旧消息),`GET /search`;侧栏搜索除标题外列出"消息内容"命中(高亮片段),点击跳到该会话并定位、高亮到那条消息。新增 runs.ts / search.ts 与对应测试(222/224 通过,2 个为既有的 Windows 路径用例)。**

**迁移审计 Step 1 第二批已交付(2026-10-21,feat/qoder-workbench-ui 分支,见 D-019):M4 规则兼容生态格式——除 AGENTS.md / CLAUDE.md 外加载 `.cursorrules`、`.github/copilot-instructions.md`、`.cursor/rules/**/*.mdc`(alwaysApply 总是加载,globs 在 @ 引用了匹配文件时加载,只有 description 的进"按需规则"索引)、`.github/instructions/*.instructions.md`(applyTo)、被引用文件所在目录的 AGENTS.md / CLAUDE.md、`CLAUDE.local.md`,Code 模式加载 `~/.claude/CLAUDE.md`;规则内 `@路径` 展开(跳过代码块,限工作区内,≤5 层防环);同内容去重,单文件 20k / 总量 60k 字上限。M5 Skill 兼容社区格式——只有 SKILL.md 也能导入(frontmatter 的 name / description 合成 manifest),注入时去掉 frontmatter;启用的 Skill 正文合计超 12k 字时改为渐进注入:全部 Skill 的名称 + 用途索引,只附与本轮消息相关(点名或关键词重合)的全文;子目录递归静态检查。M7 会话按最近活动排序(sessions v8 加 `updated_at`,老会话回填为最后一条消息时间),新会话首条消息即时得到启发式标题,较长的消息再由模型起短标题(SSE `{type:"title"}`,只覆盖启发式标题,不动用户改过的)。F5 未发送的输入按会话保存为草稿(含引用),切换会话 / 刷新后恢复,发送后清除。M6 快捷键:Ctrl+Shift+O 新建会话、Ctrl+Shift+S 切换侧栏、Ctrl+Shift+C 复制最后一条回复、Ctrl+Shift+; 复制最后一个代码块、Shift+Esc 聚焦输入框、空输入框按 ↑ 编辑上一条消息、Ctrl+/ 快捷键面板。新增测试 25 项(规则 12、Skill 3、会话活动与命名 7、草稿与代码块 3);typecheck + Web 构建通过,210/212 通过(其余 2 项为既有 Windows 路径用例)。注意:`apps/desktop/server.mjs` 需重新 `pnpm build:server`;数据库启动时自动迁移到 v8(迁移前自动备份)。**

**迁移审计 Step 1 首批已交付(2026-10-21,feat/qoder-workbench-ui 分支,见 D-018):F2 新消息即时可编辑——SSE 首发 `{type:"meta", userMessageId}`,done/error 事件带回落库 id,前端纯函数 `applyStream` 回填到本轮 user/assistant 气泡,刚发出的消息不刷新即可编辑、分支,停止生成后也能立即编辑这条提问。F3 出错不丢内容——Provider 报错时半截回复落库并标记 `error`(messages v7 加 `error` 列),刷新后仍显示错误原因,末条可「重试」;regenerate 失败不覆盖完整旧回答。runtime 新增 `ProviderError`:状态码 + 中文原因(鉴权 / 额度 / 模型不存在 / 上下文超长 / 限流 / 服务不可用)+ 脱敏后的服务端原文;首 token 前对 429/5xx/网络错误自动重试 2 次(遵守 Retry-After),流式 5 分钟无数据断开,流内 error 对象不再静默变空回复。新增测试 19 项(runtime 10、/chat 净增 4、applyStream 5),"出错不落 assistant"旧用例改为新语义;typecheck + Web 构建通过,185/187 通过(其余 2 项为既有 Windows 路径用例,在 Linux 下不适用)。注意:`apps/desktop/server.mjs` 需重新 `pnpm build:server`。**

**Qoder 风格工作台 Step 3 已交付(2026-10-21,feat/qoder-workbench-ui 分支,见 D-017):消息流与工具卡片——流式 Markdown 逐块 memo + 未闭合代码块"生成中"同框限高(闭合不跳动);代码块语言/行数或 diff 增删统计、行号、自动换行、复制、超 20 行"展开剩余 N 行"、送预览;思考块呼吸指示 + 实时耗时 + 完成自动收起;工具卡片运行中/待执行/完成/错误/已中断五态,参数流式时即时提取 path/command 摘要,可展开参数 JSON、复制、送预览或查看 Diff;贴底跟随与"回到底部"。Code 页改为 Claude Code 桌面式:顶部上下文栏(工作区 + 分支 + 面板开关),变更面板(勾选提交范围、逐文件内联 Diff、提交)与终端面板(运行卡片、退出码/耗时、确认、历史)进入右侧检查器;Work 页资料(文件/网页/粘贴导入、Markdown 渲染、工作目录文件)与待办(逾期、已完成折叠)同样进检查器。修复 `useChatStream` 把 block_delta 误判为正文增量的问题(思考/工具参数流式期间被拼进正文,StrictMode 下原地追加导致文字重复),抽出纯函数 `applyQueue` 并加回归测试;修复 Code 页提交范围初次加载偶发全不勾选。新增前端单测 21 项(gitDiff / markdown / applyQueue);清理 styles.css 中已无引用的旧 Chat/Code/Work 样式。**

**Token 实测用量已交付(2026-10-21,feat/qoder-workbench-ui 分支,见 D-016):runtime 请求携带 `stream_options.include_usage` 并归一化 usage(OpenAI/DeepSeek/通义/Moonshot 字段),严格网关 400/422 自动去参重试并缓存;/chat SSE 新增 `{type:"usage"}` 事件;messages v6 迁移加 `usage` 列,GET messages/分支/导出/导入携带。前端:Composer 上下文计数以最近一次实测为基线 + 新增内容估算,明细含上一轮输入/输出、缓存命中、推理与会话累计;每条 assistant 回复页脚常显 ↑输入 ↓输出 tokens。注意:`apps/desktop/server.mjs` 需重新 `pnpm build:server`。**

**Agent 工作台 UI 已交付(2026-10-21,feat/agent-workspace-ui 分支,依据 `docs/superpowers/specs/2026-10-21-agent-workspace-ui-design.md`):/chat SSE 升级为结构化块协议——text 块带 id 增量下发、`block_end` 携带完整快照、思考块与工具调用块独立成块;消息落库新增 `blocks`(JSON)与 `aborted` 列,分支/导出/导入全链路携带;用户中断落半截回复并标记已中断。前端 Chat 页重构为工作台形态:Markdown 渲染迁移到 `apps/web/src/chat/markdown.ts`(统一 escapeHtml + 代码块行号/复制/语言标识 + 图片属性转义);`chat/blocks.tsx` 思考块(呼吸指示 + 耗时 + 完成自动收起)与工具卡片(待执行/完成/错误三态,可展开参数,可送预览);`chat/useChatStream.ts` rAF 合批流式渲染;`chat/Composer.tsx` 复合输入框(@ 文件/文档引用胶囊、/new /export /memory 内置命令、模型下拉、运行/停止);App 右侧栏新增预览 tab(`chat/PreviewPanel.tsx`:工具详情/终端/产物/Diff 高亮,>200KB 截断)。`/tools/git/diff` 失败返回 400 带错误文本。工具只展示不执行:设置 `XIYUN_EXPOSE_TOOLS=1` 且 Provider 声明 tools 能力且会话绑定工作区时才下发只读工具定义。typecheck + Web 构建 + 136 项测试通过;Code/Work 页复用 ChatPage 不传新回调,行为不变。注意:`apps/desktop/server.mjs` 需重新 `pnpm build:server`。**

**优化阶段 5 已交付(2026-10-07):可迁移的数据导入导出。Server:`GET /admin/export` 导出会话+消息+资料+待办+记忆事实为带版本号 JSON(`{kind:"xiyun-export",version:1,data}`),不含 API Key、events 审计、tasks 运行时;`POST /admin/import/preview` 预览各表新增/重复(同 id)不写库;`POST /admin/import` 整体单事务、同 id 跳过不覆盖、消息按 (session_id,role,content,created_at) 去重、损坏/版本过高包写库前拒绝、中途失败 ROLLBACK 不破坏已有数据、成功记 `data.import` 审计。前端:设置页新增「数据」分区——导出按钮(下载 JSON)、导入选文件→预览(各表新增/重复/消息条数)→确认导入,结果反馈新增与跳过条数。typecheck + 110 项测试(app.data.test.ts 新增 6 项:导出不泄密、预览不写库、重复跳过、损坏拒绝、回滚)通过。注意:`apps/desktop/server.mjs` 需重新 `pnpm build:server`。**

**优化阶段 4 补充(2026-10-07,按用户反馈调整为 Kimi/Claude 对话布局):去掉头像,改为用户消息右对齐蓝色气泡、assistant 裸露排版;消息 hover 浮现操作按钮——所有消息 ⧉复制、最后一条 assistant ↻重新生成、user 消息 ✎编辑并重新生成 + ⑂分支到新会话。Server 新增 `POST /sessions/:id/messages/:mid/truncate`(删该条及其后消息,供编辑重生成)与 `POST /sessions/:id/branch`(复制该条前的历史到新会话,标题加"(分支)"),`GET /sessions/:id/messages` 现返回消息自增 id,`ChatMessage` 加可选 `id`。编辑流程:✎ 把内容填回输入框 + 顶部"正在编辑"提示条,Enter 调 truncate 截断后重新发送。typecheck + 104 项测试 + Web 构建通过,布局/编辑/分支均经桌面浏览器实测与参考图一致。注意:`apps/desktop/server.mjs` 需重新 `pnpm build:server`。**

**优化阶段 4 已交付(2026-10-07,前端由主代理直接实现):高频交互 + UI 借鉴 ChatGPT/Claude 重设计。Server:sessions 表 v4 迁移加 `archived` 列,`PATCH /sessions/:id` 支持 title/archived/workspace,`GET /sessions` 支持 archived=0|1|all 过滤;/chat 支持 `regenerate:true`(不重复落库 user 消息、删上一条 assistant 后重生成)。前端:ChatPage 重设计为 ChatGPT 风格(圆形头像、用户消息圆角气泡、assistant 裸露排版、输入框悬浮圆角卡片)、重新生成/重试按钮、Esc 停止、生成中提示;App 会话列表加 hover 操作(✎重命名行内编辑/▤归档/✕删除带 confirm)、归档列表切换、加载中/未连接统一空态;SettingsPage 清理全部"阶段 X 完善/交付"过期占位文案;侧栏改造——rail 可收起(⇤/⇥),<980px aside 变浮层默认收起、<720px rail 变浮层默认收起带 scrim 遮罩、顶栏在窄窗口隐藏 brand/status 防挤压。修复关键 Bug:ChatPage `useEffect(() => bottomRef.current?.scrollIntoView(...))` 可选链返回非函数值导致新版 React 卸载时 `destroy is not a function` 白屏(改为块语句)。typecheck + 104 项测试(app.sessions.test.ts 新增 9 项)+ Web 构建通过,UI 经桌面浏览器实测(1100px 默认窗口与 474px 窄窗口均无遮挡)。注意:`apps/desktop/server.mjs` 需重新 `pnpm build:server`。**

**优化阶段 3 已交付(2026-10-07):模式与会话状态错配修复。App.tsx 单一 activeId 改为 `byMode` 三槽位(chat/work/code 各自记住活动会话),切换模式恢复该槽位、槽位空或会话失效显示对应模式空状态;`active` 派生同时校验 id 存在与 `s.mode === mode`,sessions 刷新后清失效槽位(覆盖删除/改 mode);localStorage(`xiyun.activeSessions`)持久化、启动后校验恢复;TasksPanel 改按 sessionId 过滤任务,App 只在 active 存在时传真实 sessionId/mode/workspace(三者同源,派发 mode 必然与会话一致),未选中会话时 sessionId=null 显示全部。typecheck + 93 项测试 + Web 构建通过。web 端无组件测试基建,按 P2 要求提供手工验收脚本(见下方"优化阶段 3 手工验收")。已知未改:同模式内切换会话 WorkPage/CodePage 不重挂载(内部 state 残留,既有行为);mode 本身不持久化,刷新回 Chat。**

**优化阶段 2 已交付(2026-10-07):Git 提交范围可见、可控。Server:`gitStatusEntries`(porcelain=v1 -z 解析,rename 只取新路径)、`gitPreview`(status + `git diff --stat` + `git diff --cached --stat`)、`gitCommit` 重写为 `git add -- <files...>`(files 必填,空即拒;路径越界拒;内部走 `gitExec` argv 直传 spawn,规避 PowerShell 双引号插值与 shell 注入,不经 classifyCommand 闸);新增 `POST /tools/git/preview` 路由;`git.commit` 审计 payload 增加 files 路径列表。Web:Code 提交抽屉改造——文件复选清单带状态徽章(已暂存/未暂存/未跟踪)、diffStat/cachedStat 摘要、cachedStat 非空显示"提交将连带已有暂存内容"警告、默认全选、取消仅关抽屉不发请求、提交后刷新 preview 与 diff。`GitStatusEntry`/`GitPreview` 类型入 `@xiyun/shared`。typecheck + 93 项测试(tools.test.ts 新增 11 项:选择性提交/暂存并存/取消后状态逐字节不变/越界路径/add 失败原子性等)+ Web 构建通过。注意:用户已有手动暂存内容会随提交带入(server 不剥离,靠前端警告披露);`apps/desktop/server.mjs` 需重新 `pnpm build:server`。**

**优化阶段 1 已交付(2026-10-07,依据 `docs/optimization-implementation-plan.md`):CORS 白名单(`app.ts` 仅放行 localhost/127.0.0.1/[::1] 来源,无 Origin 放行,外部来源与 `"null"` 拒)+ 网页导入 SSRF 防护(`docs.ts` 的 `assertPublicUrl` 用 `node:net` BlockList 拒绝环回/私网/链路本地/未指定地址,域名经 dns.lookup 全记录判定,端口仅 80/443,手动跟随重定向 ≤5 跳每跳重校验,响应流式读取超 500KB 立即中止不写库,`importUrl` 返回 `{ doc, finalUrl, bytes }`,import-url 路由成功/拒绝均写审计)。DNS 重绑定 TOCTOU 已关闭:抓取改用 node:http/https request 并传入自定义 `lookup` 钉住已校验地址(连接不再二次解析,Host/TLS SNI 保持原域名,已用自签证书 HTTPS 实测);补 `::/96`、`64:ff9b::/96` 网段(BlockList 对 `::ffff:0:0/96` 归一为 IPv4,加 `::/96` 不误伤公网映射地址)。typecheck + 83 项测试(docs.ssrf.test.ts 19 项,含钉住/重绑定模型/IPv6 特例断言)通过。注意:`apps/desktop/server.mjs` 为旧构建产物,`pnpm dist` 前需重新 `pnpm build:server`。**

**阶段 7 已交付(2026-10-07):Windows 交付、升级和完整验收——`pnpm dist` 打包成功,win-unpacked 冒烟通过(窗口启动、`/health` 200、数据落 `%APPDATA%\XiyunAgent\` 含 backups/);typecheck + 58 项测试通过。**

阶段 7 已交付(2026-10-07):`PRAGMA user_version` 迁移框架(`db.ts` MIGRATIONS 清单,新增迁移追加不改历史)、迁移前自动备份到库旁 `backups/`(老库迁移不丢数据,有回归测试)、手动备份 `POST /admin/backup`、打包态 Server 崩溃递增退避重启(上限 5 次,超限弹窗)、RUNBOOK.md 阶段 7 节(版本基线/升级/回滚步骤/已知问题)。

阶段 6 已交付(2026-10-07):`skills` 表 + SkillStore(manifest 校验 id/name/version、目录导入、ZIP 用系统 tar 解压、静态检查非文档文件进 warnings、同 id 重导入=升级且保留启用状态、启用/禁用即时生效)、Skill 匹配(modes/roles 空=不限制,主对话角色按 "main")、注入主对话与 code 模式子智能体 system prompt、`/skills/*` API、`GET /events` 审计查看、设置页 Skill 分区(导入/启用/禁用/删除 + 权限与警告展示)与权限与安全分区(已启用 Skill 权限声明 + 最近 50 条审计)、内置示例 Skill 三个(`examples/skills/`:备考教练/需求分析/代码审查)。

阶段 5 已交付(2026-10-07):`docs`/`todos` 表 + WorkStore(工作区文件导入、HTML 标签抽取、网页抓取记录来源 URL、粘贴导入、LIKE 检索带上下文片段)、Work API(`/work/docs/*`、`/work/todos/*`、`/tools/list` 文件树)、Work 模式 chat system prompt + 资料片段注入(要求结论标注来源)、Web Work 页(文件树/资料导入/文档查看(显示来源)/待办含截止日期)、TasksPanel work 流水线预设(需求整理→讲解)。**未支持 PDF/Office 解析**(需新增依赖,当前 pnpm 供应链策略下安装受限,见待办)。

阶段 2 补齐项已交付(2026-10-07):自然语言增删记忆的 Chat 工具调用(`memchat.ts`,意图词门槛 + 小模型 JSON 解析,"记住"直接写事实、"忘掉"检索命中软删除,结果注入回复确认)、无主题词泛化提问召回(`MemoryStore.recent`,FTS 召回为空时回退最近有效记忆)。

阶段 2 已交付:记忆候选与异步提取流水线(`memory` 角色模型,不阻塞 SSE,低置信度只进候选)、候选确认/拒绝/彻底忘记闭环、记忆管理页(事实/候选筛选)、主题系统(7 预设 + 主题包导入导出 + token 微调)、App Shell 三栏布局(顶栏模式切换/会话栏/可收起候选栏)、分类设置页、Work 占位页。

阶段 3 已交付(2026-10-07):`tasks` 表 + TaskStore/Scheduler(`run`/`parallel`/`pipeline` 三种调度)、严格角色绑定(未授权模型不自动回退)、同角色已授权模型回退链(`byRoleAll`)、每组最多 3 个子智能体、只读角色并行/写角色同工作区串行、pipeline 上游摘要注入下游、上游失败即终止、取消/重试/启动恢复(`recoverInterrupted`)、结构化结果解析(```json 块,失败按文本兜底)、`waiting_for_user` 用户交互节点(子智能体提问 → 任务暂停 → 用户回答 → 恢复执行)、子智能体记忆产出只进候选区、任务事件审计(`task.completed`/`task.failed`/`task.recovered`/`task.waiting`)、Provider 能力标签(`capabilities: stream/tools/vision/json`)、Provider 连通性探测接口(`POST /providers/:id/probe`)、Web 右侧栏任务面板(模型/状态/耗时/摘要 + 派发入口 + waiting 应答框)、设置页能力标签配置 + 探测按钮。

阶段 4 已交付(2026-10-07):工具层 `tools.ts`(PathGuard 复用 `assertInside`、shell 探测 PowerShell/Git Bash/WSL、命令三级分类 deny/safe/confirm、`files.read`/`files.write`/`shell.exec`/`git.status`/`git.diff`/`git.commit`、`tool.*`/`git.commit` 审计事件)、工具 API(`/tools/*`,非白名单命令与 commit 未确认返回 409 needsConfirm)、子智能体工具循环(code 模式注入 ```tool 协议,最多 5 轮,需确认/危险命令以错误文本喂回模型)、角色工具矩阵(coder 可写文件,reviewer/tester/researcher 只读)、Code 模式 system prompt、`PATCH /sessions/:id` 绑定工作区、Web Code 页(工作区绑定栏 + Chat + Diff/终端/提交抽屉 + 命令确认条)、TasksPanel code 流水线预设(coder→tester→reviewer)。

## 当前目标

阶段 2–7 均已交付,路线图(`docs/implementation-roadmap.md`)全部阶段完成。剩余事项为"当前待确认/待验收"清单:真实 Provider 端到端复测(Code UI、Work 来源回链、Skill ZIP 导入复测)、Pi Runtime 接入方式、PDF/Office 依赖引入、可执行插件沙箱。

## 阶段 1 已完成基线

已完成的最小可运行骨架:

1. 初始化 pnpm workspace 和 TypeScript 配置。✅
2. 建立 Electron 主进程、React renderer 和本地 Agent Server。✅(typecheck/test/health 实测通过)
3. 接入 Pi Runtime 的 Provider 配置接口。✅(`ChatProvider` 接口 + OpenAI-compatible 实现,Pi 作为后续另一实现)
4. 建立 Chat 会话、流式响应和基础设置页。✅(SSE 流式 + SQLite 落库 + 重启恢复实测通过)
5. Markdown 渲染增强。✅(接入 `apps/web/public/vendor/` 的 katex 与 highlight.js,来自旧 YiyunAgent 项目)
6. Windows 安装包构建。✅(`pnpm dist`,含打包态 Server 方案,见 D-008)
7. 第一阶段 Chat 验收(导入学习资料→总结/出题/错题,记忆增删查)。✅(2026-10-07 真实 Provider 实测通过)

## 排期顺序

- [x] 仓库和 workspace 初始化
- [x] Electron 窗口与安全 IPC(无 IPC,Server 子进程 + HTTP,安全基线:contextIsolation)
- [x] 本地 Server 与健康检查(`GET /health`)
- [x] Runtime 适配层(`ChatProvider` 接口,Pi 接入方式待定,先用 OpenAI-compatible 实现)
- [x] Chat 页面与会话持久化(SQLite)
- [x] 通用设置、主题和字体预览(CSS 变量,实时预览,导入导出)
- [x] 修复记忆检索 FTS5 MATCH 语法注入问题(用户消息含逗号/括号即 500;现整体短语化,含回归测试)
- [x] 打包链路:`pnpm dist` = Web 构建 + esbuild 单文件 Server + electron-builder NSIS
- [x] 角色标签接入 Chat 路由(`main` 角色优先,无标记时回退激活 Provider;2026-10-07)
- [x] 规则文件分层加载(全局 `data/rules/global.md` → 模式 `data/rules/<mode>.md` → 项目 `AGENTS.md`/`CLAUDE.md`)+ 记忆检索按 scope(global/模式/工作区路径)隔离(2026-10-07)
- [x] 第一阶段 Chat 验收(2026-10-07 通过):导入贝叶斯定理资料→三句话总结/举例解释/出 3 题/批改 2 对 1 错,错题与进度写入记忆;新会话用"贝叶斯"关键词恢复进度;软删除不进检索、hard=true 彻底删除均符合语义
- [x] 阶段 2:记忆候选(`candidates` 表)+ 异步提取流水线(`extract.ts`,memory 角色模型,回复后不阻塞提取,失败记 `memory.extract.failed` 事件)(2026-10-07)
- [x] 阶段 2:候选确认/拒绝/彻底忘记 API 与审计事件(`memory.confirm`/`memory.reject`/`memory.forget`)(2026-10-07)
- [x] 阶段 2:主题系统重构——7 预设(System/Graphite/Paper/Solarized Light/Dark/Sakura/Midnight)+ token 微调 + 主题包导入导出(白名单 token 校验),全部 CSS 变量落地(2026-10-07)
- [x] 阶段 2:App Shell 三栏布局(顶栏模式切换 Chat/Work/Code、会话栏搜索、右侧待确认候选栏可收起)、设置页分类导航、记忆管理页(筛选 + 确认/拒绝/彻底忘记)(2026-10-07)
- [x] 阶段 2 实测:发送考试安排/偏好消息触发提取生成 4 条候选,确认 1 条后可检索、拒绝 1 条从列表移除;typecheck + 15 项测试通过(2026-10-07)
- [x] 阶段 3:子智能体调度核心(tasks 表 + Scheduler:run/parallel/pipeline、每组 ≤3、取消/重试/启动恢复、严格角色绑定不回退)(2026-10-07,7 项单测)
- [x] 阶段 3 实测:真实 Provider 下 researcher 未绑定即失败不回退;绑定后 pipeline(调研→讲解,上游摘要注入下游)与 parallel(两任务同刻启动)均完成;超过 3 个任务被 API 拒绝;typecheck + 22 项测试 + Web 构建通过(2026-10-07)
- [x] 阶段 3 收尾:同角色已授权模型回退链(`byRoleAll`)、`waiting_for_user` 状态(子智能体提问暂停→用户回答→恢复执行)、Provider 能力标签(`capabilities`)、连通性探测接口、Web 任务面板 waiting 应答框、设置页能力标签+探测按钮;typecheck + 24 项测试通过(2026-10-07)
- [x] 阶段 2 补齐:自然语言增删记忆的 Chat 工具调用(`memchat.ts`,意图词门槛+JSON 解析,记住→直接写事实/忘掉→命中软删除)+ 泛化提问召回(`MemoryStore.recent` 兜底);typecheck + 4 项新测试通过(2026-10-07)
- [x] 阶段 4:工具层 `tools.ts`(shell 探测 PowerShell/Git Bash/WSL、命令 deny/safe/confirm 三级分类、files/git/tests 工具、审计事件)+ `/tools/*` API(409 needsConfirm)+ 子智能体 ```tool 循环(≤5 轮,code 模式注入,角色工具矩阵)+ Code 页(工作区绑定、Diff/终端/提交抽屉、确认条);typecheck + 40 项测试 + Web 构建通过(2026-10-07)
- [x] 阶段 5:Work 文档(`docs` 表,文件/HTML/网页/粘贴导入,来源记录,LIKE 检索带片段)+ 待办(`todos` 表,截止日期/状态)+ Work 页(文件树、资料导入、文档查看、待办)+ Work chat 资料片段注入;typecheck + 48 项测试 + Web 构建通过(2026-10-07)
- [x] 阶段 6:Skill 系统(`skills` 表,目录/ZIP(tar)导入,manifest 校验,静态检查 warnings,升级保留启用状态,模式/角色匹配注入 chat 与子智能体)+ `/skills/*` API + `/events` 审计 + 设置页 Skill 与权限与安全分区 + 3 个内置示例 Skill;typecheck + 53 项测试 + Web 构建通过(2026-10-07)
- [x] 阶段 7:`PRAGMA user_version` 迁移框架 + 迁移前自动备份(库旁 `backups/`)+ `POST /admin/backup` + 打包态 Server 崩溃退避重启(≤5 次)+ `pnpm dist` NSIS 打包与 win-unpacked 冒烟通过(`/health` 200、数据落 `%APPDATA%\XiyunAgent\`);typecheck + 58 项测试通过(2026-10-07)

## 当前待确认/待验收

- [ ] 确定 Pi 依赖版本和接入方式(当前用 `ChatProvider` 接口隔离)
- [x] 阶段 4 API 实测(2026-10-07):`git status` 免确认执行、`git push` 未确认 409 needsConfirm、`rm -rf /` 带确认仍拒绝、`/tools/read|write` 越权 400、`git commit` 未确认 409→确认后提交成功并写 `git.commit` 审计;真实 Provider(DeepSeek)coder 工具循环创建 hello.txt 成功落盘
- [ ] Code 页 UI 手工验收(Diff/终端/提交抽屉、确认条)与 reviewer/tester 只读角色矩阵真实模型实测(该矩阵已有单测覆盖)
- [x] 阶段 5 API 实测(2026-10-07):import-file(md/html)/import-url(example.com)/paste 均成功且记录来源,越权导入 400;待办增删改查、截止日期、完成/重开、工作区隔离通过;新会话提问能正确标注"来源:粘贴笔记 / docs/bayes.md"
- [x] 阶段 5 缺陷已修复(2026-10-07):`searchDocs` 整句 LIKE 无命中时退化为 3 字滑窗 OR + 按命中片段数排序(与记忆检索兜底一致),自然语言问句可命中并正确定位片段;`POST /chat` 缺 `sessionId`/`message` 返回 400
- [x] 阶段 6 实测(2026-10-07):目录导入返回 manifest 且不自动启用,缺 SKILL.md/无效 id/无效 version 均 400 拒绝,同 id 升级 v1→v2 保留启用状态,禁用即时生效;`examples/skills/` 3 个示例可导入
- [x] 阶段 6 缺陷已修复(2026-10-07):ZIP 导入 win32 优先 `C:\Windows\System32\tar.exe`(bsdtar),PATH 命中 GNU tar 时退化加 `--force-local`(GNU tar 会把 `D:/...` 当远程主机)
- [x] Agent 工作台 UI 手工验收(2026-10-21,spec §5.2 八项):①思考块流式增量与 `durationMs` 由 SSE 直测确认,落库回放自动收起显示「已思考 0.3s」;②工具卡片 `pending`/展开入参/「在预览中查看」联动右栏均通过;③python 与 diff 代码块具备语言标签、复制(点击变「已复制」)、行号、hljs 高亮;④`@` 面板 message+file 双源命中并生成可删除胶囊,`/new`(会话数 +1)、`/export`(下载 md 含思考块引用)、`/memory`(新增 2 条候选)均生效;⑤模型下拉切 DeepSeek 后后端实际走该 Provider;⑥用户上翻后 8 秒流式期间 `scrollTop` 恒为 0 不被抢滚,贴底时自动跟随;⑦旧会话(18 条消息、无 `blocks`)纯文本正常回放;⑧中断显示「已中断」且未闭合围栏回退纯文本、重试重新流式生成、编辑态回填原文且可取消。**验收环境限制**:雷电模拟器自带 Android Browser 打开页面初始渲染正常但发送后白屏(内核过旧),改用桌面 Chrome 完成全部八项;验收临时改动 `data/config.json` 已还原(无 capabilities、模型名回原值、activeProviderId 回 p1)。**遗留 UI 缺陷**:`Composer.tsx:80` 模型下拉初始化取 `ps.find((p) => p.id)` 即列表第一项,未读服务端 activeProvider,导致刷新后下拉显示与实际生效 Provider 不一致(切换功能本身正常)
- [ ] 可执行插件沙箱(Extension API、运行时权限强制):当前 Skill 仅声明式,`memoryScopes` 只做校验与展示,未做运行时强制
- [ ] PDF/Office 文档解析(需新增依赖,如 pdf-parse/mammoth;当前 pnpm 供应链策略下安装受限,待用户确认后引入)
- [x] 打包应用(win-unpacked)冒烟验收:窗口启动、`/health` 200、数据落 `%APPDATA%\XiyunAgent\app.db`(2026-10-06)
- [x] Shell 边界实测(2026-10-07):PowerShell、Git Bash 真实命令执行通过,三种 shell 均可探测;WSL 探测到但本机仅有 docker-desktop 发行版(无 bash),执行返回 exitCode 127 属环境限制非代码缺陷;shell 可读工作区外文件已修复(RISKS.md R-007 关闭)
- [ ] 已知模型行为:会话内模型答过"找不到资料"后,后续即使检索命中也倾向维持旧结论,换新会话即正常(prompt 层面未强制覆盖历史结论)

## 技术要点

- Node 24 原生运行 TypeScript(type stripping),Server 无构建步骤;打包态由 esbuild 打成 `apps/desktop/server.mjs`,用 Electron 内置 Node(加 `--experimental-sqlite`)运行。
- SQLite 用 Node 内置 `node:sqlite`(实验性),避免原生编译;FTS5 使用 `trigram` 分词以支持中文,<3 字符查询退化 LIKE;MATCH 整体短语化防语法冲突;短语无结果时退化为 3 字滑窗 OR 提升自然语言召回(2026-10-07,验收中发现纯短语匹配对长问句零召回)。
- 记忆:事实带有效期,更新=结束旧事实有效期;软删除不进检索;`hard=true` 彻底忘记;`scope` 取值 `global`/模式名/工作区路径,Chat 检索只含当前三层。
- 规则加载:全局 `data/rules/global.md`、模式 `data/rules/<mode>.md`、项目 `AGENTS.md`/`CLAUDE.md` 按序拼接进 system,项目规则最后优先级最高。
- Chat 路由:优先激活 Provider(`activeProvider()`),无激活 Provider 时以 `main` 角色兜底。
- 子智能体调度(阶段 3):`ModelRole` 扩展出 coder/reviewer/tester/researcher/tutor 绑定标签;子任务严格按角色解析模型,未绑定即失败、不回退未授权模型,临时覆盖需显式 `providerId`;只读角色(reviewer/researcher/tutor/memory)可并行,写角色(coder/tester)同工作区串行;pipeline 只把上游 `result.summary` 注入下游;子智能体读筛选后的模式/工作区记忆,产出只进候选区;结构化结果要求模型输出 ```json 块(status/summary/artifacts/changedFiles/risks/memoryCandidates),解析失败按纯文本兜底。
- 记忆工具(补齐):`memchat.ts` 只在消息含意图词(记住/忘掉/别记等)时调一次小模型解析 JSON;remember 直接写事实(source=chat:cmd),forget 检索命中后软删除;FTS 召回为空时 `MemoryStore.recent` 兜底返回最近有效事实。
- 工具层(阶段 4):PathGuard 复用 `assertInside`;命令三级分类——deny(rm -rf 根、format、shutdown、递归强删等直接拒绝,确认也不放行)、safe(git status/diff/log、ls、测试命令等免确认)、confirm(其余须 confirmed=true,API 返回 409 needsConfirm);命令参数含盘符/绝对路径/`~/`/`..` 时白名单命令也升级为 confirm(R-007);git commit 强制 confirmed;子智能体用 ```tool JSON 块协议调用工具(≤5 轮,不依赖 function calling),coder 可写文件,reviewer/tester/researcher 只读。
- Work 工具(阶段 5):文档导入仅支持 Markdown/TXT/HTML/粘贴/网页抓取(PDF/Office 待引入依赖);网页抓取仅 GET + 20s 超时 + 500KB 上限,HTML 用正则抽正文;检索整句 LIKE 无命中时退化 3 字滑窗 OR 按命中片段数排序;待办独立于子智能体 tasks 表。
- Skill(阶段 6):声明式目录 `skill.json` + `SKILL.md`,存 `data/skills/`;ZIP 导入 win32 优先 System32 bsdtar,GNU tar 加 `--force-local`;modes/roles 空=不限制,主对话按 "main" 角色匹配;注入 chat 与 code 子智能体 system;同 id 重导入=升级且保留启用状态;可执行插件沙箱未实现,权限字段仅校验/展示。
- API Key 只存 `data/config.json`(打包态 `%APPDATA%\XiyunAgent`),列表接口返回掩码,提交掩码或空值保留原 Key。
- Chat Markdown:代码高亮 + 数学公式(katex/highlight.js 本地 vendor,无 CDN)。

## 接续规则

继续开发前先读本文件和 [RUNBOOK.md](RUNBOOK.md)。若任务涉及路径、模块归属或同步边界,再读 [MAP.md](MAP.md);若涉及安全、权限或架构冲突,再读 [DECISIONS.md](DECISIONS.md) 和 [RISKS.md](RISKS.md)。

<!-- retest marker -->
