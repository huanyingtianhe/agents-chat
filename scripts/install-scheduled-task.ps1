# Install Agents-Chat as a Scheduled Task using a validated absolute Node.js 24 path.

param(
    [string]$TaskName = 'Agents-Chat-Startup',
    [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
    [string]$UserId = 'FAREAST\wulei',
    [ValidateSet('Interactive', 'S4U')]
    [string]$LogonType = 'Interactive',
    [ValidateSet('AtLogOn', 'AtStartup')]
    [string]$TriggerType = 'AtLogOn',
    [Parameter(Mandatory=$true)]
    [string]$NodePath,
    [int]$AppPort = 3000
)

$ErrorActionPreference = 'Stop'

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-ValidatedNodePath {
    param([string]$Candidate)
    if (-not [IO.Path]::IsPathRooted($Candidate) -or -not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
        throw "NodePath must be an existing absolute executable path: $Candidate"
    }
    $resolved = (Resolve-Path -LiteralPath $Candidate).Path
    $reported = (& $resolved -p 'process.execPath').Trim()
    if ($LASTEXITCODE -ne 0 -or $reported -ine $resolved) {
        throw "NodePath did not report the same process.execPath: $resolved"
    }
    $major = (& $resolved -p "process.versions.node.split('.')[0]").Trim()
    if ($LASTEXITCODE -ne 0 -or $major -ne '24') {
        throw "Scheduled Task requires Node.js 24. Resolved executable: $resolved"
    }
    return $resolved
}

if (-not (Test-IsAdministrator)) {
    throw "install-scheduled-task.ps1 must run from an elevated PowerShell session."
}
if ($AppPort -lt 1 -or $AppPort -gt 65535) {
    throw "AppPort must be between 1 and 65535."
}

$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
$NodePath = Resolve-ValidatedNodePath -Candidate $NodePath
$WatchdogScript = Join-Path $PSScriptRoot 'service-watchdog.ps1'
if (-not (Test-Path -LiteralPath $WatchdogScript -PathType Leaf)) {
    throw "Watchdog script not found: $WatchdogScript"
}

$escapedWatchdog = $WatchdogScript.Replace('"', '""')
$escapedNode = $NodePath.Replace('"', '""')
$actionArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$escapedWatchdog`" -NodePath `"$escapedNode`" -AppPort $AppPort"
$Action = New-ScheduledTaskAction `
    -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -Argument $actionArguments `
    -WorkingDirectory $ProjectDir

$Trigger = if ($TriggerType -eq 'AtStartup') {
    New-ScheduledTaskTrigger -AtStartup
} else {
    New-ScheduledTaskTrigger -AtLogOn -User $UserId
}
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
    -Description 'Start Agents-Chat with a guarded Node.js 24 watchdog.' `
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
    NodePath = $NodePath
    AppPort = $AppPort
    Execute = $Task.Actions[0].Execute
    Arguments = $Task.Actions[0].Arguments
    WorkingDirectory = $Task.Actions[0].WorkingDirectory
    LastRunTime = if ($Info.LastRunTime) { $Info.LastRunTime.ToString('s') } else { '' }
    NextRunTime = if ($Info.NextRunTime) { $Info.NextRunTime.ToString('s') } else { '' }
    LastTaskResult = $Info.LastTaskResult
} | ConvertTo-Json -Compress
