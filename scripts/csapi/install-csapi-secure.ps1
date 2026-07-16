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

  本脚本会：
    1) 读取真实 CSAPI key（仅存本机 secure-adapter.env，ACL 收敛；永不进 git / HTTP header）；
    2) 探测 /cg/v1/server-keys 并核对固定根指纹（防 MITM / 防配错服务端）；
    3) 写 %USERPROFILE%\.cursor-gateway\secure-adapter.env + start-secure-adapter.cmd；
    4) 幂等写用户级环境变量：把 CLI 的 ANTHROPIC_*/OPENAI_* 指向本机 Adapter（用 loopback key）。

.PARAMETER Print
  只打印将写入的配置，不写任何文件 / 环境变量。

.PARAMETER Uninstall
  移除用户级 ANTHROPIC_*/OPENAI_* + 本机配置/启动器。

.PARAMETER NoProbe
  跳过 server-keys 探测（高级 / 预置场景）。

.PARAMETER Start
  安装后立即在新窗口启动 Adapter。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-csapi-secure.ps1

.EXAMPLE
  $env:CSAPI_API_KEY="sk-xxxx"; .\install-csapi-secure.ps1 -Start

.NOTES
  本脚本不含任何真实 key。启动 Adapter 需仓库源码（apps\secure-adapter + npm install，node>=22）；
  仓库路径自动从脚本位置推断，也可用 $env:CSAPI_REPO_DIR 指定。
#>

[CmdletBinding()]
param(
  [switch]$Print,
  [switch]$Uninstall,
  [switch]$NoProbe,
  [switch]$Start,
  [switch]$Stop,
  [switch]$Status
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

$CfgDir      = Join-Path $env:USERPROFILE '.cursor-gateway'
$EnvFile     = Join-Path $CfgDir 'secure-adapter.env'
$Launcher    = Join-Path $CfgDir 'start-secure-adapter.cmd'
$StateFile   = Join-Path $CfgDir 'cg-mitm-adapter-state.json'
$AdapterBase = "http://${ListenHost}:${ListenPort}"

$vars = @('ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','OPENAI_BASE_URL','OPENAI_API_KEY')

function Write-Info { param($m) Write-Host "[csapi-secure] $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "[csapi-secure] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "[csapi-secure] $m" -ForegroundColor Red }

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
  return $null
}
$RepoRoot = Resolve-Repo

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
  try {
    $resp = Invoke-WebRequest -Uri $url -TimeoutSec 20 -UseBasicParsing
  } catch {
    $code = $null
    try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
    if ($code -eq 404 -or $code -eq 426) {
      Write-Err "服务端未开启 cg-mitm 安全通道（/cg/v1/server-keys 返回 HTTP $code）。"
      Write-Err "这是**运维前置**，不是本机问题。请让 csapi 管理员在 VPS 上完成："
      Write-Err "  1) 离线机器用 Ed25519 根签发服务端身份证书（allowedOrigins 含 $Upstream）："
      Write-Err "       scripts/csapi/dev-cg-mitm-setup.sh $Upstream"
      Write-Err "  2) 把打印的 CG_* 写入 csapi 的 .env 并重启，且必须开启："
      Write-Err "       CG_SECURE_ENABLED=true"
      Write-Err "       CG_SERVER_CERT_FILE / CG_SERVER_HPKE_KEY_FILE / CG_SERVER_SIGNING_KEY_FILE / CG_TRUST_ROOTS_FILE"
      Write-Err "     （保持 CG_REQUIRE_SECURE=false，让明文 /v1/* 与安全 /cg/v1/* 并行灰度）"
      Write-Err "  3) 该根的公钥要与本安装器固定的指纹一致：$Pins"
      Write-Err "开启后重跑本脚本即可。（如需先预置配置：加 -NoProbe 跳过探测。）"
      return $false
    }
    Write-Err "无法探测 $url：$($_.Exception.Message)。请检查网络后重试。"
    return $false
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

# ---- Adapter 启停 ----------------------------------------------------------
function Start-Adapter {
  if (-not (Test-Path $Launcher)) { Write-Err "缺少启动器 $Launcher，请先安装（不带 -Start）。"; return }
  Write-Info "在新窗口启动 Adapter：$Launcher"
  Start-Process -FilePath $Launcher
  Write-Info "如窗口一闪而退，多半是 fail-closed；手动运行 $Launcher 查看错误。"
}

# ---- Uninstall / Stop / Status ---------------------------------------------
if ($Uninstall) {
  foreach ($v in $vars) {
    [Environment]::SetEnvironmentVariable($v, $null, 'User')
    Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
  }
  Remove-Item $EnvFile,$Launcher -ErrorAction SilentlyContinue
  Write-Info "已移除用户级 CLI 环境变量与本机配置/启动器（保留 $StateFile 设备状态）。"
  Write-Info "请重开终端使其完全生效。"
  return
}
if ($Stop) {
  Get-Process -Name node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.CommandLine -match 'secure-adapter' } |
    ForEach-Object { $_.Kill() } 2>$null
  Write-Info "已尝试停止 Adapter（如有）。Windows 下建议直接关闭 Adapter 窗口。"
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

$Pins = Resolve-PinnedRoots
Write-Info "固定根指纹: $Pins"
if ($RepoRoot) { Write-Info "仓库: $RepoRoot" } else { Write-Warn "未定位到仓库源码：可完成配置，但启动 Adapter 需 clone 仓库并 npm install（或设 CSAPI_REPO_DIR）。" }

if (-not $NoProbe) {
  if (-not (Test-ServerKeys -Pins $Pins)) { exit 3 }
} else {
  Write-Warn "已跳过 server-keys 探测（-NoProbe）：未核对服务端安全通道与根指纹。"
}

# ---- 读取真实 key ----------------------------------------------------------
$key = $env:CSAPI_API_KEY
if (-not $key) { $key = $env:CG_ADAPTER_API_KEY }
if (-not $key) { $key = $env:API_KEY }
if (-not $key) {
  $sec = Read-Host -AsSecureString "[csapi-secure] 请输入你的真实 CSAPI API key（输入不显示，仅存本机）"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $key) { Write-Err "未提供 API key，已取消。"; exit 1 }

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

if ($Start) { Start-Adapter }

Write-Host ""
Write-Info "下一步："
if (-not $RepoRoot) {
  Write-Info "  0) 启动 Adapter 需仓库源码：clone → npm install → 设 CSAPI_REPO_DIR，再运行 $Launcher"
} else {
  Write-Info "  0) 确保依赖已装一次:  cd `"$RepoRoot`"; npm install"
}
Write-Info "  1) 启动本机 Adapter:  .\install-csapi-secure.ps1 -Start   （或直接运行 $Launcher）"
Write-Info "  2) 新终端自动带上 CLI 变量；当前窗口已即时生效。"
Write-Info "  3) 验证:  Invoke-RestMethod $AdapterBase/health"
Write-Host ""
Write-Info "安全：真实 key 只在 $EnvFile 与密文 envelope 内；网络中间人只见 cg-mitm/1 密文。fail-closed，绝不回退明文。"
