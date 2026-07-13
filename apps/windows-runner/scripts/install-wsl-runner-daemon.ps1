param(
  [string]$TaskName = "CursorGatewayWslRunner",
  [string]$Distro = "Ubuntu-22.04",
  [string]$WslUser = "dministrator",
  [string]$RunAsUser = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = "Stop"

$wslExe = Join-Path $env:SystemRoot "System32\wsl.exe"
if (-not (Test-Path $wslExe)) {
  throw "wsl.exe not found at $wslExe"
}

# Launch the in-WSL daemon loop. $HOME is expanded by bash inside WSL, so keep
# this string single-quoted in PowerShell.
$daemon = 'bash $HOME/cursor-vps/cursor-gateway/apps/windows-runner/scripts/wsl-runner-daemon.sh'
$arguments = "-d $Distro -u $WslUser -e bash -lc `"$daemon`""

$action = New-ScheduledTaskAction -Execute $wslExe -Argument $arguments

$trigger = New-ScheduledTaskTrigger -AtStartup

# Run as the WSL distro owner (WSL distributions are registered per Windows
# user; SYSTEM cannot see them). S4U runs whether the user is logged on or not
# without storing a password.
$principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType S4U -RunLevel Highest

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
  -Description "Keeps the Cursor Gateway runner online inside WSL1 ($Distro) with crash retry."

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "Runs: $wslExe $arguments"
Write-Host "Log (WSL): ~/cursor-vps/cursor-gateway/apps/windows-runner/logs/wsl-runner-daemon.log"
