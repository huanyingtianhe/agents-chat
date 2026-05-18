# Deploy Agents-Chat by restarting the boot Scheduled Task.
# This causes service-watchdog.ps1 to invoke start.ps1, which rebuilds and restarts the app.
# Use -RemoveTask to stop and unregister the Scheduled Task.

param(
    [string]$TaskName = 'Agents-Chat-Startup',
    [string]$ProjectDir = 'Q:\repos\Agents-Chat',
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

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
    throw "deploy.ps1 controls the '$TaskName' Scheduled Task and must be run from an elevated PowerShell session. Run PowerShell as Administrator, or use .\start.ps1 for a foreground local start."
}

$WatchdogLog = Join-Path $ProjectDir 'logs\service-watchdog.log'
$ChildLog = Join-Path $ProjectDir 'logs\start-service-child.log'
$ChildErrLog = Join-Path $ProjectDir 'logs\start-service-child.err.log'
$StopFile = Join-Path $ProjectDir '.service-stop'

function Write-Step {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" -ForegroundColor Cyan
}

function Show-RecentLogs {
    Write-Host "`n=== service-watchdog.log ===" -ForegroundColor DarkCyan
    if (Test-Path $WatchdogLog) { Get-Content $WatchdogLog -Tail 40 } else { Write-Host "Missing: $WatchdogLog" -ForegroundColor Yellow }

    Write-Host "`n=== start-service-child.log ===" -ForegroundColor DarkCyan
    if (Test-Path $ChildLog) { Get-Content $ChildLog -Tail 80 } else { Write-Host "Missing: $ChildLog" -ForegroundColor Yellow }

    Write-Host "`n=== start-service-child.err.log ===" -ForegroundColor DarkCyan
    if (Test-Path $ChildErrLog) { Get-Content $ChildErrLog -Tail 80 } else { Write-Host "Missing: $ChildErrLog" -ForegroundColor Yellow }
}

function Stop-Port3000Processes {
    $oldPids = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        Where-Object { $_ -and $_ -ne 0 }
    foreach ($p in $oldPids) {
        Write-Host "Stopping PID $p on port 3000" -ForegroundColor Yellow
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
}

function Test-TaskMatchesExpectedConfiguration {
    param([Parameter(Mandatory=$true)]$Task)

    $hasExpectedLogon = $Task.Principal.LogonType.ToString() -eq $TaskLogonType
    $hasExpectedTrigger = if ($TaskTriggerType -eq 'AtStartup') {
        $Task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }
    } else {
        $Task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }
    }

    return $hasExpectedLogon -and [bool]$hasExpectedTrigger
}

function Install-AgentsChatTask {
    $InstallScript = Join-Path $ProjectDir 'install-scheduled-task.ps1'
    if (-not (Test-Path $InstallScript)) {
        throw "Install script not found: $InstallScript"
    }

    & $InstallScript -TaskName $TaskName -ProjectDir $ProjectDir -LogonType $TaskLogonType -TriggerType $TaskTriggerType
    if ($LASTEXITCODE -ne 0) { throw "Failed to install Scheduled Task via $InstallScript" }
}

if ($RemoveTask) {
    Write-Step "Removing Scheduled Task '$TaskName'..."
    if (Test-Path $ProjectDir) {
        New-Item -ItemType File -Path $StopFile -Force | Out-Null
    } else {
        Write-Host "Project directory not found; skipping stop marker: $ProjectDir" -ForegroundColor Yellow
    }

    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    } else {
        Write-Host "Scheduled Task not found: $TaskName" -ForegroundColor Yellow
    }

    Write-Step 'Cleaning up port 3000 if needed...'
    Stop-Port3000Processes

    $remainingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($remainingTask) { throw "Failed to remove Scheduled Task: $TaskName" }

    Write-Host "Scheduled Task '$TaskName' removed." -ForegroundColor Green
    exit 0
}

if (-not (Test-Path $ProjectDir)) {
    throw "Project directory not found: $ProjectDir"
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Step "Scheduled Task '$TaskName' not found; installing it first..."
    Install-AgentsChatTask
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { throw "Scheduled Task still not found after running install-scheduled-task.ps1" }
} elseif (-not (Test-TaskMatchesExpectedConfiguration -Task $task)) {
    Write-Step "Scheduled Task '$TaskName' uses $($task.Principal.LogonType)/older trigger settings; reinstalling as $TaskLogonType/$TaskTriggerType..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Install-AgentsChatTask
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { throw "Scheduled Task still not found after reinstalling" }
}

Set-Location $ProjectDir

if (-not $SkipGitPull -and (Test-Path (Join-Path $ProjectDir '.git'))) {
    Write-Step 'Pulling latest code...'
    git pull
    if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }
}

Write-Step "Stopping Scheduled Task '$TaskName'..."
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

Write-Step 'Clearing service stop marker if present...'
Remove-Item $StopFile -Force -ErrorAction SilentlyContinue

# The task may have spawned app/tunnel child processes. Clean up the usual app port before restart.
Write-Step 'Cleaning up port 3000 if needed...'
Stop-Port3000Processes

Write-Step "Starting Scheduled Task '$TaskName'..."
$lastRunBefore = (Get-ScheduledTaskInfo -TaskName $TaskName).LastRunTime
Start-ScheduledTask -TaskName $TaskName

$taskStarted = $false
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    if ((Test-Path $WatchdogLog) -or ($task -and $task.State -eq 'Running') -or ($taskInfo -and $taskInfo.LastRunTime -ne $lastRunBefore)) {
        $taskStarted = $true
        break
    }
}

if (-not $taskStarted) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $taskInfo) {
        [pscustomobject]@{
            State = $task.State.ToString()
            LastRunTime = $taskInfo.LastRunTime.ToString('s')
            LastTaskResult = $taskInfo.LastTaskResult
            LogonType = $task.Principal.LogonType.ToString()
            TriggerClasses = ($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', '
        } | ConvertTo-Json -Compress | Write-Host -ForegroundColor Yellow
    }
    throw "Scheduled Task '$TaskName' did not start. Re-run this elevated deploy so it can reinstall the task as $TaskLogonType/$TaskTriggerType, or remove it with .\deploy.ps1 -RemoveTask and try again."
}

if ($NoWait) {
    Write-Host "Deploy triggered. Logs:" -ForegroundColor Green
    Write-Host "  $WatchdogLog"
    Write-Host "  $ChildLog"
    Write-Host "  $ChildErrLog"
    exit 0
}

Write-Step "Waiting up to $WaitSeconds seconds for app readiness..."
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    try {
        $response = Invoke-WebRequest -Uri 'http://localhost:3000/login' -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
            $ready = $true
            break
        }
    } catch {
        # Keep waiting while build/server/tunnel start.
    }
}

if ($ready) {
    Write-Host "`nDeploy complete: http://localhost:3000/login is responding." -ForegroundColor Green
    Show-RecentLogs
    exit 0
}

Write-Host "`nDeploy was triggered, but localhost:3000/login did not respond within $WaitSeconds seconds." -ForegroundColor Yellow
Show-RecentLogs
exit 1
