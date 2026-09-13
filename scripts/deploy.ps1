# Deploy Agents-Chat through the guarded Windows restart flow.

param(
    [string]$TaskName = 'Agents-Chat-Startup',
    [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
    [switch]$SkipGitPull,
    [switch]$RemoveTask,
    [ValidateSet('Interactive', 'S4U')]
    [string]$TaskLogonType = 'Interactive',
    [ValidateSet('AtLogOn', 'AtStartup')]
    [string]$TaskTriggerType = 'AtLogOn',
    [switch]$NoWait,
    [int]$WaitSeconds = 180
)

$ErrorActionPreference = 'Stop'
$SafeRestartScript = Join-Path $PSScriptRoot 'safe-restart.ps1'

if (-not (Test-Path -LiteralPath $SafeRestartScript -PathType Leaf)) {
    throw "Safe restart script not found: $SafeRestartScript"
}

$arguments = @{
    Deploy = $true
    TaskName = $TaskName
    ProjectDir = $ProjectDir
    TaskLogonType = $TaskLogonType
    TaskTriggerType = $TaskTriggerType
    WaitSeconds = $WaitSeconds
}
if ($SkipGitPull) { $arguments.SkipGitPull = $true }
if ($RemoveTask) { $arguments.RemoveTask = $true }
if ($NoWait) { $arguments.NoWait = $true }

& $SafeRestartScript @arguments
exit $LASTEXITCODE
