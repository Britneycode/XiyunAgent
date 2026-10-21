# 路径与边界映射

本文件只保存当前有效映射。安装、发布和临时构建产物不在此记录。

## 当前仓库

| 路径 | 作用 | 状态 |
|---|---|---|
| `README.md` | 项目简介和设计原则 | 已有 |
| `docs/technical-spec.md` | 技术规格和边界 | 已有 |
| `docs/phase-1.md` | 第一阶段任务 | 已有 |
| `docs/frontend-ui-spec.md` | 前端布局、主题、字体和页面验收 | 已有 |
| `docs/implementation-roadmap.md` | 阶段 2–7 实施和设计方案 | 已有 |
| `PROJECT_INDEX.md` | 项目总入口和文档路由 | 已有 |
| `NOW.md` | 当前进度和接续入口 | 已有 |
| `MAP.md` | 路径与边界映射 | 已有 |
| `RUNBOOK.md` | 运行、构建和验收步骤 | 已有 |
| `DECISIONS.md` | 已确认设计决策 | 已有 |
| `RISKS.md` | 风险和触发条件 | 已有 |
| `history/` | 精简过程归档 | 已有 |

## 当前代码边界(阶段 7 已实现)

```text
apps/desktop/        Electron 主进程(main.mjs,探测 /health 后按需拉起 Server 子进程)
apps/desktop/server.mjs  esbuild 打包的单文件 Server(打包态运行;构建产物,由 pnpm build:server 生成)
apps/web/            React + Vite:App Shell(顶栏/模式切换/会话栏/右侧栏:候选 + 子任务 + 预览三标签)、Chat 页(块渲染 + 复合输入框)、Work 页、Code 页、记忆管理页、分类设置页
apps/web/src/CodePage.tsx  Code 页(工作区绑定 + Chat + Diff/终端/提交抽屉 + 非白名单命令确认条)
apps/web/src/WorkPage.tsx  Work 页(工作目录绑定 + 资料导入(文件/URL/粘贴)+ 文档查看(来源)+ 待办 + Chat)
apps/web/src/TasksPanel.tsx  子任务面板(派发单任务/并行/流水线预设,code 为 coder→tester→reviewer,work 为需求整理→讲解;waiting_for_user 应答框)
apps/web/src/SettingsPage.tsx  分类设置页(Provider 配置含能力标签 capabilities + 连通性探测;Skill 管理;权限与安全:权限声明 + 审计日志)
apps/web/src/theme.ts    主题系统(7 预设 + 自定义主题包导入导出 + token 微调,全部走 CSS 变量)
apps/web/src/chat/   Chat 工作台组件(markdown.ts 安全渲染/行号/代码块;blocks.tsx 思考块/工具卡片/引用胶囊;useChatStream.ts SSE 块状态机 + rAF 合批;Composer.tsx @引用//命令/模型下拉;PreviewPanel.tsx 右侧预览:工具/终端/产物/Diff)
apps/web/public/vendor/  本地前端库(katex、highlight.js,来自 YiyunAgent 旧项目),Chat 渲染用
packages/server/     Hono Agent Server:会话、Chat SSE(结构化块协议:text/thinking/tool 块 + block_end 快照 + XIYUN_EXPOSE_TOOLS 工具定义门控)、消息 blocks/aborted 落库、记忆(事实 + 候选)、提取流水线、子智能体任务、工具 API(/tools/git/diff 失败 400)、Work 文档/待办、Skill、审计、Provider 配置、规则加载
packages/server/src/extract.ts  异步记忆提取(memory 角色模型,低置信度只进候选,不阻塞 SSE)
packages/server/src/memchat.ts  自然语言记忆指令(意图词门槛 + JSON 解析,记住→写事实,忘掉→软删除)
packages/server/src/docs.ts     阶段 5 WorkStore(文档导入/网页抓取/HTML 抽取/检索/待办)
packages/server/src/skills.ts   阶段 6 SkillStore(manifest 校验、目录/ZIP 导入、启用状态、模式/角色匹配注入)
packages/server/src/tools.ts    阶段 4 工具层(shell 探测、命令三级分类、files/git/list 工具、角色工具矩阵、runTool)
packages/server/src/tasks.ts    TaskStore + Scheduler(run/parallel/pipeline、严格角色绑定、同角色回退链、waiting_for_user、code 模式 ```tool 工具循环 ≤5 轮、Skill 注入、取消/重试/启动恢复、结构化结果解析)
packages/server/src/db.ts     SQLite 打开 + PRAGMA user_version 迁移框架 + 迁移前自动备份(库旁 backups/)
packages/server/src/providers.ts  ProviderStore(配置持久化、角色注册、连通性探测 probeProvider)
packages/runtime/    ChatProvider 接口(含可选 streamEvents 结构化事件流)、OpenAI-compatible 实现(reasoning_content/tool_calls 解析)、ModelRegistry(byRole/byRoleAll)
packages/shared/     共享类型(ProviderConfig、ChatMessage、Fact、MemoryCandidate、SubagentTask、TaskResult、SessionMeta、ModelRole、ShellInfo、ShellResult、WorkDoc、Todo、SkillManifest、SkillInfo、ChatBlock、StreamEvent、RefPayload)
examples/skills/     内置示例 Skill(备考教练 exam-coach、需求分析 req-analysis、代码审查 code-review-cn)
scripts/dev.mjs      并行启动 Server + Web
data/                开发态本地数据(app.db、config.json、skills/),不提交仓库
```

## 目标代码边界(后续阶段)

```text
apps/cli/            CLI 入口
packages/agent/      主 Agent、模式和会话编排
packages/memory/     独立记忆包(当前并入 packages/server)
packages/subagents/  子智能体调度和模型路由
packages/tools/      文件、终端、Git、网页等工具
packages/settings/   配置、主题、字体和数据目录(当前主题在 apps/web/src/theme.ts)
packages/extensions/ Skill 与插件 API
```

## 数据边界

- 当前工作区是 Code/Work 工具的默认可访问范围。
- 全局、模式和项目记忆逻辑隔离。
- API Key 只进入本地配置，不进入会话、导出包或审计正文。
- 默认 Server 只绑定 `127.0.0.1`。
