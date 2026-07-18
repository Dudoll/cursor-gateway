<#
.SYNOPSIS
  One-click build of the Cursor Gateway Windows desktop client (Tauri v2 + WebView2)
  into a real NSIS `.exe` installer, on a native Windows machine.

.DESCRIPTION
  The Linux/WSL dev box cannot cross-compile the Windows bundle (needs Rust MSVC +
  WebView2). This script bootstraps everything on Windows and produces:
      cursor-gateway-desktop-setup.exe   (+ SHA256 printed)

  It will, only if missing:
    - install Node.js 22 LTS      (via winget)
    - install Rust (MSVC toolchain, x86_64-pc-windows-msvc)  (via rustup)
    - install the WebView2 Evergreen runtime  (via winget; Win11 usually has it)
  NSIS itself is downloaded automatically by Tauri.

  MSVC C++ Build Tools (cl.exe / link.exe) are required by Rust on Windows. If they
  are absent the script installs "Visual Studio 2022 Build Tools" with the
  VC++ + Windows SDK workload via winget (a few GB; may prompt for elevation).

.PARAMETER RepoPath
  Path to an existing cursor-gateway checkout. If omitted and the script is run from
  inside the repo it uses the repo root; otherwise it clones from -RepoUrl.

.PARAMETER RepoUrl
  Git URL to clone when no local checkout is given.
  Default: https://github.com/Dudoll/cursor-gateway.git

.PARAMETER Ref
  Git ref (tag/branch/commit) to build. Default: desktop-v0.1.0

.PARAMETER OutDir
  Where to copy the finished installer + SHA256SUMS. Default: <repo>\artifacts\desktop

.EXAMPLE
  # From anywhere — clone, build, output to Desktop:
  powershell -ExecutionPolicy Bypass -File .\build-desktop-windows.ps1 -OutDir $HOME\Desktop

.EXAMPLE
  # Build an existing checkout at a specific tag:
  .\build-desktop-windows.ps1 -RepoPath C:\src\cursor-gateway -Ref desktop-v0.1.0
#>
[CmdletBinding()]
param(
  [string]$RepoPath,
  [string]$RepoUrl = "https://github.com/Dudoll/cursor-gateway.git",
  [string]$Ref     = "desktop-v0.1.0",
  [string]$OutDir
)

$ErrorActionPreference = "Stop"
function Info($m){ Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m){ Write-Host "  ok $m" -ForegroundColor Green }
function Warn($m){ Write-Host "  !! $m" -ForegroundColor Yellow }

