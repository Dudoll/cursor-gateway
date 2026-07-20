param(
  [string]$Distro = "Ubuntu-22.04",
  [string]$WslUser = "dministrator"
)

$ErrorActionPreference = "Stop"
$wslExe = Join-Path $env:SystemRoot "System32\wsl.exe"
if (-not (Test-Path $wslExe)) {
  throw "wsl.exe not found at $wslExe"
}

# Manual start always enforces the no-autostart policy first.
& (Join-Path $PSScriptRoot "remove-windows-runner-autostart.ps1") | Out-Null

$supervisor = 'exec bash $HOME/cursor-e2ee/apps/windows-runner/scripts/wsl-e2ee-supervisor.sh'
$arguments = "-d $Distro -u $WslUser -e bash -lc `"$supervisor`""
$process = Start-Process `
  -FilePath $wslExe `
  -ArgumentList $arguments `
  -WindowStyle Hidden `
  -PassThru

[pscustomobject]@{
  Mode = "manual"
  AutoStartEnabled = $false
  ProcessId = $process.Id
  Distro = $Distro
  WslUser = $WslUser
}
