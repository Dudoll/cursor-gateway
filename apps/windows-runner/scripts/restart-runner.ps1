param(
  [string]$TaskName = "CursorGatewayWindowsRunner",
  [string]$WatchdogTaskName = "CursorGatewayWindowsRunnerWatchdog",
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path,
  [switch]$SkipStart
)

$ErrorActionPreference = "Stop"

$logDirectory = Join-Path $ProjectRoot "apps\windows-runner\logs"
$patterns = @(
  "start-runner.ps1",
  "run-runner-daemon.ps1",
  "watch-runner-health.ps1",
  "@cursor-gateway/windows-runner",
  "apps\\windows-runner\\dist\\index.js",
  "apps/windows-runner/dist/index.js"
)

function Write-RestartLog([string]$Message) {
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $logPath = Join-Path $logDirectory "runner-restart.log"
  $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
  Add-Content -Path $logPath -Value "[$timestamp] $Message" -Encoding UTF8
  Write-Host $Message
}

Write-RestartLog "Manual restart requested for $TaskName."

foreach ($name in @($WatchdogTaskName, $TaskName)) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq "Running") {
    Write-RestartLog "Stopping scheduled task $name."
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Seconds 2

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $cmd = $_.CommandLine
    if (-not $cmd) { return $false }
    foreach ($pattern in $patterns) {
      if ($cmd -like "*$pattern*") { return $true }
    }
    return $false
  } |
  ForEach-Object {
    Write-RestartLog "Killing PID $($_.ProcessId) ($($_.Name))"
    & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null
  }

if (-not $SkipStart) {
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $TaskName
  Write-RestartLog "Started scheduled task $TaskName."
  Start-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue
  Write-RestartLog "Ensured watchdog task $WatchdogTaskName is armed."
}

Write-RestartLog "Restart complete."