function Have($name){ [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path","Machine")
  $user    = [System.Environment]::GetEnvironmentVariable("Path","User")
  $env:Path = ($machine, $user, "$env:USERPROFILE\.cargo\bin") -join ';'
}

function Winget-Install($id, $friendly){
  if(-not (Have winget)){ throw "winget not available — install '$friendly' manually, then re-run." }
  Info "installing $friendly ($id) via winget ..."
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Host
  Refresh-Path
}

# --- 1. toolchain --------------------------------------------------------------
Info "Checking build prerequisites"

if(-not (Have node)){ Winget-Install "OpenJS.NodeJS.LTS" "Node.js 22 LTS" }
if(Have node){ Ok ("node " + (node -v)) } else { throw "node still missing after install" }

if(-not (Have git)){ Winget-Install "Git.Git" "Git" }

# MSVC C++ build tools (cl.exe). Detect via vswhere; install Build Tools if absent.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$haveVc = $false
if(Test-Path $vswhere){
  $vc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if($vc){ $haveVc = $true; Ok "MSVC C++ build tools: $vc" }
}
if(-not $haveVc){
  Warn "MSVC C++ Build Tools not found — installing (large download, may prompt for admin)"
  if(-not (Have winget)){ throw "winget missing; install 'Visual Studio 2022 Build Tools' + 'Desktop development with C++' manually." }
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
    --accept-source-agreements --accept-package-agreements `
    --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621" | Out-Host
  Refresh-Path
  Ok "Build Tools installed"
}

# Rust (MSVC toolchain)
if(-not (Have rustc)){
  Info "installing Rust (rustup, MSVC) ..."
  $ru = "$env:TEMP\rustup-init.exe"
  Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $ru
  & $ru -y --default-host x86_64-pc-windows-msvc --default-toolchain stable --profile minimal | Out-Host
  Refresh-Path
}
if(Have rustc){ Ok ("rustc " + (rustc --version)) } else { throw "rustc missing after install" }
rustup target add x86_64-pc-windows-msvc | Out-Null

# WebView2 runtime (needed to RUN the app; also bundled by NSIS bootstrapper).
$wv2Keys = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
$wv2 = $wv2Keys | ForEach-Object { (Get-ItemProperty $_ -ErrorAction SilentlyContinue).pv } | Where-Object { $_ } | Select-Object -First 1
if($wv2){ Ok "WebView2 runtime $wv2" } else { Warn "WebView2 runtime not detected — installing"; Winget-Install "Microsoft.EdgeWebView2Runtime" "WebView2 Runtime" }

# --- 2. source -----------------------------------------------------------------
if(-not $RepoPath){
  # If run from within a checkout, use it; else clone.
  $probe = & git -C $PSScriptRoot rev-parse --show-toplevel 2>$null
  if($LASTEXITCODE -eq 0 -and $probe){ $RepoPath = $probe.Trim() }
  else {
    $RepoPath = Join-Path $env:USERPROFILE "cursor-gateway"
    if(-not (Test-Path $RepoPath)){
      Info "cloning $RepoUrl -> $RepoPath"
      git clone $RepoUrl $RepoPath | Out-Host
    }
  }
}
Info "repo: $RepoPath"
Push-Location $RepoPath
try {
  git fetch --all --tags --prune | Out-Host
  git checkout $Ref | Out-Host
  Ok ("HEAD " + (git rev-parse --short HEAD))

  # --- 3. build ----------------------------------------------------------------
  Info "npm install (workspace)"
  npm install | Out-Host

  Info "building bundled frontend (shared -> e2ee -> secure-web)"
  npm run build -w '@cursor-gateway/shared' | Out-Host
  npm run build -w '@cursor-gateway/e2ee' | Out-Host
  npm run build -w '@cursor-gateway/secure-web' | Out-Host

  Info "generating icons"
  npm run icon -w '@cursor-gateway/desktop' | Out-Host

  Info "tauri build (NSIS installer) — this compiles Rust, first run is slow"
  npm run tauri -w '@cursor-gateway/desktop' -- build --bundles nsis | Out-Host

  # --- 4. collect --------------------------------------------------------------
  $nsis = Get-ChildItem -Recurse "apps\desktop\src-tauri\target\release\bundle\nsis" -Filter *-setup.exe -ErrorAction Stop | Select-Object -First 1
  if(-not $nsis){ throw "NSIS installer not produced" }

  if(-not $OutDir){ $OutDir = Join-Path $RepoPath "artifacts\desktop" }
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $dest = Join-Path $OutDir "cursor-gateway-desktop-setup.exe"
  Copy-Item $nsis.FullName $dest -Force

  $hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
  "$hash  cursor-gateway-desktop-setup.exe" | Set-Content -Encoding ascii (Join-Path $OutDir "SHA256SUMS")

  Write-Host ""
  Ok "BUILD COMPLETE"
  Write-Host ("  installer : {0}" -f $dest) -ForegroundColor Green
  Write-Host ("  size      : {0:N1} MB" -f ((Get-Item $dest).Length/1MB)) -ForegroundColor Green
  Write-Host ("  sha256    : {0}" -f $hash) -ForegroundColor Green
  Write-Host ""
  Write-Host "Next: copy this .exe into the gateway repo's ./artifacts/ and rebuild the app," -ForegroundColor Cyan
  Write-Host "or upload it as the Release asset for desktop-v0.1.0." -ForegroundColor Cyan
}
finally { Pop-Location }
