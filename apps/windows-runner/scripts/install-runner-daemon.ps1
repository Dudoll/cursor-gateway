param(
  [string]$TaskName = "CursorGatewayWindowsRunner",
  [string]$WatchdogTaskName = "CursorGatewayWindowsRunnerWatchdog",
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path,
  [int]$WatchdogIntervalMinutes = 2
)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "remove-windows-runner-autostart.ps1") `
  -TaskNames @(
    $TaskName,
    $WatchdogTaskName,
    "CursorGatewayE2eeRunner",
    "CursorGatewayWslRunner"
  ) | Out-Null

Write-Warning (
  "The Windows-native Cursor Gateway runner and watchdog are retired. " +
  "No service or scheduled task was installed."
)

[pscustomobject]@{
  Mode = "retired"
  AutoStartEnabled = $false
  ProjectRoot = $ProjectRoot
  WatchdogIntervalMinutes = $WatchdogIntervalMinutes
}
