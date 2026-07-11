param(
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path,
  [int]$RetryDelaySeconds = 10,
  [int]$MaxRetryDelaySeconds = 300,
  [int]$HealthStaleSeconds = 180,
  [int]$HealthCheckIntervalSeconds = 15
)

$ErrorActionPreference = "Stop"

$logDirectory = Join-Path $ProjectRoot "apps\windows-runner\logs"
$logPath = Join-Path $logDirectory "runner-daemon.log"
$healthPath = Join-Path $logDirectory "runner-health.json"
$startScript = Join-Path $PSScriptRoot "start-runner.ps1"
$statePath = Join-Path $logDirectory "runner-daemon-state.json"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 10MB) {
  Move-Item $logPath "$logPath.1" -Force
}

function Write-DaemonLog([string]$Message) {
  $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
  Add-Content -Path $logPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Write-DaemonState([hashtable]$State) {
  ($State | ConvertTo-Json -Depth 5) | Set-Content -Path $statePath -Encoding UTF8
}

function Stop-ProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) {
    return
  }

  try {
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  } catch {
    # Process may already be gone.
  }

  Start-Sleep -Seconds 1

  try {
    $remaining = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($remaining) {
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch {
    # Ignore races where the process exits between checks.
  }
}

function Test-HealthFresh {
  if (-not (Test-Path $healthPath)) {
    return $false
  }

  try {
    $health = Get-Content -Path $healthPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $false
  }

  $stamp = $null
  if ($health.lastHeartbeatAt) {
    $stamp = [datetime]::Parse($health.lastHeartbeatAt).ToUniversalTime()
  } elseif ($health.updatedAt) {
    $stamp = [datetime]::Parse($health.updatedAt).ToUniversalTime()
  }

  if (-not $stamp) {
    return $false
  }

  $ageSeconds = ((Get-Date).ToUniversalTime() - $stamp).TotalSeconds
  return ($ageSeconds -le $HealthStaleSeconds) -and ($health.lastHeartbeatOk -eq $true)
}

function Get-HealthAgeSeconds {
  if (-not (Test-Path $healthPath)) {
    return [double]::PositiveInfinity
  }

  try {
    $health = Get-Content -Path $healthPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $stampText = if ($health.lastHeartbeatAt) { $health.lastHeartbeatAt } else { $health.updatedAt }
    if (-not $stampText) {
      return [double]::PositiveInfinity
    }
    $stamp = [datetime]::Parse($stampText).ToUniversalTime()
    return ((Get-Date).ToUniversalTime() - $stamp).TotalSeconds
  } catch {
    return [double]::PositiveInfinity
  }
}

Write-DaemonLog "Daemon started (PID $PID). healthStale=${HealthStaleSeconds}s retry=${RetryDelaySeconds}-${MaxRetryDelaySeconds}s"
Write-DaemonState @{
  daemonPid = $PID
  startedAt = (Get-Date).ToString("o")
  status = "starting"
  runnerPid = $null
  consecutiveRestarts = 0
}

$skipInstall = $false
$currentDelay = $RetryDelaySeconds
$consecutiveRestarts = 0
$powerShell = Join-Path $PSHOME "powershell.exe"

while ($true) {
  $stdoutLog = Join-Path $logDirectory "runner-stdout.log"
  $stderrLog = Join-Path $logDirectory "runner-stderr.log"

  if ((Test-Path $stdoutLog) -and (Get-Item $stdoutLog).Length -gt 10MB) {
    Move-Item $stdoutLog "$stdoutLog.1" -Force
  }
  if ((Test-Path $stderrLog) -and (Get-Item $stderrLog).Length -gt 10MB) {
    Move-Item $stderrLog "$stderrLog.1" -Force
  }

  $argumentList = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", $startScript,
    "-ProjectRoot", $ProjectRoot
  )
  if ($skipInstall) {
    $argumentList += "-SkipInstall"
  }

  Write-DaemonLog "Starting runner (SkipInstall=$skipInstall)."
  Write-DaemonState @{
    daemonPid = $PID
    startedAt = (Get-Date).ToString("o")
    status = "starting-runner"
    runnerPid = $null
    consecutiveRestarts = $consecutiveRestarts
  }

  $proc = Start-Process `
    -FilePath $powerShell `
    -ArgumentList $argumentList `
    -WorkingDirectory $ProjectRoot `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

  Write-DaemonLog "Runner process started (PID $($proc.Id))."
  Write-DaemonState @{
    daemonPid = $PID
    startedAt = (Get-Date).ToString("o")
    status = "running"
    runnerPid = $proc.Id
    consecutiveRestarts = $consecutiveRestarts
    lastStartAt = (Get-Date).ToString("o")
  }

  $becameHealthy = $false
  $restartReason = "exited"

  while (-not $proc.HasExited) {
    Start-Sleep -Seconds $HealthCheckIntervalSeconds

    if ($proc.HasExited) {
      break
    }

    $age = Get-HealthAgeSeconds
    $healthy = Test-HealthFresh

    if ($healthy) {
      if (-not $becameHealthy) {
        Write-DaemonLog "Runner reported a healthy gateway heartbeat."
        $becameHealthy = $true
        $consecutiveRestarts = 0
        $currentDelay = $RetryDelaySeconds
      }

      Write-DaemonState @{
        daemonPid = $PID
        status = "healthy"
        runnerPid = $proc.Id
        consecutiveRestarts = $consecutiveRestarts
        lastHealthyAt = (Get-Date).ToString("o")
        healthAgeSeconds = [math]::Round($age, 1)
      }
      continue
    }

    # Allow a grace period after startup before treating missing health as fatal.
    $uptimeSeconds = ((Get-Date) - $proc.StartTime).TotalSeconds
    if ($uptimeSeconds -lt $HealthStaleSeconds) {
      Write-DaemonState @{
        daemonPid = $PID
        status = "warming-up"
        runnerPid = $proc.Id
        consecutiveRestarts = $consecutiveRestarts
        uptimeSeconds = [math]::Round($uptimeSeconds, 1)
        healthAgeSeconds = if ([double]::IsInfinity($age)) { $null } else { [math]::Round($age, 1) }
      }
      continue
    }

    $restartReason = "stale-health"
    Write-DaemonLog "Runner health is stale (age=${age}s > ${HealthStaleSeconds}s). Killing process tree $($proc.Id)."
    Stop-ProcessTree -ProcessId $proc.Id
    break
  }

  if (-not $proc.HasExited) {
    try { $proc.WaitForExit(15000) | Out-Null } catch { }
    if (-not $proc.HasExited) {
      Stop-ProcessTree -ProcessId $proc.Id
    }
  }

  $exitCode = $proc.ExitCode
  if ($null -eq $exitCode) {
    $exitCode = -1
  }

  $consecutiveRestarts += 1
  $skipInstall = $true

  if ($restartReason -eq "stale-health") {
    Write-DaemonLog "Runner killed due to stale health. Restart #$consecutiveRestarts in $currentDelay seconds."
  } else {
    Write-DaemonLog "Runner exited with code $exitCode. Restart #$consecutiveRestarts in $currentDelay seconds."
  }

  Write-DaemonState @{
    daemonPid = $PID
    status = "restarting"
    runnerPid = $null
    consecutiveRestarts = $consecutiveRestarts
    lastExitCode = $exitCode
    lastRestartReason = $restartReason
    nextRetrySeconds = $currentDelay
    nextStartAt = (Get-Date).AddSeconds($currentDelay).ToString("o")
  }

  Start-Sleep -Seconds $currentDelay

  if (-not $becameHealthy) {
    $currentDelay = [Math]::Min($currentDelay * 2, $MaxRetryDelaySeconds)
  } else {
    $currentDelay = $RetryDelaySeconds
  }
}
