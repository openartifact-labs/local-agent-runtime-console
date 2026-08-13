# 贡献指南

感谢参与 Local Agent Runtime Console。项目面向中国用户，Issue、Pull Request 和主要文档优先使用中文；代码标识和专有名词可以保留英文。

## 协作渠道

- GitHub 是唯一的主开发仓库、Issue、Pull Request 和 Release 渠道。
- Gitee 是同步镜像，请不要在两处重复提交同一问题或修改。
- 安全漏洞不要创建公开 Issue，请遵循 [安全策略](SECURITY.md)。

## 开始之前

1. 搜索现有 Issue，确认问题没有重复。
2. 较大的功能、Provider 接入、架构或隐私边界改动应先创建 Issue 讨论。
3. 阅读 [项目概览](docs/项目概览.md)、[领域上下文](CONTEXT.md)和[架构决策](docs/专题/架构决策.md)。
4. Fork GitHub 仓库，从最新 `main` 创建短生命周期分支。

分支名建议：

- `fix/<topic>`：缺陷修复。
- `feat/<topic>`：功能开发。
- `docs/<topic>`：文档改进。
- `chore/<topic>`：工程维护。

## 本地验证

前置条件为 Node.js 20+、pnpm 11+，以及用户自行安装并登录的 Codex CLI。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

只修改文档时至少执行 `git diff --check`，并检查链接、中文编码和隐私信息。

## Pull Request 要求

- 一个 Pull Request 只解决一个清晰问题。
- 说明背景、方案、影响范围、验证结果和未验证平台。
- 行为变化需要测试；配置、架构和用户流程变化需要同步文档。
- 不提交构建产物、日志、`.env`、SQLite 数据库和本机缓存。
- 不包含真实提示词、输出、个人路径、私有地址、账号信息和凭据。
- 新依赖必须说明用途、许可证、跨平台支持和体积影响。
- UI 变化建议附桌面与窄屏脱敏截图，并检查中文文本不溢出。

## Provider 贡献

当前只有 `CodexProvider`。新增 Provider 前请先讨论，并遵守：

1. Provider 专有协议与状态只存在于独立适配层。
2. 通用领域模型不增加只服务单一 Provider 的字段。
3. 用 capability 表达功能差异，不伪造不支持的能力。
4. 覆盖连接、断线、重连、分页、超时和不完整事件测试。
5. 明确安装、登录、数据目录和隐私边界。

## SQLite 贡献

- 迁移必须版本化、可重复检查并在事务边界内执行。
- 已发布迁移不得原地修改。
- 需要覆盖全新数据库、旧版本升级、失败回滚和备份恢复。
- 测试数据必须是虚构数据，不能提交真实用户数据库。

## 许可证

提交贡献即表示你有权提交该内容，并同意贡献按本项目的 [Apache License 2.0](LICENSE) 发布。请勿复制许可证不兼容或来源不明的代码、素材和文档。
