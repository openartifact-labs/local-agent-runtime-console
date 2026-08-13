# Local Agent Runtime Console Desktop

Electron 桌面壳只负责本地服务生命周期、窗口安全和跨平台分发，不承载业务状态，也不接触 Codex 账号密码。桌面主进程通过 API 导出的 `startRuntimeServer` 在同一进程内启动服务，便于安全地管理嵌入式 SQLite 和退出清理。

## 运行方式

先构建 API 和 Web，再启动桌面壳：

```bash
pnpm --dir packages/contracts build
pnpm --dir apps/api build
pnpm --dir apps/web build
pnpm --dir apps/desktop dev
```

开发时可让 Electron 加载 Vite：

```bash
LARC_WEB_URL=http://127.0.0.1:4317 pnpm --dir apps/desktop dev
```

Windows PowerShell：

```powershell
$env:LARC_WEB_URL='http://127.0.0.1:4317'
pnpm --dir apps/desktop dev
```

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `LARC_WEB_URL` | 开发态 Vite 地址，只允许本机 HTTP(S) 地址 |
| `LARC_API_URL` | 连接已经启动的本机 API，设置后桌面壳不再调用 `startRuntimeServer` |
| `LARC_API_PORT` | 开发态本地 API 端口，默认 `4318` |
| `LARC_API_ENTRY` | 开发或诊断时覆盖 API 构建入口 |

生产态会加载打包在 `resources/api/index.js` 的 API 模块，并加载该 API 托管的 Web 静态资源。SQLite 文件和其他运行数据必须写入 Electron 提供的 `userData` 目录，不得写入安装目录。

## API 对接契约

API 构建入口必须导出：

```ts
startRuntimeServer(options: {
  host?: string;
  port?: number;
  dataDir?: string;
  staticRoot?: string;
}): Promise<{ url: string; close(): Promise<void> | void }>
```

开发态端口默认传入 `4318`，以匹配现有 Vite 代理；生产态传入 `0`，由 HTTP 服务分配随机空闲端口。`dataDir` 固定使用 Electron `userData`，生产态 `staticRoot` 指向打包后的 `resources/web`，源码对应 `apps/web/dist`。

API 必须满足：

1. `GET /api/health` 在基础设施和路由可用后返回 `2xx`。
2. 生产态托管 `WEB_STATIC_DIR`，未知非 API 路由回退到 `index.html`。
3. 基于 `dataDir` 创建 SQLite，不依赖 MySQL，也不向安装目录写数据。
4. `close()` 关闭 Codex 子进程、SSE、数据库连接和 HTTP 监听，并允许重复调用。
5. `apps/api/dist` 必须是可动态导入的 ESM 产物，运行依赖需一并打包或复制。
