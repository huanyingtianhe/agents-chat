# Installs Agents-Chat as a boot Scheduled Task running as the wulei user.
# This uses the service-watchdog.ps1 wrapper, so start.ps1 is restarted if it exits.

param(
    [string]$TaskName = 'Agents-Chat-Startup',
    [string]$ProjectDir = 'Q:\repos\Agents-Chat',
    [string]$UserId = 'FAREAST\wulei'
)

$ErrorActionPreference = 'Stop'

$WatchdogScript = Join-Path $ProjectDir 'service-watchdog.ps1'
if (-not (Test-Path $WatchdogScript)) {
    throw "Watchdog script not found: $WatchdogScript"
}

# Do not let a previous graceful-stop marker prevent the watchdog loop.
Remove-Item (Join-Path $ProjectDir '.service-stop') -Force -ErrorAction SilentlyContinue

$Action = New-ScheduledTaskAction `
    -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$WatchdogScript`"" `
    -WorkingDirectory $ProjectDir

$Trigger = New-ScheduledTaskTrigger -AtStartup

# S4U = runs under this user whether or not the user is interactively logged in,
# without prompting/storing the account password. It is suitable for local resources.
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType S4U -RunLevel Highest

$Settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description 'Start Agents-Chat at Windows boot as wulei and watchdog start.ps1.' `
    -Force | Out-Null

$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
    TaskName = $Task.TaskName
    State = $Task.State.ToString()
    UserId = $Task.Principal.UserId
    LogonType = $Task.Principal.LogonType.ToString()
    RunLevel = $Task.Principal.RunLevel.ToString()
    Trigger = 'AtStartup'
    Execute = $Task.Actions[0].Execute
    Arguments = $Task.Actions[0].Arguments
    WorkingDirectory = $Task.Actions[0].WorkingDirectory
    LastRunTime = if ($Info.LastRunTime) { $Info.LastRunTime.ToString('s') } else { '' }
    NextRunTime = if ($Info.NextRunTime) { $Info.NextRunTime.ToString('s') } else { '' }
    LastTaskResult = $Info.LastTaskResult
} | ConvertTo-Json -Compress
