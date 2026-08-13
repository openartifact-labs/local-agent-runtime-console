<#
.SYNOPSIS
按组件管理 AI Runtime Console 本地开发服务。

.DESCRIPTION
脚本只管理由自身启动并记录 PID 的进程。start 不会重启已运行组件；只有显式使用
restart 才会先停止再启动。省略 Target 时显示交互菜单。

.PARAMETER Target
目标组件：api、web 或 all。

.PARAMETER Action
操作：start（默认）、restart、stop、status 或 logs。

.PARAMETER Tail
logs 操作显示的末尾行数，默认 80。

.EXAMPLE
.\scripts\dev.ps1 -Target api -Action start

.EXAMPLE
.\scripts\dev.ps1 -Target web -Action logs -Tail 120
#>
[CmdletBinding()]
param(
    [ValidateSet("api", "web", "all")]
    [string]$Target,

    [ValidateSet("start", "restart", "stop", "status", "logs")]
    [string]$Action = "start",

    [ValidateRange(1, 5000)]
    [int]$Tail = 80
)

$ErrorActionPreference = "Stop"
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stateDirectory = Join-Path $repoRoot ".runtime\dev"
$componentDefinitions = @{
    api = @{
        Label = "API"
        Port = 4318
        Filter = "@openartifact-labs/runtime-api"
    }
    web = @{
        Label = "Web"
        Port = 4317
        Filter = "@openartifact-labs/runtime-web"
    }
}

function Select-Target {
    Write-Host "请选择要操作的组件："
    Write-Host "  1. api"
    Write-Host "  2. web"
    Write-Host "  3. all"
    $selection = Read-Host "输入序号"
    switch ($selection) {
        "1" { return "api" }
        "2" { return "web" }
        "3" { return "all" }
        default { throw "无效选择：$selection" }
    }
}

function Get-SelectedComponents {
    param([Parameter(Mandatory)][string]$SelectedTarget)

    if ($SelectedTarget -eq "all") {
        return @("api", "web")
    }
    return @($SelectedTarget)
}

function Get-StatePath {
    param([Parameter(Mandatory)][string]$Component)
    return Join-Path $stateDirectory "$Component.json"
}

function Get-LogPath {
    param(
        [Parameter(Mandatory)][string]$Component,
        [Parameter(Mandatory)][ValidateSet("stdout", "stderr")][string]$Stream
    )
    return Join-Path $stateDirectory "$Component.$Stream.log"
}

function Get-TrackedProcess {
    param([Parameter(Mandatory)][string]$Component)

    $statePath = Get-StatePath -Component $Component
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return $null
    }

    try {
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $process = Get-Process -Id ([int]$state.pid) -ErrorAction Stop
        $actualStartTime = $process.StartTime.ToUniversalTime().ToString("o")
        if ($actualStartTime -ne [string]$state.startedAtUtc) {
            Remove-Item -LiteralPath $statePath -Force
            return $null
        }
        return [pscustomobject]@{ State = $state; Process = $process }
    }
    catch {
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
        return $null
    }
}

function Get-ConfiguredApiPort {
    $envFile = Join-Path $repoRoot ".env"
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        return 4318
    }

    foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
        if ($line -match '^\s*API_PORT\s*=\s*["'']?(\d+)["'']?\s*$') {
            return [int]$Matches[1]
        }
    }
    return 4318
}

function Assert-PortAvailable {
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string]$Component
    )

    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if ($listeners.Port -contains $Port) {
        throw "端口 $Port 已被其他进程占用，无法启动 $Component。脚本不会停止未由自身管理的进程。"
    }
}

function Assert-StartPrerequisites {
    if (-not (Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue)) {
        throw "未找到 pnpm.cmd，请先安装 pnpm 11+。"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules") -PathType Container)) {
        throw "未找到 node_modules，请先在仓库根目录执行 pnpm install。"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".env") -PathType Leaf)) {
        throw "未找到 .env，请先从 .env.example 复制并填写本机配置。"
    }
}

function Build-Contracts {
    Write-Host "构建共享 contracts…"
    & pnpm.cmd --dir $repoRoot --filter "@openartifact-labs/runtime-contracts" build
    if ($LASTEXITCODE -ne 0) {
        throw "共享 contracts 构建失败。"
    }
}

function ConvertTo-EncodedCommand {
    param([Parameter(Mandatory)][string]$Command)
    return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
}

