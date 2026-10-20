# 第一阶段任务

## 目标

完成可运行的 Windows 桌面骨架和 Chat 闭环，为记忆、子智能体和 Code 模式留下稳定接口。

## 任务顺序

1. 初始化 pnpm workspace、TypeScript、Electron、React、Vitest 和基础 CI。
2. 接入 Pi Runtime，建立 Provider 配置和主 Agent 会话接口。
3. 建立本地 Agent Server，默认绑定 `127.0.0.1`。
4. 建立 Electron 窗口、设置页和 Chat 页面。
5. 实现 Chat 模式、会话持久化、Markdown 和流式响应。
6. 实现规则文件加载、全局/模式/项目工作区边界。
7. 实现 SQLite 记忆表、事实来源、软删除和 FTS5 检索接口。
8. 实现模型注册表和 `memory`、`researcher`、`coder` 等角色标签。
9. 接入主题、字体、字号、密度和主题导入导出。
10. 用 Windows 安装包跑通 Chat 验收。

## Chat 验收

导入一份学习资料，完成总结、解释、题目生成和错题记录；重新打开会话后，Agent 能恢复学习进度，并能用自然语言查看或删除记忆。

## 后续阶段

完整实施方案见 [后续阶段实施与设计方案](implementation-roadmap.md)。

- 阶段 2：记忆提取、候选确认和完整管理页。
- 阶段 3：子智能体调度、模型池和结构化任务结果。
- 阶段 4：Code 模式、Windows 命令执行、Git、测试和 diff 审查。
- 阶段 5：Work 模式和文档工具。
- 阶段 6：Skill、插件和权限系统完善。
- 阶段 7：Windows 安装包、升级、回滚和完整验收。
