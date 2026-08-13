# Local Runtime API

本地 API 负责连接 Codex App Server、同步任务、持久化受管运行，并通过 REST/SSE 向桌面界面提供数据。

## 运行边界

- 默认仅监听 `127.0.0.1`。
- 使用 Node.js 内置 `node:sqlite`，数据只写入本机 SQLite。
- 不读取或保存 Codex 登录凭据。
- 桌面端通过 `startRuntimeServer` 传入用户数据目录、随机端口和 Web 静态目录。

## 开发命令

```bash
pnpm --filter @openartifact-labs/runtime-api db:migrate
pnpm --filter @openartifact-labs/runtime-api dev
pnpm --filter @openartifact-labs/runtime-api typecheck
pnpm --filter @openartifact-labs/runtime-api test
```
