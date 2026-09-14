# Windows 源码安装与启动

本项目当前提供 Windows 源码构建方式，不提供安装包下载。适用对象是已经安装并登录 Codex Desktop 的 Windows 用户。应用运行时仍需要用户自行安装并登录 Codex CLI；本项目不会读取、保存或要求用户提供账号密码、Token 或 Cookie。

> 推荐在 Codex Desktop 中打开本仓库后直接输入：`请阅读 INSTALL.md，并按文档完成安装和启动。`

## Codex 执行约定

当用户要求按本文件安装时，Codex 必须按以下边界执行：

1. 先完成环境检查，并说明每一项结果。
2. 缺少 Git、Node.js、pnpm 或 Codex CLI 时，只说明缺失项和官方安装入口；不得直接执行 `winget`、修改 `PATH`、安装系统软件或请求管理员权限。
3. 只有用户明确确认后，才可以执行系统级安装或环境变量修改。
4. 不得要求用户粘贴 Codex 账号密码、Token、Cookie 或其他登录凭据；Codex CLI 登录由用户通过其官方流程完成。
5. 不得执行 `git clean`、删除用户文件、清空 SQLite 数据或修改项目外的系统配置。
6. 项目内依赖安装、类型检查、测试、构建和启动可以自动执行。任何一步失败时，应停止后续操作，保留错误输出并给出下一步排查建议。
7. 创建桌面快捷方式前，必须单独询问用户是否同意；不得设置开机自启。

## 1. 获取源码

推荐使用 Git：

```powershell
git clone https://github.com/openartifact-labs/local-agent-runtime-console.git
Set-Location .\local-agent-runtime-console
```

国内访问也可以从 Gitee 获取：

```powershell
git clone https://gitee.com/openartifact-labs/local-agent-runtime-console.git
Set-Location .\local-agent-runtime-console
```

也可以下载仓库 ZIP 并解压后，在解压目录打开 Codex Desktop。不要把项目放进 OneDrive 等可能与 SQLite 文件冲突的同步目录。

## 2. 环境检查

在项目根目录执行：

```powershell
git --version
node --version
pnpm --version
codex --version
```

要求如下：

| 项目 | 最低要求 | 说明 |
| --- | --- | --- |
| Windows | Windows 10 或更高版本，x64 | 当前仅验证 Windows x64。 |
| Git | 已安装 | 用于拉取和更新源码；下载 ZIP 时可暂时缺失。 |
| Node.js | 22.13+ | 提供本地 API、SQLite 和构建运行时。 |
| pnpm | 11+ | 项目锁定的包管理器。 |
| Codex Desktop | 已安装并登录 | 用于按本文档自动完成项目内步骤。 |
| Codex CLI | 已安装并登录 | 应用通过本机 `codex app-server` 读取可观测数据。 |

若某一项缺失，先向用户说明，等待用户确认系统级安装后再继续。`codex --version` 成功不等于已登录；若应用提示 Provider 未连接，请让用户通过 Codex 官方流程完成登录。

## 3. 构建桌面程序

确认环境满足要求后，在项目根目录按顺序执行：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm desktop:pack
```

其中：

- `pnpm install --frozen-lockfile` 只安装锁定版本的项目依赖。
- `pnpm typecheck` 和 `pnpm test` 用于在启动前验证源码状态。
- `pnpm desktop:pack` 构建不需要管理员权限的 Windows 目录包，不生成或安装发布版 NSIS 安装程序。

构建成功后，桌面程序位于：

```text
release\win-unpacked\Local Agent Runtime Console.exe
```

启动命令：

```powershell
Start-Process -FilePath (Join-Path (Get-Location) "release\win-unpacked\Local Agent Runtime Console.exe")
```

首次启动会在 Windows 用户应用数据目录创建 SQLite 数据文件和运行数据。数据不上传到远程数据库，也不应提交到 Git。不要在应用运行时直接编辑 SQLite 文件。

## 4. 可选：创建桌面快捷方式

只有在用户明确同意后，才执行以下 PowerShell 命令。快捷方式指向当前项目目录中的构建产物；移动或删除项目目录后，应删除旧快捷方式并重新构建。

```powershell
$targetPath = (Resolve-Path ".\release\win-unpacked\Local Agent Runtime Console.exe").Path
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Local Agent Runtime Console.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = Split-Path $targetPath
$shortcut.Save()
```

本项目不创建开机自启项。删除快捷方式不会删除项目或本地 SQLite 数据。

## 5. 日常启动和更新

日常使用直接双击 `release\win-unpacked\Local Agent Runtime Console.exe` 或桌面快捷方式。

更新源码后，在项目根目录重新执行：

```powershell
git pull --ff-only
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm desktop:pack
```

若快捷方式仍指向同一项目目录，无需重新创建。更新前请先退出应用；SQLite 数据默认保留，项目升级会自动执行版本化迁移。重要数据应在更新前自行备份。

## 6. 常见问题

### 找不到 `pnpm`、`node` 或 `codex`

说明系统环境尚未满足要求。请先让用户确认是否允许安装缺失的软件；完成官方安装流程后，关闭并重新打开 Codex Desktop 或 PowerShell，再执行环境检查。

### `pnpm install --frozen-lockfile` 失败

确认 Node.js 版本不低于 `22.13`，并检查网络、代理和企业安全软件。不要为了绕过错误删除 `pnpm-lock.yaml` 或改用其他包管理器。

### 应用启动后显示 Provider 未连接

确认 `codex --version` 可执行，并在独立终端确认 Codex CLI 已完成官方登录。观测台不代管登录，也不会接收登录凭据。

### 任务或历史数据看不到

应用只展示本机可观测到的 Codex 会话与事件；它不是账号跨设备账单或云端任务中心。首次启动后等待同步完成，再检查筛选条件。

### 如何清理本地数据

先退出应用，再在 Windows 用户应用数据目录中定位应用的 Electron `userData` 目录，并备份后删除其中的 SQLite 文件。此操作会清除本地观测历史，不能恢复；不要删除源码目录中的 `release` 以外文件来代替清理数据。

## 开发者模式

需要修改代码时，再使用开发服务：

```powershell
.\scripts\dev.ps1 -Target all -Action start
```

开发服务默认只监听本机回环地址。更多开发诊断、配置和发布边界见 [docs/部署与运维.md](docs/部署与运维.md)。
