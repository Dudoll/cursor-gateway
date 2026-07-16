<#
.SYNOPSIS
  install-csapi.ps1 — csapi 懒人一键安装脚本（Windows PowerShell 版，可单文件分发）

.DESCRIPTION
  在 Windows 上把「CLI 用的 API 环境」配好，指向兼容门面 https://csapi.joelzt.org
  （方案 B：TLS + API key 明文兼容通道）。默认写入「用户级」持久环境变量：
    - Claude Code / Anthropic 兼容:
        ANTHROPIC_BASE_URL = https://csapi.joelzt.org
        ANTHROPIC_API_KEY  = <你的 CSAPI key>
    - OpenCode / OpenAI 兼容:
        OPENAI_BASE_URL    = https://csapi.joelzt.org/v1
        OPENAI_API_KEY     = <你的 CSAPI key>

  ⚠️ 安全边界：这是 plaintext 兼容通道，不是端到端加密（E2EE）。
     请求内容在门面/网关/Runner/模型侧都是明文可见的。

.PARAMETER Print
  只打印 $env: 赋值语句，不写入持久环境变量。

.PARAMETER Uninstall
  移除本脚本写入的 4 个用户级环境变量。

.PARAMETER NoProbe
  跳过 /health 与 /v1/models 连通性探测。

.EXAMPLE
  # 交互式
  powershell -ExecutionPolicy Bypass -File .\install-csapi.ps1

.EXAMPLE
  # 用环境变量跳过交互
  $env:CSAPI_API_KEY="sk-xxxx"; .\install-csapi.ps1

  本脚本不含任何真实生产 key；key 由交互输入或环境变量提供。
#>

[CmdletBinding()]
param(
  [switch]$Print,
  [switch]$Uninstall,
  [switch]$NoProbe
)

$ErrorActionPreference = 'Stop'

$BaseUrl        = if ($env:CSAPI_BASE_URL) { $env:CSAPI_BASE_URL.TrimEnd('/') } else { 'https://csapi.joelzt.org' }
$AnthropicBase  = $BaseUrl
$OpenAIBase     = "$BaseUrl/v1"

function Write-Info { param($m) Write-Host "[csapi] $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "[csapi] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "[csapi] $m" -ForegroundColor Red }

Write-Info "csapi 门面: $BaseUrl"
Write-Info "⚠️  这是 plaintext 兼容通道（方案 B），不是端到端加密（E2EE）。"

$vars = @('ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','OPENAI_BASE_URL','OPENAI_API_KEY')

if ($Uninstall) {
  foreach ($v in $vars) {
    [Environment]::SetEnvironmentVariable($v, $null, 'User')
    Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
  }
  Write-Info "已移除用户级 csapi 环境变量。请重开终端使其完全生效。"
  return
}

# ---- 解析 key：环境变量 CSAPI_API_KEY / API_KEY > 交互输入 ----
$key = $env:CSAPI_API_KEY
if (-not $key) { $key = $env:API_KEY }
if (-not $key) {
  $sec = Read-Host -AsSecureString "[csapi] 请输入你的 CSAPI API key（输入不显示）"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $key) { Write-Err "未提供 API key，已取消。"; exit 1 }

function Invoke-Probe {
  param($ApiKey)
  try {
    $h = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 15
    Write-Info ("health OK: " + ($h | ConvertTo-Json -Compress))
  } catch { Write-Warn "health 探测失败（可能网络/门面不可达），环境变量仍已写入。" }

  try {
    $r = Invoke-WebRequest -Uri "$OpenAIBase/models" -Headers @{ Authorization = "Bearer $ApiKey" } -TimeoutSec 15 -UseBasicParsing
    if ($r.StatusCode -eq 200) { Write-Info "models OK（鉴权通过，HTTP 200）。" }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__ 2>$null
    if ($code -in 401,403) { Write-Warn "models 返回 $code：key 可能无效或未授权。" }
    else { Write-Warn "models 探测失败：$($_.Exception.Message)" }
  }
}

if ($Print) {
  Write-Info "以下语句可直接粘贴到当前 PowerShell（未写入持久环境变量）:"
  Write-Host ""
  Write-Host "`$env:ANTHROPIC_BASE_URL = `"$AnthropicBase`""
  Write-Host "`$env:ANTHROPIC_API_KEY  = `"$key`""
  Write-Host "`$env:OPENAI_BASE_URL    = `"$OpenAIBase`""
  Write-Host "`$env:OPENAI_API_KEY     = `"$key`""
  Write-Host ""
  if (-not $NoProbe) { Invoke-Probe -ApiKey $key }
  return
}

# ---- 幂等写入用户级环境变量（Set 即覆盖，天然不堆叠）----
[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $AnthropicBase, 'User')
[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY',  $key,          'User')
[Environment]::SetEnvironmentVariable('OPENAI_BASE_URL',    $OpenAIBase,   'User')
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY',     $key,          'User')

# 让当前会话立即可用
$env:ANTHROPIC_BASE_URL = $AnthropicBase
$env:ANTHROPIC_API_KEY  = $key
$env:OPENAI_BASE_URL    = $OpenAIBase
$env:OPENAI_API_KEY     = $key

Write-Info "已写入用户级环境变量（重复运行只覆盖，不堆叠）。"

if (-not $NoProbe) { Invoke-Probe -ApiKey $key }

Write-Host ""
Write-Info "新开的终端会自动带上这些变量；当前窗口已即时生效。"
Write-Info "验证:  echo `$env:ANTHROPIC_BASE_URL  与  echo `$env:OPENAI_BASE_URL"
Write-Info "完成 ✅  Claude Code 用 ANTHROPIC_*，OpenCode/OpenAI 客户端用 OPENAI_*。"
