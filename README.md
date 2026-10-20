# XiyunAgent

一个面向个人学习、日常工作和项目开发的本地优先 Agent。

XiyunAgent 基于 Pi Runtime，提供三个模式：

- `Chat`：自然对话、备考、资料整理和长期记忆。
- `Work`：文件、网页、文档和任务处理。
- `Code`：项目代码、终端、Git、测试和提交。

第一版目标是 Windows 桌面应用，同时保留本地 Web 和 CLI 入口。

## 设计原则

- 主 Agent 负责理解意图、保持人格、调度任务和汇总结果。
- 子智能体按角色使用用户选定的模型池，例如 `coder`、`reviewer`、`tester` 和 `researcher`。
- Skill 描述工作流程，插件提供程序能力。
- 记忆按全局、模式和项目隔离。
- 客户项目默认限制在当前工作区，敏感操作需要确认。
- 数据默认保存在本机，不要求账号登录，不自动同步云端。

## 文档

- [技术规格](docs/technical-spec.md)
- [第一阶段任务](docs/phase-1.md)

## 许可证

Apache-2.0
