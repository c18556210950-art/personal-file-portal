param([switch]$AtBoot)
$ErrorActionPreference = 'Stop'
$python = (Get-Command pythonw.exe -ErrorAction Stop).Source
$agent = Join-Path $PSScriptRoot 'agent.py'
$action = New-ScheduledTaskAction -Execute $python -Argument ('"{0}" run' -f $agent) -WorkingDirectory $PSScriptRoot
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$time = New-TimeSpan -Minutes 1
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 15 -RestartInterval $time -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($AtBoot) {
  $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType S4U -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $task = 'PersonalFilePortalBoot'
} else {
  $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
  $task = 'PersonalFilePortal'
}
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
if ($AtBoot) {
  Stop-ScheduledTask -TaskName PersonalFilePortal -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 20 -and (Get-ScheduledTask -TaskName PersonalFilePortal -ErrorAction SilentlyContinue).State -eq 'Running'; $attempt++) {
    Start-Sleep -Milliseconds 250
  }
}
Start-ScheduledTask -TaskName $task
