# XiyunAgent 后续阶段实施与设计方案

本文以阶段 1 已完成的 Electron、Web、Server、SQLite 记忆和 Chat Provider 为基线，定义阶段 2–7 的实施顺序、模块边界、数据协议和验收标准。

## 总体实施原则

每个阶段都必须有可独立运行的增量结果。新增能力通过 Server API 和共享类型暴露，Web/Electron 只消费协议，不直接操作数据库或模型。所有外部模型调用经过 Provider 层，所有文件和命令能力经过工具层，所有记忆写入经过 Memory Service。

推荐交付节奏：每阶段先建立数据模型和服务接口，再实现最小 UI，最后补权限、失败恢复和验收测试。阶段之间不共享未定义的内部对象。

前端页面、布局、主题、字体和交互状态统一遵循 [前端 UI 设计方案](frontend-ui-spec.md)。

主题预设、主题包校验和字体回退属于前端基础能力，阶段 1 已有的主题设置继续扩展为预设主题网格；阶段 6 只负责主题包导入，不把主题包当作可执行插件。

## 阶段 2：记忆提取、候选确认和管理页

### 目标

把阶段 1 的手动记忆 API 扩展为异步候选记忆流水线，并提供可搜索、可编辑、可删除的记忆管理页。

### 设计

新增 `MemoryCandidate`、`MemoryFact`、`MemoryEvent` 和 `MemorySource` 类型。候选记忆包含来源会话、模式、工作区、置信度、原因和建议动作。提取任务在回复完成、文档导入、任务完成和用户明确说“记住”时排队执行，不阻塞主回复。

事实更新采用有效期：新事实确认后设置旧事实 `valid_to`，不覆盖历史。普通删除设置 `deleted_at`；“彻底忘记”删除原文、事实、索引和缓存。检索优先级为当前指令、项目规则、当前有效事实、最近事件、历史事件、全局偏好。

### 实施任务

1. 扩展 SQLite 表和迁移版本。
2. 增加 `memory.extract`、`memory.confirm`、`memory.reject`、`memory.forget` API。
3. 增加专用 `memory` Provider 角色和失败重试队列。
4. 实现 FTS5 + LIKE 退化检索，并保留可替换向量接口。
5. 增加 Web 记忆页：按范围、类型、置信度、时间筛选。
6. 增加审计事件和自然语言管理工具。

### 验收

对话中产生的偏好和学习进度进入候选区；确认后可检索；修改会结束旧事实有效期；普通删除不再召回；彻底忘记后原文、事实和索引均不可检索。

## 阶段 3：子智能体调度、模型池和结构化结果

### 目标

支持从模型池选择子智能体模型，按角色调度最多三个任务，并在主 Agent 中合并结构化结果。

### 设计

新增 Model Registry、Role Policy 和 Task Scheduler：

```text
Model Registry: provider, model, capabilities, allowed_roles
Role Policy: coder, reviewer, tester, researcher, tutor, memory
Task: queued -> running -> completed/failed/cancelled/waiting_for_user
```

子智能体读取经过筛选的模式/工作区记忆，不能直接写长期记忆。结果必须包含 `status`、`summary`、`artifacts`、`changed_files`、`risks` 和 `memory_candidates`。只读任务可以并行；修改同一工作区的任务串行。主 Agent 只把结构化结果和必要摘要传给后续任务。

### 实施任务

1. 抽象 Provider 能力探测、模型注册和角色绑定。
2. 实现任务持久化、取消、重试和恢复。
3. 实现 `run`、`parallel`、`pipeline` 三种调度方式。
4. 增加模型临时覆盖、授权范围和备用模型回退。
5. 增加 Web 子任务面板，显示模型、状态、耗时和结果摘要。
6. 为 Chat 的资料检索/讲题和 Code 的 coder/reviewer/tester 建立预设。

### 验收

一次任务可按角色启动最多三个子智能体；并行只读任务不会互相覆盖；主 Agent 能合并结果；中断后重启 Server 可以恢复未完成任务；未授权模型不会被自动回退使用。

## 阶段 4：Code 模式、Windows 工具和 Git 审查

### 目标

完成第三方供应商项目的安全编码闭环：分析、修改、测试、查看 diff、确认提交。

### 设计

Code 会话绑定一个项目工作区。工具层分为 `files.read`、`files.write`、`shell.exec`、`git.status`、`git.diff`、`git.commit` 和 `tests.run`。PathGuard 将所有路径解析到授权根目录；shell 工具记录 shell 类型、工作目录、实际命令和退出码。

权限默认如下：

