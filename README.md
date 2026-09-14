# Local Agent Runtime Console

面向中国用户的本地优先 AI Agent 运行观测台。项目用于发现本机 Agent 任务、从统一面板发起任务，并查看运行状态、事件、输出和 Token 使用情况。

> 当前版本为 `0.1.0` 开发基线：Provider 抽象、`CodexProvider`、SQLite 持久化和 Electron 桌面封装已经完成，安装包尚未发布到 GitHub Release。

## 核心原则

- **本地优先**：应用与数据默认运行、保存在用户电脑上。
- **隐私优先**：不收集 Codex 账号、密码、Token 或 Cookie，不提供代登录能力。
- **Provider 解耦**：领域模型不绑定单一 Agent，当前只接入 Codex。
- **事实优先**：只展示 Provider 或本机运行记录能够证明的状态，不推测不可观测信息。
- **中文优先**：界面和主要文档以中文为主，代码与专有名词保留英文。

## 当前能力

- 发现并汇总本机 Codex 任务。
- 展示任务状态、最近活动、工作目录和父子任务关系。
- 从面板发起受管任务，观察运行事件、输出快照和工具调用。
- 汇总本机可观测的 Token、模型、来源和 Skill 使用情况。
- 通过 REST 与 SSE 提供查询和实时更新能力。

## 观测边界

- Codex CLI 由用户自行安装、登录和维护，本项目不接触登录凭据。
- 全局任务只能展示 Codex 向本机暴露的状态；不能恢复其他进程未持久化的细粒度事件。
- 从观测台发起的受管任务可以获得更完整的运行事件和输出。
- Token 与额度数据来自本机可观测记录，不等同于账号跨设备账单或官方计费凭证。
- 任务内容、目录、命令和输出可能包含敏感信息，分享截图或日志前请主动脱敏。

## 技术架构

- Web：React、Vite、TypeScript
- Local API：Node.js、Fastify、TypeScript
- 实时更新：Server-Sent Events（SSE）
- Provider：`CodexProvider`，通过 `codex app-server` 的 stdio JSONL 接入
- 本地数据：开源桌面版以嵌入式 SQLite 为唯一持久化方案
- 桌面应用：Electron + electron-builder，支持构建 Windows、macOS 和 Linux 安装包

## 开发状态

开源桌面版迁移基线已完成，并通过 Windows 目录包启动验证。首个公开 Release 前仍需完成应用图标、安装包签名、校验值、macOS/Linux 真机验证和升级策略，因此当前版本适合开发与预览验证，不建议承载唯一副本的重要数据。

## Windows 源码安装与启动

当前版本不提供可直接下载的安装包。已安装并登录 Codex Desktop 的 Windows 用户，可以拉取源码后在 Codex 中输入：

```text
请阅读 INSTALL.md，并按文档完成安装和启动。
```

完整的环境检查、系统级操作确认边界、桌面构建、启动、快捷方式和更新流程见 [INSTALL.md](INSTALL.md)。项目内会构建 `release\win-unpacked\Local Agent Runtime Console.exe`；不会自动安装系统软件、修改系统环境或设置开机自启。

## 本地开发

开发者模式的前置条件和命令见 [本地开发与运行](docs/部署与运维.md)。标准开发入口为：

迁移完成后的标准开发入口将统一为：

```powershell
.\scripts\dev.ps1 -Target all -Action start
```

默认开发地址：Web `http://127.0.0.1:4317`，Local API `http://127.0.0.1:4318`。服务仅用于本机访问，不应暴露到公网或不可信网络。

## 文档

- [Windows 源码安装与启动](INSTALL.md)
- [项目概览](docs/项目概览.md)
- [功能目录](docs/功能目录.md)
- [系统架构](docs/架构.md)
- [配置说明](docs/配置.md)
- [本地开发与运行](docs/部署与运维.md)
- [迁移路线图](docs/迁移路线图.md)
- [架构决策](docs/专题/架构决策.md)
- [隐私说明](PRIVACY.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## 仓库与发布

- GitHub 主仓库：<https://github.com/openartifact-labs/local-agent-runtime-console>
- Gitee 同步镜像：<https://gitee.com/openartifact-labs/local-agent-runtime-console>

Issue、Pull Request 和 Release 以 GitHub 为准；Gitee 用于国内访问与代码镜像。请勿同时在两个平台重复提交同一问题。

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源。第三方组件仍适用其各自许可证。
