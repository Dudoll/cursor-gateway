param(
  [string]$TaskName = "CursorGatewayWindowsRunner",
  [string]$WatchdogTaskName = "CursorGatewayWindowsRunnerWatchdog",
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path,
  [int]$WatchdogIntervalMinutes = 2
)

$ErrorActionPreference = "Stop"

$daemonScript = Join-Path $PSScriptRoot "run-runner-daemon.ps1"
$watchdogScript = Join-Path $PSScriptRoot "watch-runner-health.ps1"
$envFile = Join-Path $ProjectRoot "apps\windows-runner\.env"

if (-not (Test-Path $envFile)) {
  throw "Configure $envFile before installing the daemon."
}

if (-not (Test-Path $daemonScript)) {
  throw "Daemon script not found: $daemonScript"
}

if (-not (Test-Path $watchdogScript)) {
  throw "Watchdog script not found: $watchdogScript"
}

$powerShell = Join-Path $PSHOME "powershell.exe"

function Install-RunnerTask {
  param(
    [string]$Name,
    [string]$ScriptPath,
    [string]$Description,
    [object]$Trigger,
    [switch]$StartNow
  )

  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`" -ProjectRoot `"$ProjectRoot`""
  $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $ProjectRoot
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 999 `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

  $task = New-ScheduledTask `
    -Action $action `
    -Trigger $Trigger `
    -Principal $principal `
    -Settings $settings `
    -Description $Description

  Register-ScheduledTask -TaskName $Name -InputObject $task -Force | Out-Null

  if ($StartNow) {
    Start-ScheduledTask -TaskName $Name
  }
}

$daemonTrigger = New-ScheduledTaskTrigger -AtStartup
Install-RunnerTask `
  -Name $TaskName `
  -ScriptPath $daemonScript `
  -Description "Keeps the Cursor Gateway Windows runner online, restarts on exit, and kills stale/disconnected runners." `
  -Trigger $daemonTrigger `
  -StartNow

# Watchdog runs every N minutes for ~10 years, starting 2 minutes from now.
# Task Scheduler rejects TimeSpan.MaxValue for RepetitionDuration.
$watchdogStart = (Get-Date).AddMinutes(2)
$watchdogTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At $watchdogStart `
  -RepetitionInterval (New-TimeSpan -Minutes $WatchdogIntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
Install-RunnerTask `
  -Name $WatchdogTaskName `
  -ScriptPath $watchdogScript `
  -Description "External watchdog that restarts the Windows runner task if gateway heartbeats go stale." `
  -Trigger $watchdogTrigger `
  -StartNow

Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "Installed watchdog scheduled task: $WatchdogTaskName (every $WatchdogIntervalMinutes min)"
Write-Host "Runner log: $(Join-Path $ProjectRoot 'apps\windows-runner\logs\runner-daemon.log')"
Write-Host "Watchdog log: $(Join-Path $ProjectRoot 'apps\windows-runner\logs\runner-watchdog.log')"
Write-Host "Health stamp: $(Join-Path $ProjectRoot 'apps\windows-runner\logs\runner-health.json')"
Write-Host ""
Write-Host "Manual recovery:"
Write-Host "  .\apps\windows-runner\scripts\restart-runner.ps1"
