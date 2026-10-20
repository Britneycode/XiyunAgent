# 运行与验收手册

## 前置条件

- Windows 10/11
- Node.js v24.14.0(原生运行 TS、内置 `node:sqlite`,无原生编译依赖)
- pnpm 10.33.0(不要依赖 corepack 的 `packageManager` 字段,因其 pnpm 12.9.1 shim 已损坏)
- Electron ^35(electron-builder 配置在 `apps/desktop/package.json`,未实际打包)
- Pi Runtime:未定版本,当前以 `packages/runtime` 的 `ChatProvider` 接口隔离,OpenAI-compatible Provider 先行
- Provider 配置:在设置页添加 OpenAI-compatible Provider(baseUrl/apiKey/model)

不要把 API Key 写入仓库、日志或示例配置。Key 仅存 `data/config.json`。

## 开发启动

```powershell
pnpm install
pnpm dev          # 同时启动 Server(127.0.0.1:3777)和 Web(5173)
pnpm dev:desktop  # 另开终端启动 Electron
```

分开启动 Server、Web 或 Electron 时,使用对应 workspace 的脚本,不在应用目录重复安装依赖。

## 基础检查

```powershell
pnpm typecheck
pnpm test
pnpm build
curl http://127.0.0.1:3777/health
```

注意(2026-10-07 起):pnpm 配置了 `verifyDepsBeforeRun` 与供应链 `minimumReleaseAge` 策略,`pnpm run` 前会强制预安装,新发布的 vite/electron-to-chromium 会触发拒绝导致脚本跑不起来。此时绕过 pnpm 直接调用 `.pnpm` 下的二进制:

```powershell
node node_modules\.pnpm\typescript@5.9.3\node_modules\typescript\bin\tsc --noEmit
node node_modules\.pnpm\vitest@3.2.7_*\node_modules\vitest\vitest.mjs run
```

若误触发失败预安装导致 `node_modules/@types/node` 链接丢失,用 junction 重建:
`New-Item -ItemType Junction -Path node_modules\@types\node -Target <仓库绝对路径>\node_modules\.pnpm\@types+node@24.19.1\node_modules\@types\node`

每次修改 Agent、记忆、权限或工具边界后,至少运行类型检查和相关测试。涉及 Electron 打包时追加 Windows 安装包构建检查(见下节)。

### 工具定义下发开关(2026-10-21 起)

主对话 /chat 默认不向模型下发工具定义(工具调用只展示,不执行)。需要模型在主对话发起工具调用时:

```powershell
$env:XIYUN_EXPOSE_TOOLS = "1"
pnpm dev
```

生效条件(三者同时满足):环境变量为 `1`;Provider 配置的 capabilities 含 `tools`;会话已绑定工作区。仅下发只读工具定义(list_files/read_file 等),无执行循环——模型请求工具后由前端展示调用卡片,不会自动执行。

## Windows 安装包

```powershell
pnpm dist   # = Web 构建 + esbuild 打包 Server(apps/desktop/server.mjs) + electron-builder
```

本机网络访问 GitHub 超时,构建前需设置镜像(可写入 shell 配置或 CI 环境):

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

产物在 `apps/desktop/dist/`:`XiyunAgent Setup 0.0.0.exe`(NSIS 安装包)和 `win-unpacked/`(免安装目录)。打包冒烟验收:运行 `win-unpacked/XiyunAgent.exe`,窗口出现且 `curl http://127.0.0.1:3777/health` 返回 `{"ok":true}`,数据落在 `%APPDATA%\XiyunAgent\app.db`(2026-10-06 已通过)。

