param(
  [string]$TaskName = "CursorGatewayWslRunner",
  [string]$Distro = "Ubuntu-22.04",
  [string]$WslUser = "dministrator",
  [string]$RunAsUser = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "remove-windows-runner-autostart.ps1") `
  -TaskNames @(
    $TaskName,
    "CursorGatewayE2eeRunner",
    "CursorGatewayWindowsRunner",
    "CursorGatewayWindowsRunnerWatchdog"
  ) | Out-Null

Write-Warning (
  "WSL scheduled-task installation is retired. " +
  "Use start-wsl-e2ee-runner.ps1 for an explicit manual start."
)

[pscustomobject]@{
  Mode = "retired"
  AutoStartEnabled = $false
  Distro = $Distro
  WslUser = $WslUser
  RunAsUser = $RunAsUser
}
