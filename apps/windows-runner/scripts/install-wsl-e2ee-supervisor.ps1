param(
  [string]$TaskName = "CursorGatewayE2eeRunner",
  [string]$Distro = "Ubuntu-22.04",
  [string]$WslUser = "dministrator",
  [switch]$Start
)

$ErrorActionPreference = "Stop"
$taskNames = @(
  $TaskName,
  "CursorGatewayWslRunner",
  "CursorGatewayWindowsRunner",
  "CursorGatewayWindowsRunnerWatchdog"
)
& (Join-Path $PSScriptRoot "remove-windows-runner-autostart.ps1") `
  -TaskNames $taskNames | Out-Null

Write-Warning "Cursor Gateway Windows autostart is retired; no scheduled task was installed."

if ($Start) {
  & (Join-Path $PSScriptRoot "start-wsl-e2ee-runner.ps1") `
    -Distro $Distro `
    -WslUser $WslUser
} else {
  [pscustomobject]@{
    Mode = "manual"
    AutoStartEnabled = $false
    Started = $false
  }
}