已知问题:非管理员终端解压 winCodeSign 缓存会因符号链接权限报错(仅 darwin 文件)。若首次构建失败,手动用 7za 解压 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*.7z` 到同目录 `winCodeSign-2.6.0\`,并用真实文件补齐 `darwin\10.12\lib\libcrypto.dylib`、`libssl.dylib` 两个符号链接后重试;解压成功一次后缓存长期有效。

Chat 页 Markdown 渲染使用 `apps/web/public/vendor/` 下的本地库(katex、highlight.js),由 Vite 构建自动带入 `dist/vendor/`,无 CDN 依赖。

## 第一阶段验收

1. Windows 上可启动 Electron 窗口。
2. 本地 Agent Server 只监听 `127.0.0.1`,健康检查成功。
3. 可配置一个 OpenAI-compatible Provider,API Key 不显示在日志中。
4. Chat 会话可以流式接收回复、重启后恢复历史。
5. 设置页可修改主题、普通字体、代码字体、字号和界面密度,并实时预览。
6. 导入学习资料后,可以总结、解释、生成题目和记录错题。
7. 删除或彻底忘记记忆后,检索结果符合对应语义。

## 高风险操作验收

后续 Code/Work 模式验收必须确认:工作区外路径、文件删除/覆盖、命令执行、Git 提交/推送、部署和向第三方模型发送客户资料均能触发确认或拒绝。

## 阶段 4(Code 工具)验收

1. Code 会话绑定项目工作区(`PATCH /sessions/:id` 或 Code 页工作区栏)。
2. `POST /tools/shell` 执行 `git status` 免确认;执行 `git push` 返回 409 `needsConfirm`;执行 `rm -rf /` 等危险命令直接拒绝(带 confirmed 也拒绝)。
3. `/tools/read`、`/tools/write` 只能访问工作区内路径,越权返回 400。
4. `POST /tools/git/commit` 未带 `confirmed:true` 返回 409;确认后提交并写 `git.commit` 审计事件。
5. code 模式派发 coder 任务,模型通过 ```tool 块读写文件/跑命令(≤5 轮);reviewer/tester 无 files.write。
6. Web Code 页:Diff 抽屉显示 status + diff;终端抽屉非白名单命令弹确认条;提交抽屉需输入信息并点"确认提交"。

## 阶段 5(Work 工具)验收

1. Work 会话绑定工作目录;`POST /work/docs/import-file` 导入工作区内文件(越权 400),HTML 文件自动抽正文。
2. `POST /work/docs/import-url` 抓取网页并记录来源 URL;`POST /work/docs/paste` 粘贴导入。
3. Work 对话提问时检索已导入文档并注入片段,回答应标注来源(文档标题/URL)。
4. `/work/todos` 待办支持添加、截止日期、完成/重开、删除;按工作目录隔离。
5. 外部发送、修改原文件、批量操作仍需用户确认(Work 页不提供自动外发入口)。

## 阶段 6(Skill)验收

1. `POST /skills/import` 导入目录或 ZIP(系统 tar 解压),返回 manifest + warnings;导入后不自动启用。
2. 缺 `SKILL.md`、无效 id/version 的 Skill 被拒绝。
3. 启用后注入对应模式/角色的对话与子智能体;禁用后立即不再注入。
4. 同 id 重新导入(升级)版本更新且保留启用状态。
5. 设置页「Skill」可导入/启用/禁用/删除;「权限与安全」显示已启用 Skill 的权限声明与最近审计日志。
6. 示例 Skill 在 `examples/skills/`(备考教练/需求分析/代码审查),导入即用。

## 阶段 7(交付与升级)

### 版本基线

- Node 24.14.0 / pnpm 10.33.0 / Electron ^35 / electron-builder ^25;Pi Runtime 未定版本(以 `ChatProvider` 接口隔离)。
- 数据库 schema 版本用 `PRAGMA user_version` 管理(`packages/server/src/db.ts` 的 `MIGRATIONS`),新增迁移追加一条,不要改历史迁移。

### 升级与回滚

- 覆盖安装:直接运行新版 NSIS 安装包;数据在 `%APPDATA%\XiyunAgent\`,升级不动数据目录。
- 迁移自动备份:Server 启动检测到库版本落后时,先复制到 `%APPDATA%\XiyunAgent\backups\app-<时间戳>.db` 再迁移;也可手动 `POST /admin/backup`。
- 回滚:卸载新版 → 重装旧版安装包 → 若新版迁移过数据库,把 `backups/` 里升级前的备份改名回 `app.db`。
- 崩溃恢复:打包态 Server 崩溃自动重启(递增退避,上限 5 次),超限弹窗提示。

### 已知问题(2026-10-07)

- 会话内模型答过"找不到资料"后倾向维持旧结论,换新会话即正常。
- WSL shell 仅在安装了带 bash 的发行版时可用(仅有 docker-desktop 时 exitCode 127)。
- PDF/Office 文档解析未支持(需引入 pdf-parse/mammoth,pnpm 供应链策略下待确认)。
- 可执行插件沙箱未实现,Skill 为声明式,权限字段仅校验与展示。
