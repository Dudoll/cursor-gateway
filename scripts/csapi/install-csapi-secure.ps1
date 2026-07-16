<#
.SYNOPSIS
  install-csapi-secure.ps1 — 抗 MITM「Secure Adapter」懒人一键安装（cg-mitm/1，Windows）

.DESCRIPTION
  与 install-csapi.ps1（方案 B，明文兼容通道）不同，本脚本配置的是**方案 A 的客户端**：
  本机 Secure Adapter。它在本机暴露 loopback 的 Anthropic/OpenAI 门面，把每次调用重新
  封装成 cg-mitm/1 密文发往 csapi 的 /cg/v1/*。明文只存在于 Adapter 进程内；对网络中间人
  （企业根证书 / mitmproxy）只见密文。

  安全锚点：离线固定（pin）一个 Ed25519 根指纹（$BuiltinPinnedRoots，或仓库
  scripts\csapi\trust\csapi-trust-root-public.json）。服务端下发的身份证书必须由该根
  签发，否则 Adapter fail-closed，绝不回退明文。

  「真·一键」做的事（默认 install / -Start）：
    1) 读取真实 CSAPI key（仅存本机 secure-adapter.env，ACL 收敛；永不进 git / HTTP header）；
    2) 探测 /cg/v1/server-keys 并核对固定根指纹（防 MITM / 防配错服务端）；
    3) 若本机没有仓库源码 → 自动 git clone（公开仓库；-NoClone 关闭）；
    4) 若依赖没装 → 自动在仓库根 npm install（-NoInstall 关闭；-Build 额外编译 dist）；
    5) 写 %USERPROFILE%\.cursor-gateway\secure-adapter.env + start-secure-adapter.cmd；
    6) 幂等写用户级环境变量：把 CLI 的 ANTHROPIC_*/OPENAI_* 指向本机 Adapter（用 loopback key）；
    7) -Start 拉起 Adapter；-Service 注册登录自启（计划任务）。

.PARAMETER Print     只打印将写入的配置，不写任何文件 / 环境变量 / 不 clone / 不装依赖。
.PARAMETER Uninstall 移除用户级 ANTHROPIC_*/OPENAI_* + 本机配置/启动器 + 自启任务。
.PARAMETER NoProbe   跳过 server-keys 探测（高级 / 预置场景）。
.PARAMETER Start     安装后立即在新窗口启动 Adapter。
.PARAMETER Service   安装并注册「登录自启」计划任务，然后启动。
.PARAMETER Setup     只准备仓库（clone + npm install [+ -Build]），不写配置。
.PARAMETER NoClone   找不到仓库也不自动 clone。
.PARAMETER NoInstall 不自动 npm install。
.PARAMETER Build     额外 npm run build 编译 dist（可选）。
.PARAMETER Yes       自动确认（clone 等无需交互）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-csapi-secure.ps1

.EXAMPLE
  $env:CSAPI_API_KEY="sk-xxxx"; .\install-csapi-secure.ps1 -Start

.NOTES
  本脚本不含任何真实 key。启动 Adapter 需仓库源码（apps\secure-adapter + npm install，node>=22）；
  仓库路径自动从脚本位置推断，也可用 $env:CSAPI_REPO_DIR 指定，或让脚本自动 clone。
#>

