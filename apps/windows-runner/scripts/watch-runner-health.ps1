param(
  [string]$TaskName = "CursorGatewayWindowsRunner",
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path,
  [int]$HealthStaleSeconds = 180
)

$ErrorActionPreference = "Stop"

$logDirectory = Join-Path $ProjectRoot "apps\windows-runner\logs"
$logPath = Join-Path $logDirectory "runner-watchdog.log"
$healthPath = Join-Path $logDirectory "runner-health.json"
$statePath = Join-Path $logDirectory "runner-daemon-state.json"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 5MB) {
  Move-Item $logPath "$logPath.1" -Force
}

function Write-WatchdogLog([string]$Message) {
  $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
  Add-Content -Path $logPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Get-HealthInfo {
  if (-not (Test-Path $healthPath)) {
    return @{
      exists = $false
      ok = $false
      ageSeconds = [double]::PositiveInfinity
      pid = $null
    }
  }

  try {
    $health = Get-Content -Path $healthPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $stampText = if ($health.lastHeartbeatAt) { $health.lastHeartbeatAt } else { $health.updatedAt }
    $stamp = [datetime]::Parse($stampText).ToUniversalTime()
    $age = ((Get-Date).ToUniversalTime() - $stamp).TotalSeconds
    return @{
      exists = $true
      ok = ($health.lastHeartbeatOk -eq $true) -and ($age -le $HealthStaleSeconds)
      ageSeconds = $age
      pid = $health.pid
      lastError = $health.lastError
      consecutiveFailures = $health.consecutiveFailures
    }
  } catch {
    return @{
      exists = $true
      ok = $false
      ageSeconds = [double]::PositiveInfinity
      pid = $null
      parseError = $_.Exception.Message
    }
  }
}

function Stop-OrphanRunnerProcesses {
  $patterns = @(
    "start-runner.ps1",
    "run-runner-daemon.ps1",
    "@cursor-gateway/windows-runner",
    "apps\\windows-runner\\dist\\index.js",
    "apps/windows-runner/dist/index.js"
  )

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
      Write-WatchdogLog "Stopping orphan process PID $($_.ProcessId): $($_.Name)"
      try {
        & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null
      } catch {
        Write-WatchdogLog "Failed to stop PID $($_.ProcessId): $($_.Exception.Message)"
      }
    }
}

Write-WatchdogLog "Watchdog check started."

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-WatchdogLog "Scheduled task '$TaskName' is missing. Nothing to recover."
  exit 0
}

$info = Get-ScheduledTaskInfo -TaskName $TaskName
$health = Get-HealthInfo
$ageText = if ([double]::IsInfinity($health.ageSeconds)) { "missing" } else { ("{0:N0}s" -f $health.ageSeconds) }

Write-WatchdogLog "TaskState=$($task.State) LastTaskResult=$($info.LastTaskResult) HealthOk=$($health.ok) HealthAge=$ageText"

$needsRestart = $false
$reason = $null

if ($task.State -ne "Running") {
  $needsRestart = $true
  $reason = "task-not-running"
} elseif (-not $health.ok) {
  # Give the daemon a chance to self-heal; only intervene when health is clearly stale.
  if ($health.ageSeconds -gt ($HealthStaleSeconds * 2)) {
    $needsRestart = $true
    $reason = "health-stale"
  } else {
    Write-WatchdogLog "Health is not fresh yet, but within grace window. Daemon should self-recover."
  }
}

if (-not $needsRestart) {
  Write-WatchdogLog "Runner looks healthy. No action."
  exit 0
}

Write-WatchdogLog "Recovery triggered ($reason). Restarting scheduled task '$TaskName'."

try {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
} catch {
  Write-WatchdogLog "Stop-ScheduledTask warning: $($_.Exception.Message)"
}

Start-Sleep -Seconds 2
Stop-OrphanRunnerProcesses
Start-Sleep -Seconds 2

Start-ScheduledTask -TaskName $TaskName
Write-WatchdogLog "Scheduled task '$TaskName' restarted."

if (Test-Path $statePath) {
  @{
    recoveredAt = (Get-Date).ToString("o")
    reason = $reason
    previousHealth = $health
  } | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $logDirectory "runner-watchdog-last-recovery.json") -Encoding UTF8
}

exit 0