function Start-Component {
    param([Parameter(Mandatory)][string]$Component)

    $definition = $componentDefinitions[$Component]
    $tracked = Get-TrackedProcess -Component $Component
    if ($tracked) {
        Write-Host "$($definition.Label) 已在运行（PID $($tracked.Process.Id)），start 不会重启它。"
        return
    }

    $port = if ($Component -eq "api") { Get-ConfiguredApiPort } else { [int]$definition.Port }
    Assert-PortAvailable -Port $port -Component $definition.Label
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

    $pnpmPath = (Get-Command "pnpm.cmd").Source.Replace("'", "''")
    $filter = [string]$definition.Filter
    $command = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(`$false); `$OutputEncoding = [Console]::OutputEncoding; & '$pnpmPath' --dir '$($repoRoot.Replace("'", "''"))' --filter '$filter' dev; exit `$LASTEXITCODE"
    $stdoutPath = Get-LogPath -Component $Component -Stream stdout
    $stderrPath = Get-LogPath -Component $Component -Stream stderr
    $process = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-NonInteractive", "-EncodedCommand", (ConvertTo-EncodedCommand $command)) `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    Start-Sleep -Milliseconds 800
    $process.Refresh()
    if ($process.HasExited) {
        $errorTail = if (Test-Path -LiteralPath $stderrPath) {
            (Get-Content -LiteralPath $stderrPath -Tail 20 -Encoding UTF8) -join [Environment]::NewLine
        }
        else { "（无错误日志）" }
        throw "$($definition.Label) 启动进程提前退出。`n$errorTail"
    }

    [ordered]@{
        component = $Component
        pid = $process.Id
        startedAtUtc = $process.StartTime.ToUniversalTime().ToString("o")
        port = $port
        repoRoot = $repoRoot
    } | ConvertTo-Json | Set-Content -LiteralPath (Get-StatePath $Component) -Encoding UTF8
    Write-Host "$($definition.Label) 已启动（PID $($process.Id)，端口 $port）。"
}

function Stop-ProcessTree {
    param([Parameter(Mandatory)][int]$RootProcessId)

    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProcessTree -RootProcessId ([int]$child.ProcessId)
    }
    Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

function Stop-Component {
    param([Parameter(Mandatory)][string]$Component)

    $definition = $componentDefinitions[$Component]
    $tracked = Get-TrackedProcess -Component $Component
    if (-not $tracked) {
        Write-Host "$($definition.Label) 未由脚本启动或已经停止。"
        return
    }

    # 只有 PID 与创建时间都匹配状态文件时才递归停止，避免 PID 复用后误杀无关进程。
    Stop-ProcessTree -RootProcessId $tracked.Process.Id
    Remove-Item -LiteralPath (Get-StatePath $Component) -Force -ErrorAction SilentlyContinue
    Write-Host "$($definition.Label) 已停止。"
}

function Show-Status {
    param([Parameter(Mandatory)][string]$Component)

    $definition = $componentDefinitions[$Component]
    $tracked = Get-TrackedProcess -Component $Component
    if ($tracked) {
        Write-Host "$($definition.Label)：运行中（PID $($tracked.Process.Id)，端口 $($tracked.State.port)）"
    }
    else {
        Write-Host "$($definition.Label)：未运行（或不是由本脚本启动）"
    }
}

function Show-Logs {
    param([Parameter(Mandatory)][string]$Component)

    $definition = $componentDefinitions[$Component]
    foreach ($stream in @("stdout", "stderr")) {
        $path = Get-LogPath -Component $Component -Stream $stream
        Write-Host "--- $($definition.Label) $stream：$path ---"
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Get-Content -LiteralPath $path -Tail $Tail -Encoding UTF8
        }
        else {
            Write-Host "暂无日志。"
        }
    }
}

if (-not $Target) {
    $Target = Select-Target
}
$components = Get-SelectedComponents -SelectedTarget $Target

switch ($Action) {
    "start" {
        $componentsToStart = @($components | Where-Object { -not (Get-TrackedProcess -Component $_) })
        if ($componentsToStart.Count -gt 0) {
            Assert-StartPrerequisites
            Build-Contracts
        }
        foreach ($component in $components) { Start-Component -Component $component }
    }
    "restart" {
        foreach ($component in $components) { Stop-Component -Component $component }
        Assert-StartPrerequisites
        Build-Contracts
        foreach ($component in $components) { Start-Component -Component $component }
    }
    "stop" {
        foreach ($component in $components) { Stop-Component -Component $component }
    }
    "status" {
        foreach ($component in $components) { Show-Status -Component $component }
    }
    "logs" {
        foreach ($component in $components) { Show-Logs -Component $component }
    }
}