[CmdletBinding()]
param(
  [switch]$Print,
  [switch]$Uninstall,
  [switch]$NoProbe,
  [switch]$Start,
  [switch]$Stop,
  [switch]$Status,
  [switch]$Service,
  [switch]$Setup,
  [switch]$NoClone,
  [switch]$NoInstall,
  [switch]$Build,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

# ---- 内置离线固定根指纹（公开材料；私钥永不进仓库）--------------------------
# 轮换根时：同步更新此常量 + scripts\csapi\trust\csapi-trust-root-public.json。
$BuiltinPinnedRoots = 'sha256:E9OuniLwYNCVLPPwbG_aMimeFG3Ly1OFnhDplyQwy9g'

# ---- 可覆盖默认值 ----------------------------------------------------------
$BaseUrl     = if ($env:CSAPI_BASE_URL) { $env:CSAPI_BASE_URL.TrimEnd('/') } else { 'https://csapi.joelzt.org' }
$Upstream    = if ($env:CG_ADAPTER_UPSTREAM_URL) { $env:CG_ADAPTER_UPSTREAM_URL.TrimEnd('/') } else { $BaseUrl }
$ListenHost  = if ($env:CG_ADAPTER_LISTEN_HOST) { $env:CG_ADAPTER_LISTEN_HOST } else { '127.0.0.1' }
$ListenPort  = if ($env:CG_ADAPTER_LISTEN_PORT) { $env:CG_ADAPTER_LISTEN_PORT } else { '8788' }
$RepoGitUrl  = if ($env:CSAPI_REPO_GIT_URL) { $env:CSAPI_REPO_GIT_URL } else { 'https://github.com/Dudoll/cursor-gateway.git' }
$AssumeYes   = $Yes.IsPresent -or ($env:CSAPI_ASSUME_YES -eq '1')

$CfgDir      = Join-Path $env:USERPROFILE '.cursor-gateway'
$EnvFile     = Join-Path $CfgDir 'secure-adapter.env'
$Launcher    = Join-Path $CfgDir 'start-secure-adapter.cmd'
$StateFile   = Join-Path $CfgDir 'cg-mitm-adapter-state.json'
$CloneDir    = if ($env:CSAPI_CLONE_DIR) { $env:CSAPI_CLONE_DIR } else { Join-Path $CfgDir 'cursor-gateway' }
$AdapterBase = "http://${ListenHost}:${ListenPort}"
$TaskName    = 'CsapiSecureAdapter'

$vars = @('ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','OPENAI_BASE_URL','OPENAI_API_KEY')

function Write-Info { param($m) Write-Host "[csapi-secure] $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "[csapi-secure] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "[csapi-secure] $m" -ForegroundColor Red }
function Confirm-Yes { param($m)
  if ($AssumeYes) { return $true }
  $ans = Read-Host "[csapi-secure] $m [Y/n]"
  return ($ans -notmatch '^(n|no)$')
}

Write-Info "cg-mitm/1 Secure Adapter 安装器 (Windows)"
Write-Info "上游 csapi: $Upstream   本机 Adapter: $AdapterBase"

# ---- 定位仓库 --------------------------------------------------------------
function Resolve-Repo {
  if ($env:CSAPI_REPO_DIR -and (Test-Path (Join-Path $env:CSAPI_REPO_DIR 'apps\secure-adapter'))) {
    return (Resolve-Path $env:CSAPI_REPO_DIR).Path
  }
  if ($PSScriptRoot) {
    $cand = Resolve-Path (Join-Path $PSScriptRoot '..\..') -ErrorAction SilentlyContinue
    if ($cand -and (Test-Path (Join-Path $cand 'apps\secure-adapter'))) { return $cand.Path }
  }
  if (Test-Path '.\apps\secure-adapter') { return (Resolve-Path '.').Path }
  if (Test-Path (Join-Path $CloneDir 'apps\secure-adapter')) { return (Resolve-Path $CloneDir).Path }
  return $null
}
$RepoRoot = Resolve-Repo

# ---- 自动 clone ------------------------------------------------------------
function Invoke-CloneRepo {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Warn "未找到 git，无法自动 clone。请装 git，或手动 clone 后设 `$env:CSAPI_REPO_DIR。"
    return $null
  }
  if (Test-Path (Join-Path $CloneDir 'apps\secure-adapter')) {
    Write-Info "复用已存在的 clone: $CloneDir"; return (Resolve-Path $CloneDir).Path
  }
  if (-not (Confirm-Yes "本机未找到仓库源码。是否自动 clone $RepoGitUrl 到 $CloneDir？")) {
    Write-Warn "已跳过 clone。可手动 clone 并设 `$env:CSAPI_REPO_DIR，或用 -NoClone 静默此提示。"; return $null
  }
  New-Item -ItemType Directory -Path (Split-Path $CloneDir -Parent) -Force | Out-Null
  Write-Info "clone $RepoGitUrl → $CloneDir （首次较慢）..."
  git clone --depth 1 $RepoGitUrl $CloneDir
  if ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $CloneDir 'apps\secure-adapter'))) {
    return (Resolve-Path $CloneDir).Path
  }
  # 自愈：清理半残目录后自动再试一次。
  Write-Warn "git clone 失败，清理半残目录后自动重试一次..."
  Remove-Item -Recurse -Force $CloneDir -ErrorAction SilentlyContinue
  git clone --depth 1 $RepoGitUrl $CloneDir
  if ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $CloneDir 'apps\secure-adapter'))) {
    return (Resolve-Path $CloneDir).Path
  }
  Write-Err "git clone 两次均失败（网络 / 仓库可见性 / 认证）。请手动 clone 后设 `$env:CSAPI_REPO_DIR。"; return $null
}

