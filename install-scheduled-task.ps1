# Installs Agents-Chat as a Scheduled Task running as the wulei user.
# This uses the service-watchdog.ps1 wrapper, so start.ps1 is restarted if it exits.

param(
    [string]$TaskName = 'Agents-Chat-Startup',
    [string]$ProjectDir = 'Q:\repos\Agents-Chat',
    [string]$UserId = 'FAREAST\wulei',
    [ValidateSet('Interactive', 'S4U')]
    [string]$LogonType = 'Interactive',
    [ValidateSet('AtLogOn', 'AtStartup')]
    [string]$TriggerType = 'AtLogOn'
)

$ErrorActionPreference = 'Stop'

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
    throw "install-scheduled-task.ps1 registers a highest-privilege Scheduled Task and must be run from an elevated PowerShell session. Run PowerShell as Administrator and try again."
}

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

$Trigger = if ($TriggerType -eq 'AtStartup') {
    New-ScheduledTaskTrigger -AtStartup
} else {
    New-ScheduledTaskTrigger -AtLogOn -User $UserId
}

# Interactive runs on demand without storing a password when the user is logged in.
# S4U can run without an interactive login, but may not start reliably for Entra-backed users.
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType $LogonType -RunLevel Highest

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
    -Description 'Start Agents-Chat as wulei and watchdog start.ps1.' `
    -Force | Out-Null

$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
    TaskName = $Task.TaskName
    State = $Task.State.ToString()
    UserId = $Task.Principal.UserId
    LogonType = $Task.Principal.LogonType.ToString()
    RunLevel = $Task.Principal.RunLevel.ToString()
    Trigger = $TriggerType
    Execute = $Task.Actions[0].Execute
    Arguments = $Task.Actions[0].Arguments
    WorkingDirectory = $Task.Actions[0].WorkingDirectory
    LastRunTime = if ($Info.LastRunTime) { $Info.LastRunTime.ToString('s') } else { '' }
    NextRunTime = if ($Info.NextRunTime) { $Info.NextRunTime.ToString('s') } else { '' }
    LastTaskResult = $Info.LastTaskResult
} | ConvertTo-Json -Compress
