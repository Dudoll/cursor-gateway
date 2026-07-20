param(
  [string[]]$TaskNames = @(
    "CursorGatewayE2eeRunner",
    "CursorGatewayWslRunner",
    "CursorGatewayWindowsRunner",
    "CursorGatewayWindowsRunnerWatchdog"
  )
)

$ErrorActionPreference = "Stop"
$removed = @()

foreach ($name in $TaskNames | Select-Object -Unique) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) {
    continue
  }

  Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  $removed += $name
}

[pscustomobject]@{
  AutoStartEnabled = $false
  RemovedTasks = $removed
}
