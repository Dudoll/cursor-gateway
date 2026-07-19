param(
  [string]$TaskName = "CursorGatewayE2eeRunner",
  [string]$Distro = "Ubuntu-22.04",
  [string]$WslUser = "dministrator",
  [switch]$Start
)

$ErrorActionPreference = "Stop"
$wslExe = Join-Path $env:SystemRoot "System32\wsl.exe"
if (-not (Test-Path $wslExe)) {
  throw "wsl.exe not found at $wslExe"
}

$supervisor = 'exec bash $HOME/cursor-e2ee/apps/windows-runner/scripts/wsl-e2ee-supervisor.sh'
$arguments = "-d $Distro -u $WslUser -e bash -lc `"$supervisor`""
$action = New-ScheduledTaskAction -Execute $wslExe -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited
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
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Canonical single-instance WSL1 supervisor for Cursor Gateway runner wsl-e2ee."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

# Keep legacy launchers disabled so they cannot create duplicate runner IDs.
foreach ($legacy in @(
  "CursorGatewayWslRunner",
  "CursorGatewayWindowsRunner",
  "CursorGatewayWindowsRunnerWatchdog"
)) {
  $existing = Get-ScheduledTask -TaskName $legacy -ErrorAction SilentlyContinue
  if ($existing) {
    Disable-ScheduledTask -InputObject $existing | Out-Null
  }
}

if ($Start) {
  Start-ScheduledTask -TaskName $TaskName
}

$registered = Get-ScheduledTask -TaskName $TaskName
[pscustomobject]@{
  TaskName = $registered.TaskName
  State = [string]$registered.State
  Execute = $registered.Actions.Execute
  Arguments = $registered.Actions.Arguments
  Started = [bool]$Start
}