# ---- npm install / build ---------------------------------------------------
function Install-Deps { param($Repo)
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warn "未找到 node（Adapter 需 node>=22）。请安装 Node 后重试；仅写配置不受影响。"; return
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Warn "未找到 npm。请在仓库根执行: npm install"; return
  }
  $tsx = Join-Path $Repo 'node_modules\.bin\tsx.cmd'
  if ((Test-Path $tsx) -and (-not $Build)) {
    Write-Info "依赖已就绪，跳过 npm install。"
  } else {
    Write-Info "在仓库根安装依赖: (cd $Repo; npm install) （首次较慢）..."
    Push-Location $Repo
    try {
      npm install
      if ($LASTEXITCODE -ne 0) {
        # 自愈：清理可能损坏的 node_modules 后自动再试一次。
        Write-Warn "npm install 失败，清理 node_modules 后自动重试一次..."
        Remove-Item -Recurse -Force (Join-Path $Repo 'node_modules') -ErrorAction SilentlyContinue
        npm install
      }
    } finally { Pop-Location }
  }
  if ($Build) {
    Write-Info "编译 Secure Adapter dist ..."
    Push-Location $Repo
    try { npm run build -w '@cursor-gateway/secure-adapter' } catch { Write-Warn "build 失败（不致命：启动器回退 tsx）。" } finally { Pop-Location }
  }
}

function Ensure-RepoReady {
  if (-not $RepoRoot -and -not $NoClone) { $script:RepoRoot = Invoke-CloneRepo }
  if (-not $RepoRoot) { Write-Warn "未定位到仓库源码：已完成配置，但启动 Adapter 需要仓库。"; return $false }
  Write-Info "仓库: $RepoRoot"
  if (-not $NoInstall) { Install-Deps -Repo $RepoRoot }
  return $true
}

# ---- 固定根指纹：优先仓库公开文件，回退内置常量 ----------------------------
function Resolve-PinnedRoots {
  if ($RepoRoot) {
    $pub = Join-Path $RepoRoot 'scripts\csapi\trust\csapi-trust-root-public.json'
    if (Test-Path $pub) {
      try {
        $j = Get-Content $pub -Raw | ConvertFrom-Json
        $fps = @($j.trustRoots | ForEach-Object { $_.fingerprint } | Where-Object { $_ })
        if ($fps.Count -gt 0) { return ($fps -join ',') }
      } catch {}
    }
  }
  return $BuiltinPinnedRoots
}

