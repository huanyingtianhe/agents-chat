# Deploy Agents-Chat by restarting the boot Scheduled Task.
# This causes service-watchdog.ps1 to invoke start.ps1, which rebuilds and restarts the app.

param(
    [string]$TaskName = 'Agents-Chat-Startup',
    [string]$ProjectDir = 'Q:\repos\Agents-Chat',
    [switch]$SkipGitPull,
    [switch]$NoWait,
    [int]$WaitSeconds = 180
)

$ErrorActionPreference = 'Stop'

$WatchdogLog = Join-Path $ProjectDir 'logs\service-watchdog.log'
$ChildLog = Join-Path $ProjectDir 'logs\start-service-child.log'
$ChildErrLog = Join-Path $ProjectDir 'logs\start-service-child.err.log'

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

if (-not (Test-Path $ProjectDir)) {
    throw "Project directory not found: $ProjectDir"
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    $InstallScript = Join-Path $ProjectDir 'install-scheduled-task.ps1'
    if (-not (Test-Path $InstallScript)) {
        throw "Scheduled Task not found: $TaskName, and install script not found: $InstallScript"
    }
    Write-Step "Scheduled Task '$TaskName' not found; installing it first..."
    & $InstallScript -TaskName $TaskName -ProjectDir $ProjectDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to install Scheduled Task via $InstallScript" }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { throw "Scheduled Task still not found after running $InstallScript" }
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

# The task may have spawned app/tunnel child processes. Clean up the usual app port before restart.
Write-Step 'Cleaning up port 3000 if needed...'
$oldPids = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    Where-Object { $_ -and $_ -ne 0 }
foreach ($p in $oldPids) {
    Write-Host "Stopping PID $p on port 3000" -ForegroundColor Yellow
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
}

Write-Step "Starting Scheduled Task '$TaskName'..."
Start-ScheduledTask -TaskName $TaskName

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