```text
reviewer / planner: 只读
tester: 运行测试，不修改生产文件
coder: 修改当前工作区，不自动提交
commit / push / deploy: 必须确认
```

Windows 首先支持 PowerShell、Git Bash 和 WSL。命令执行前展示命令、工作目录和可能影响的文件；工作区外访问、删除、覆盖和外发需要确认。

### 实施任务

1. 实现 PathGuard、命令 allowlist 和 shell adapter。
2. 增加文件读写、diff、Git 和测试工具。
3. 增加 Code 模式 system prompt、任务交接摘要和项目规则加载。
4. 接入 coder、reviewer、tester 子智能体 pipeline。
5. 增加 diff 审查页和逐项确认。
6. 增加 Windows/WSL 分 shell 测试。

### 验收

选择项目后，主 Agent 能委派分析、实现、测试和审查；所有修改可查看 diff；测试失败会回传给 coder；提交前必须确认；越权路径和危险命令被拒绝或拦截。

## 阶段 5：Work 模式和文档工具

### 目标

支持供应商需求、会议资料、网页调研和任务记录，形成可追溯的工作区。

### 设计

Work 会话绑定工作目录，工具分为文件、网页阅读、文档解析、任务记录和导出。网页工具默认受控浏览器会话，不让任意网页访问本地 Server。导入文档保留原文、来源和页码，摘要和结论必须能回链到来源。

### 实施任务

1. 增加 PDF/Markdown/HTML/Office 文档导入接口。
2. 增加网页抓取、正文抽取和来源记录。
3. 增加任务、待办、截止日期和状态模型。
4. 增加需求分析、会议纪要和供应商沟通 Skill。
5. 增加 Work 工作区浏览和来源引用 UI。

### 验收

导入供应商需求和会议记录后，Agent 能生成结构化需求、待办和风险，并能定位到原文；跨会话可恢复工作区状态；外部发送仍需用户确认。

## 阶段 6：Skill、插件和权限系统完善

### 目标

形成可迁移的 Skill/插件生态，同时保持本地权限边界。

### 设计

Skill 是声明式目录或 ZIP：`SKILL.md`、示例、资源和元数据。插件通过 Extension API 注册工具、Provider、页面、路由或后台任务。安装和启用分开，权限包含 `filesystem`、`network`、`shell`、`background`、`memory_scopes`。

插件生命周期：导入 -> 静态检查 -> 显示权限 -> 用户启用 -> 运行 -> 禁用/卸载。restricted 插件不能执行 shell；full-access 插件必须明确声明并写入审计日志。

### 实施任务

1. 定义 Skill manifest、版本和兼容性字段。
2. 定义插件 API、权限声明和沙箱上下文。
3. 实现目录/ZIP 导入、校验、启用和禁用。
4. 实现 Skill 匹配、模式限制和模型角色限制。
5. 增加插件管理页、权限详情和审计记录。
6. 编写内置 Chat/Work/Code 示例 Skill。

### 验收

本地 ZIP 可以导入但不会自动启用；启用前可看到工具和权限；插件不能访问未声明的记忆或路径；禁用后工具立即不可用；升级不会覆盖用户配置。

## 阶段 7：Windows 交付、升级和完整验收

### 目标

交付可安装、可升级、可回滚的 Windows 桌面版本。

### 设计

Electron 主进程启动本地 Server，Server 健康检查通过后显示主窗口。打包产物必须包含 renderer、Server、数据库迁移和 Pi Runtime 所需依赖。更新只检查和提示，不自动安装；升级失败保留旧版本和用户数据。

### 实施任务

1. 固定 Node、pnpm、Electron 和 Pi 版本。
2. 建立生产构建、未签名测试包和安装包流程。
3. 增加数据库迁移、备份和失败恢复。
4. 增加启动、健康检查、崩溃和 Server 重启处理。
5. 运行 Chat、Work、Code、记忆、子智能体、插件和权限验收。
6. 输出变更记录、已知问题和回滚步骤。

### 验收

全新安装、覆盖升级、异常退出恢复和回滚均可完成；数据目录可迁移；API Key 不进入安装包、日志或导出文件；核心闭环在 Windows 上通过。

## 阶段依赖

```text
阶段 1 -> 阶段 2 -> 阶段 3 -> 阶段 4 -> 阶段 5
                    \\-> 阶段 6 -> 阶段 7
```

阶段 6 的插件 API 在阶段 2/3 就要预留类型边界，但不提前实现在线市场或复杂沙箱。阶段 7 不新增产品能力，只处理交付、迁移和验收。