# ---- 探测 + 核对固定根 -----------------------------------------------------
function Test-ServerKeys {
  param($Pins)
  $url = "$Upstream/cg/v1/server-keys"
  Write-Info "探测 $url ..."
  $resp = $null
  for ($try = 1; $try -le 3; $try++) {
    try {
      $resp = Invoke-WebRequest -Uri $url -TimeoutSec 20 -UseBasicParsing
      break
    } catch {
      $code = $null
      try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
      if ($code -eq 404 -or $code -eq 426) {
        Write-Err "服务端未开启 cg-mitm 安全通道（/cg/v1/server-keys 返回 HTTP $code）。"
        Write-Err "这是**运维前置**，不是本机问题。请联系 csapi 管理员开启服务端安全通道："
        Write-Err "  · 需 CG_SECURE_ENABLED=true 且下发由固定根签发的服务端证书；"
        Write-Err "  · 保持 CG_REQUIRE_SECURE=false，让明文 /v1/* 与安全 /cg/v1/* 并行灰度；"
        Write-Err "  · 服务端下发的根指纹要与本安装器固定的一致：$Pins"
        Write-Err "开启后重跑本脚本即可。（如需先预置配置：加 -NoProbe 跳过探测。）"
        return $false
      }
      # 网络/5xx 抖动 → 有限重试（不适用于 404/426 那种“不可自愈”前置）。
      if ($try -lt 3) {
        Write-Warn "探测 server-keys 暂时失败（$($_.Exception.Message)），第 $try/3 次，$try s 后重试..."
        Start-Sleep -Seconds $try
        continue
      }
      Write-Err "无法探测 $url：$($_.Exception.Message)。请检查网络后重试。"
      return $false
    }
  }

  $advertised = @()
  try {
    $j = $resp.Content | ConvertFrom-Json
    $advertised = @($j.trustRoots | ForEach-Object { $_.fingerprint } | Where-Object { $_ })
  } catch {
    Write-Err "server-keys 响应无法解析 JSON → 拒绝配置（fail-closed）。"
    return $false
  }
  if ($advertised.Count -eq 0) {
    Write-Err "server-keys 未包含任何 trustRoots 指纹 → 拒绝配置（fail-closed）。"
    return $false
  }
  $pinList = $Pins -split ','
  $matched = $false
  foreach ($p in $pinList) { if ($advertised -contains $p) { $matched = $true; break } }
  if (-not $matched) {
    Write-Err "服务端下发的信任根指纹与本安装器固定的不一致 → 疑似 MITM 或服务端配置了不同的根。"
    Write-Err "  固定（期望之一）: $Pins"
    Write-Err "  服务端下发:       $($advertised -join ' ')"
    Write-Err "已拒绝写入任何配置（fail-closed）。请与管理员 out-of-band 核对根指纹。"
    return $false
  }
  Write-Info "server-keys OK：固定根指纹匹配 ✅（anti-MITM 信任锚已核对）。"
  return $true
}

# ---- Adapter 启停 / 自启 ----------------------------------------------------
function Start-Adapter {
  if (-not (Test-Path $Launcher)) { Write-Err "缺少启动器 $Launcher，请先安装（不带 -Start）。"; return }
  Write-Info "在新窗口启动 Adapter：$Launcher"
  Start-Process -FilePath $Launcher
  Write-Info "如窗口一闪而退，多半是 fail-closed；手动运行 $Launcher 查看错误。"
}

function Install-Service {
  if (-not (Test-Path $Launcher)) { Write-Err "缺少启动器 $Launcher，请先完成安装。"; return }
  try {
    schtasks /Create /SC ONLOGON /TN $TaskName /TR "`"$Launcher`"" /F | Out-Null
    Write-Info "已注册登录自启计划任务: $TaskName（登录时自动拉起 Adapter）。"
    Start-Adapter
  } catch {
    Write-Warn "注册计划任务失败：$($_.Exception.Message)。回退为手动启动。"
    Start-Adapter
  }
}

function Remove-Service {
  try { schtasks /Delete /TN $TaskName /F 2>$null | Out-Null; Write-Info "已移除登录自启计划任务（如有）。" } catch {}
}

# ---- 自愈：健康检查 / 端口探测 / 有限次修复循环 ----------------------------
# Windows 版：当前窗口的 CLI 变量本就即时生效（$env:*），健康验证直接打本机 /health。
function Get-HealthRaw {
  try { return (Invoke-WebRequest -Uri "$AdapterBase/health" -TimeoutSec 5 -UseBasicParsing).Content } catch { return $null }
}
function Test-Health {
  $h = Get-HealthRaw
  if (-not $h) { return $false }
  return ($h -match 'cg-mitm' -or $h -match '"ok"\s*:\s*true')
}
function Get-HealthUpstream {
  $h = Get-HealthRaw
  if (-not $h) { return $null }
  try {
    $j = $h | ConvertFrom-Json
    if ($j.upstream) { return ([string]$j.upstream).TrimEnd('/') }
  } catch {}
  return $null
}
function Get-HealthSummary {
  $h = Get-HealthRaw
  if (-not $h) { return "" }
  try {
    $j = $h | ConvertFrom-Json
    $dev = [string]$j.deviceId
    if ($dev.Length -gt 12) { $dev = $dev.Substring(0,12) + '…' }
    return "ok=$($j.ok) mode=$($j.mode) upstream=$($j.upstream) deviceId=$dev"
  } catch { return $h.Trim() }
}
function Test-PortBusy { param($p)
  try {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
      return [bool](Get-NetTCPConnection -LocalPort ([int]$p) -State Listen -ErrorAction SilentlyContinue)
    }
  } catch {}
  try { Invoke-WebRequest -Uri "http://${ListenHost}:$p/health" -TimeoutSec 2 -UseBasicParsing | Out-Null; return $true } catch { return $false }
}
function Find-FreePort {
  foreach ($c in 8788,8789,8790,8791,8890,9788,18788,28788) {
    if ($c -eq [int]$ListenPort) { continue }
    if (-not (Test-PortBusy $c)) { return $c }
  }
  return $null
}
function Stop-Adapter {
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'secure-adapter' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
}
function Sync-UpstreamIfNeeded {
  $need = $false
  if (Test-Path $EnvFile) {
    $saved = (Select-String -Path $EnvFile -Pattern '^CG_ADAPTER_UPSTREAM_URL=' -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($saved) {
      $val = ($saved.Line -split '=',2)[1].TrimEnd('/')
      if ($val -and $val -ne $Upstream) { $need = $true }
    }
  }
  if (-not $need -and (Test-Health)) {
    $hu = Get-HealthUpstream
    if ($hu -and $hu -ne $Upstream) { $need = $true }
  }
  if (-not $need) { return $false }
  Write-Warn "检测到 upstream/BASE_URL 不一致（期望 $Upstream），重写 env 与 CLI 变量..."
  $lb = $script:loopback
  if (-not $lb -and (Test-Path $EnvFile)) {
    $lbLine = Select-String -Path $EnvFile -Pattern '^CG_ADAPTER_LOOPBACK_KEY=' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($lbLine) { $lb = ($lbLine.Line -split '=',2)[1] }
  }
  if (Test-Path $EnvFile) {
    (Get-Content $EnvFile) -replace '^CG_ADAPTER_UPSTREAM_URL=.*', "CG_ADAPTER_UPSTREAM_URL=$Upstream" | Set-Content $EnvFile -Encoding UTF8
  }
  if ($lb) {
    [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $AdapterBase,      'User')
    [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY',  $lb,             'User')
    [Environment]::SetEnvironmentVariable('OPENAI_BASE_URL',    "$AdapterBase/v1", 'User')
    [Environment]::SetEnvironmentVariable('OPENAI_API_KEY',     $lb,             'User')
    $env:ANTHROPIC_BASE_URL = $AdapterBase
    $env:ANTHROPIC_API_KEY  = $lb
    $env:OPENAI_BASE_URL    = "$AdapterBase/v1"
    $env:OPENAI_API_KEY     = $lb
  }
  return $true
}
function Switch-Port { param($np)
  Write-Warn "端口 $ListenPort 仍被占用，切换到空闲端口 $np 并同步更新配置。"
  $script:ListenPort  = "$np"
  $script:AdapterBase = "http://${ListenHost}:${np}"
  if (Test-Path $EnvFile) {
    (Get-Content $EnvFile) -replace '^CG_ADAPTER_LISTEN_PORT=.*', "CG_ADAPTER_LISTEN_PORT=$np" | Set-Content $EnvFile -Encoding UTF8
  }
  [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $script:AdapterBase,      'User')
  [Environment]::SetEnvironmentVariable('OPENAI_BASE_URL',    "$($script:AdapterBase)/v1", 'User')
  $env:ANTHROPIC_BASE_URL = $script:AdapterBase
  $env:OPENAI_BASE_URL    = "$($script:AdapterBase)/v1"
}
# 收尾自愈：确保 Adapter 起来且 /health 通过；失败则有限次自动修复。
function Repair-And-Verify {
  $max = 3
  for ($i = 1; $i -le $max; $i++) {
    Write-Info "自检 [$i/$max]：GET $AdapterBase/health ..."
    if (Test-Health) { return $true }
    Write-Warn "health 未通过，进入自动修复（第 $i/$max 次）..."

    if (-not $RepoRoot -or -not (Test-Path (Join-Path $RepoRoot 'apps\secure-adapter'))) {
      Write-Warn "缺少仓库源码（apps\secure-adapter），自动准备（clone + install）..."
      Ensure-RepoReady | Out-Null
    }
    if ($RepoRoot -and -not (Test-Path (Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd'))) {
      Write-Warn "缺少 node_modules，自动重装依赖..."
      Install-Deps -Repo $RepoRoot
    }
    Sync-UpstreamIfNeeded | Out-Null
    if ($i -ge 2 -and $RepoRoot) {
      Write-Warn "尝试编译 Secure Adapter dist（自愈 build）..."
      $script:Build = $true
      Install-Deps -Repo $RepoRoot
    }
    if ((Test-PortBusy $ListenPort) -and -not (Test-Health)) {
      Write-Warn "端口 $ListenPort 被占用但不是健康 Adapter，尝试停旧..."
      Stop-Adapter; Start-Sleep -Seconds 1
      if (Test-PortBusy $ListenPort) { $np = Find-FreePort; if ($np) { Switch-Port $np } }
    }
    Stop-Adapter; Start-Sleep -Seconds 1
    Start-Adapter
    for ($w = 0; $w -lt 12; $w++) { if (Test-Health) { break }; Start-Sleep -Seconds 1 }
    if (Test-Health) { return $true }
  }
  return $false
}

# ---- Setup / Uninstall / Stop / Status -------------------------------------
if ($Setup) {
  if (Ensure-RepoReady) { Write-Info "仓库已就绪 ✅  可继续: .\install-csapi-secure.ps1 -Start" } else { exit 1 }
  return
}
if ($Uninstall) {
  foreach ($v in $vars) {
    [Environment]::SetEnvironmentVariable($v, $null, 'User')
    Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
  }
  Remove-Service
  Remove-Item $EnvFile,$Launcher -ErrorAction SilentlyContinue
  Write-Info "已移除用户级 CLI 环境变量与本机配置/启动器/自启任务（保留 $StateFile 设备状态）。"
  Write-Info "自动 clone 的仓库 $CloneDir 未删除（如需清理请手动 Remove-Item -Recurse）。"
  Write-Info "请重开终端使其完全生效。"
  return
}
if ($Stop) {
  Stop-Adapter
  Write-Info "已尝试停止 Adapter（如有）。Windows 下也可直接关闭 Adapter 窗口。"
  return
}
if ($Status) {
  try {
    $h = Invoke-RestMethod -Uri "$AdapterBase/health" -TimeoutSec 5
    Write-Info ("Adapter 运行中，health: " + ($h | ConvertTo-Json -Compress))
  } catch { Write-Info "Adapter 未响应 $AdapterBase（可能未启动）。" }
  if (Test-Path $EnvFile) { Write-Info "配置: $EnvFile" } else { Write-Info "尚无配置（未安装）。" }
  return
}

# --- install / -Start / -Service / -Print 共同前置：先解析 pins、探测（fail-closed），再 clone ---
# 与 install-csapi-secure.sh 一致：服务端未开安全通道时快速失败，避免无谓 clone/npm install。
$Pins = Resolve-PinnedRoots
Write-Info "固定根指纹: $Pins"

if ($Print) {
  if ($RepoRoot) { Write-Info "仓库: $RepoRoot" } else { Write-Warn "未定位到仓库源码（-Print 不会 clone）。" }
}

if (-not $Print) {
  if (-not $NoProbe) {
    if (-not (Test-ServerKeys -Pins $Pins)) { exit 3 }
  } else {
    Write-Warn "已跳过 server-keys 探测（-NoProbe）：未核对服务端安全通道与根指纹。"
  }
  Ensure-RepoReady | Out-Null
  $Pins = Resolve-PinnedRoots
}

# ---- 读取真实 key ----------------------------------------------------------
$key = $env:CSAPI_API_KEY
if (-not $key) { $key = $env:CG_ADAPTER_API_KEY }
if (-not $key) { $key = $env:API_KEY }
if (-not $key -and -not $Print) {
  $sec = Read-Host -AsSecureString "[csapi-secure] 请输入你的真实 CSAPI API key（输入不显示，仅存本机）"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# ---- loopback key（复用已有，幂等）----------------------------------------
$loopback = $env:CG_ADAPTER_LOOPBACK_KEY
if (-not $loopback -and (Test-Path $EnvFile)) {
  $line = Select-String -Path $EnvFile -Pattern '^CG_ADAPTER_LOOPBACK_KEY=' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { $loopback = ($line.Line -split '=',2)[1] }
}
if (-not $loopback) {
  $bytes = New-Object 'System.Byte[]' 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $loopback = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}
$script:loopback = $loopback

if ($Print) {
  Write-Info "以下为将写入的配置（-Print：未写任何文件 / 环境变量）:"
  Write-Host ""
  Write-Host "# $EnvFile"
  Write-Host "CG_ADAPTER_UPSTREAM_URL=$Upstream"
  Write-Host "CG_ADAPTER_LISTEN_HOST=$ListenHost"
  Write-Host "CG_ADAPTER_LISTEN_PORT=$ListenPort"
  Write-Host "CG_ADAPTER_LOOPBACK_KEY=$loopback"
  Write-Host "CG_ADAPTER_API_KEY=<你的真实 CSAPI key>"
  Write-Host "CG_ADAPTER_PINNED_ROOTS=$Pins"
  Write-Host "CG_ADAPTER_STATE_FILE=$StateFile"
  Write-Host ""
  Write-Host "# 用户级环境变量（CLI 指向本机 Adapter）"
  Write-Host "ANTHROPIC_BASE_URL = $AdapterBase"
  Write-Host "ANTHROPIC_API_KEY  = $loopback"
  Write-Host "OPENAI_BASE_URL    = $AdapterBase/v1"
  Write-Host "OPENAI_API_KEY     = $loopback"
  return
}

if (-not $key) { Write-Err "未提供 API key，已取消。"; exit 1 }

# ---- 写本机 Adapter 配置 ---------------------------------------------------
if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Path $CfgDir | Out-Null }
$envLines = @(
  '# managed by install-csapi-secure.ps1 — 含真实 CSAPI key。切勿提交 git。'
  "CG_ADAPTER_UPSTREAM_URL=$Upstream"
  "CG_ADAPTER_LISTEN_HOST=$ListenHost"
  "CG_ADAPTER_LISTEN_PORT=$ListenPort"
  "CG_ADAPTER_LOOPBACK_KEY=$loopback"
  "CG_ADAPTER_API_KEY=$key"
  "CG_ADAPTER_PINNED_ROOTS=$Pins"
  "CG_ADAPTER_STATE_FILE=$StateFile"
)
Set-Content -Path $EnvFile -Value $envLines -Encoding UTF8
# 收敛 ACL：仅当前用户可读写。
try {
  icacls $EnvFile /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
} catch { Write-Warn "无法收敛 $EnvFile 的 ACL；请手动确认仅本人可读。" }
Write-Info "已写本机 Adapter 配置: $EnvFile"

# ---- 写启动器（.cmd）-------------------------------------------------------
$repoForCmd = if ($RepoRoot) { $RepoRoot } else { '%CSAPI_REPO_DIR%' }
$cmdLines = @(
  '@echo off'
  'setlocal enabledelayedexpansion'
  "set ""ENVFILE=$EnvFile"""
  "if not defined CSAPI_REPO_DIR set ""CSAPI_REPO_DIR=$repoForCmd"""
  'if not exist "%ENVFILE%" ( echo [secure-adapter] missing %ENVFILE% & exit /b 1 )'
  'if not exist "%CSAPI_REPO_DIR%\apps\secure-adapter" ( echo [secure-adapter] set CSAPI_REPO_DIR to the repo root & exit /b 1 )'
  'for /f "usebackq tokens=1,* delims==" %%A in ("%ENVFILE%") do ('
  '  set "line=%%A"'
  '  if not "!line:~0,1!"=="#" set "%%A=%%B"'
  ')'
  'cd /d "%CSAPI_REPO_DIR%"'
  'where tsx >nul 2>nul && ( tsx apps\secure-adapter\src\index.ts ) || ( npx tsx apps\secure-adapter\src\index.ts )'
)
Set-Content -Path $Launcher -Value $cmdLines -Encoding Ascii
Write-Info "已写启动器: $Launcher"

# ---- 幂等写用户级环境变量（Set 即覆盖）------------------------------------
[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $AdapterBase,      'User')
[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY',  $loopback,         'User')
[Environment]::SetEnvironmentVariable('OPENAI_BASE_URL',    "$AdapterBase/v1", 'User')
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY',     $loopback,         'User')
$env:ANTHROPIC_BASE_URL = $AdapterBase
$env:ANTHROPIC_API_KEY  = $loopback
$env:OPENAI_BASE_URL    = "$AdapterBase/v1"
$env:OPENAI_API_KEY     = $loopback
Write-Info "已写用户级 CLI 环境变量（指向本机 Adapter；重复运行只覆盖，不堆叠）。"

# ---- 收尾：不只打印“下一步”，而是自己拉起 + 自检 + 自愈 --------------------
if ($Service) { Install-Service }

if (Repair-And-Verify) {
  Write-Host ""
  Write-Info "已验证通过 ✅  本机 Adapter /health 正常，监听 $AdapterBase"
  Write-Info "health: $(Get-HealthSummary)"
  Write-Info "CLI 变量：当前窗口已即时生效；新终端自动带上。"
  Write-Info "安全：真实 key 只在 $EnvFile 与密文 envelope 内；中间人只见 cg-mitm/1 密文。fail-closed，绝不回退明文。"
  return
}

Write-Host ""
Write-Err "已自动修复 3 次仍无法让 Adapter 通过 /health。最可能的原因（需人工处理）："
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Err "  · 未安装 node（Adapter 需 node>=22）。装好 Node 后重跑本脚本，其余步骤会自动完成。"
} elseif (-not $RepoRoot -or -not (Test-Path (Join-Path $RepoRoot 'apps\secure-adapter'))) {
  Write-Err "  · 未能获取仓库源码（clone 失败或 -NoClone）。装好 git+网络，或设 `$env:CSAPI_REPO_DIR 后重跑。"
} else {
  Write-Err "  · Adapter 启动后 fail-closed（多为服务端未开安全通道 / 证书 / 根指纹问题）。手动运行 $Launcher 看错误。"
  Write-Err "  · 亦可先用方案 B（明文兼容）临时试用：.\install-csapi.ps1"
}
exit 1
