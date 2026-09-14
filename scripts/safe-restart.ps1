# Safely deploy or restart the Agents-Chat Scheduled Task.

param(
    [switch]$Deploy,
    [switch]$SkipGitPull,
    [switch]$RemoveTask,
    [string]$TaskName = 'Agents-Chat-Startup',
    [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
    [ValidateSet('Interactive', 'S4U')]
    [string]$TaskLogonType = 'Interactive',
    [ValidateSet('AtLogOn', 'AtStartup')]
    [string]$TaskTriggerType = 'AtLogOn',
    [switch]$NoWait,
    [int]$WaitSeconds = 120,
    [int]$StopWaitSeconds = 45
)

$ErrorActionPreference = 'Stop'
$operationId = $null
$backupBatch = $null
$dataState = 'unchanged'
$restartBegan = $false
$NodePath = $null
$NpmPath = $null
$AppPort = 3000
$WatchdogLog = $null
$ChildLog = $null
$ChildErrLog = $null
$StopRequest = $null
$stopGeneration = $null
$stopWatchdogPid = 0

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Step {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" -ForegroundColor Cyan
}

function Convert-FirstJsonObject {
    param([string[]]$Lines)
    foreach ($line in $Lines) {
        $trimmed = [string]$line
        $trimmed = $trimmed.Trim()
        if ($trimmed.StartsWith('{')) {
            try { return $trimmed | ConvertFrom-Json } catch {}
        }
    }
    return $null
}

function Resolve-Node24 {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if (-not $command) {
        throw 'Node.js was not found. Install or activate Node.js 24 and retry.'
    }
    $candidate = $command.Source
    $reported = (& $candidate -p 'process.execPath').Trim()
    if ($LASTEXITCODE -ne 0 -or -not [IO.Path]::IsPathRooted($reported) -or
        -not (Test-Path -LiteralPath $reported -PathType Leaf)) {
        throw 'Node.js did not report a usable absolute process.execPath.'
    }
    $major = (& $reported -p "process.versions.node.split('.')[0]").Trim()
    if ($LASTEXITCODE -ne 0 -or $major -ne '24') {
        throw "NODE_VERSION_MISMATCH: Expected Node.js 24; executable: $reported"
    }
    return (Resolve-Path -LiteralPath $reported).Path
}

function Read-ConfiguredPort {
    param([string]$Path)
    $port = 3000
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $Path) {
            if ($line -match '^\s*PORT\s*=\s*["'']?([0-9]+)') {
                $port = [int]$Matches[1]
            }
        }
    }
    if ($env:PORT -and $env:PORT -match '^[0-9]+$') { $port = [int]$env:PORT }
    if ($port -lt 1 -or $port -gt 65535) { throw "Invalid application port: $port" }
    return $port
}

function Get-ServiceState {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq 'Running') { return 'running' }
    return 'stopped'
}

function Show-RecentLogs {
    foreach ($path in @($WatchdogLog, $ChildLog, $ChildErrLog)) {
        if (-not $path) { continue }
        Write-Host "`n=== $path ===" -ForegroundColor DarkCyan
        if (Test-Path -LiteralPath $path) {
            Get-Content -LiteralPath $path -Tail 60
        } else {
            Write-Host "Missing: $path" -ForegroundColor Yellow
        }
    }
}

function Write-StructuredFailure {
    param([string]$Code, [string]$Stage, [string]$Summary)
    $serviceState = Get-ServiceState
    Write-Host "SAFE RESTART FAILED [$Code]" -ForegroundColor Red
    Write-Host "`nWhat failed:`n  $Summary (stage: $Stage)"
    Write-Host "`nService state:"
    if ($serviceState -eq 'running' -and -not $restartBegan) {
        Write-Host '  The existing service is still running. No restart was attempted.'
    } elseif ($serviceState -eq 'running') {
        Write-Host '  The task restarted and is running, but verification did not complete.'
    } else {
        Write-Host '  The Scheduled Task is stopped or inactive. Inspect logs before changing live data.'
    }
    Write-Host "`nData state:"
    if ($dataState -eq 'validated') {
        Write-Host '  The live databases passed validation and were not modified.'
    } else {
        Write-Host '  The live databases were not modified.'
    }
    Write-Host "`nBackup state:"
    if ($backupBatch) {
        Write-Host "  A verified backup is available at: $backupBatch"
    } else {
        Write-Host '  No verified backup was created for this operation.'
    }
    Write-Host "`nNext actions:"
    if ($Code -eq 'PORT_IN_USE') {
        Write-Host "  1. Inspect the port owner: Get-NetTCPConnection -LocalPort $AppPort | Format-Table OwningProcess,State,LocalAddress,LocalPort"
        Write-Host '  2. Inspect that PID: Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" | Format-List ProcessId,ParentProcessId,ExecutablePath,CommandLine'
        Write-Host '  3. Stop or reconfigure only the identified process, then retry.'
    } else {
        Write-Host '  1. Correct the reported failure without modifying the live databases.'
        Write-Host '  2. Retry: .\scripts\safe-restart.ps1'
    }
    Write-Host "`nDiagnostics:"
    Write-Host "  Get-ScheduledTask -TaskName `"$TaskName`" | Get-ScheduledTaskInfo"
    Write-Host "  Get-Content `"$WatchdogLog`" -Tail 100"
    Write-Host "  Get-Content `"$ChildErrLog`" -Tail 100"
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw) | ConvertFrom-Json } catch { return $null }
}

function Get-TrackedWatchdogState {
    return (Read-JsonFile -Path (Join-Path $ProjectDir '.service-watchdog-state.json'))
}

function Test-OwnedWatchdog {
    param($State)
    if (-not $State -or [int]$State.Pid -le 0 -or [string]::IsNullOrWhiteSpace([string]$State.Generation)) {
        return $false
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$State.Pid)" -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    return (
        [string]$process.CreationDate -eq [string]$State.CreationDate -and
        $process.CommandLine -and
        $process.CommandLine.IndexOf((Join-Path $PSScriptRoot 'service-watchdog.ps1'), [StringComparison]::OrdinalIgnoreCase) -ge 0
    )
}

function Get-OwnedProcessSnapshots {
    param([int]$RootPid)
    $result = @()
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootPid" -ErrorAction SilentlyContinue)) {
        $result += @(Get-OwnedProcessSnapshots -RootPid ([int]$child.ProcessId))
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$RootPid" -ErrorAction SilentlyContinue
    if ($process) {
        $result += [pscustomobject]@{
            Pid = [int]$process.ProcessId
            CreationDate = [string]$process.CreationDate
        }
    }
    return $result
}

function Test-ProcessSnapshot {
    param($Snapshot)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Snapshot.Pid)" -ErrorAction SilentlyContinue
    return ($process -and ([string]$process.CreationDate -eq [string]$Snapshot.CreationDate))
}

function Wait-ForOwnedProcesses {
    param([object[]]$Snapshots, [datetime]$Deadline)
    $remaining = @($Snapshots)
    while ((Get-Date) -lt $Deadline) {
        $remaining = @($remaining | Where-Object { Test-ProcessSnapshot -Snapshot $_ })
        if ($remaining.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    }
    return @($remaining | Where-Object { Test-ProcessSnapshot -Snapshot $_ })
}

function Write-StopRequest {
    param([string]$Generation, [int]$WatchdogPid)
    $request = [ordered]@{
        Generation = $Generation
        WatchdogPid = $WatchdogPid
        RequestedByPid = $PID
        RequestedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $temporary = "$StopRequest.$PID.new"
    [IO.File]::WriteAllText($temporary, ($request | ConvertTo-Json -Compress))
    Move-Item -LiteralPath $temporary -Destination $StopRequest -Force
}

function Clear-MatchingStopRequest {
    param([string]$Generation, [int]$WatchdogPid)
    if (-not $Generation -or $WatchdogPid -le 0) { return }
    $request = Read-JsonFile -Path $StopRequest
    if ($request -and [string]$request.Generation -eq $Generation -and
        [int]$request.WatchdogPid -eq $WatchdogPid) {
        Remove-Item -LiteralPath $StopRequest -Force -ErrorAction SilentlyContinue
    }
}

function Stop-TrackedTaskGracefully {
    $state = Get-TrackedWatchdogState
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $state) {
        if ($task -and $task.State -eq 'Running') {
            throw 'The Scheduled Task is running without an owned watchdog state file; refusing an unscoped stop.'
        }
        Remove-Item -LiteralPath $StopRequest -Force -ErrorAction SilentlyContinue
        return
    }
    if (-not (Get-Process -Id ([int]$state.Pid) -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath (Join-Path $ProjectDir '.service-watchdog-state.json') -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $StopRequest -Force -ErrorAction SilentlyContinue
        if ($task -and $task.State -eq 'Running') {
            throw 'The Scheduled Task is running but its recorded watchdog PID has exited; retry after Task Scheduler updates its state.'
        }
        return
    }
    if (-not (Test-OwnedWatchdog -State $state)) {
        throw "Tracked watchdog PID $($state.Pid) no longer belongs to this checkout; refusing to terminate it."
    }

    $script:stopGeneration = [string]$state.Generation
    $script:stopWatchdogPid = [int]$state.Pid
    Write-StopRequest -Generation $script:stopGeneration -WatchdogPid $script:stopWatchdogPid
    $ownedProcesses = @(Get-OwnedProcessSnapshots -RootPid $script:stopWatchdogPid)
    $remaining = @(Wait-ForOwnedProcesses -Snapshots $ownedProcesses -Deadline (Get-Date).AddSeconds($StopWaitSeconds))
    if ($remaining.Count -gt 0) {
        Write-Step "Grace period expired; forcing only remaining owned processes from watchdog generation $script:stopGeneration."
        foreach ($snapshot in $remaining) {
            if (Test-ProcessSnapshot -Snapshot $snapshot) {
                Stop-Process -Id ([int]$snapshot.Pid) -Force -ErrorAction SilentlyContinue
            }
        }
        $remaining = @(Wait-ForOwnedProcesses -Snapshots $remaining -Deadline (Get-Date).AddSeconds(5))
        if ($remaining.Count -gt 0) {
            throw "Owned processes did not exit after forced shutdown: $((@($remaining | ForEach-Object { $_.Pid })) -join ', ')"
        }
    }
}

function Assert-PortAvailable {
    $owners = @(Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        Where-Object { $_ -and $_ -ne 0 })
    if ($owners.Count -gt 0) {
        $details = @()
        foreach ($ownerPid in $owners) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
            $details += "PID=$ownerPid Name=$($process.Name) Path=$($process.ExecutablePath)"
        }
        throw "PORT_IN_USE: Port $AppPort remains occupied. $($details -join '; ')"
    }
}

function Test-StorageHealth {
    if ($NoWait -or $WaitSeconds -eq 0) { return $true }
    $url = "http://localhost:$AppPort/api/health/storage"
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $healthScript = @'
const url = process.argv[1];
fetch(url).then(response => {
  if (!response.ok) process.exitCode = 1;
}).catch(() => { process.exitCode = 1; });
'@
    while ((Get-Date) -lt $deadline) {
        & $NodePath -e $healthScript $url
        if ($LASTEXITCODE -eq 0) { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

if (-not (Test-IsAdministrator)) {
    throw "safe-restart.ps1 controls the '$TaskName' Scheduled Task and must run elevated."
}
if ($WaitSeconds -lt 0 -or $StopWaitSeconds -lt 0) {
    throw 'WaitSeconds and StopWaitSeconds must be non-negative.'
}

$Preflight = Join-Path $PSScriptRoot 'runtime-preflight.mjs'
$LeaseRelease = Join-Path $PSScriptRoot 'release-operation-lease.mjs'
$Installer = Join-Path $PSScriptRoot 'install-scheduled-task.ps1'

$failureCode = $null
$failureStage = $null
$failureSummary = $null
$exitCode = 0
try {
    $ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
    $WatchdogLog = Join-Path $ProjectDir 'logs\service-watchdog.log'
    $ChildLog = Join-Path $ProjectDir 'logs\start-service-child.log'
    $ChildErrLog = Join-Path $ProjectDir 'logs\start-service-child.err.log'
    $StopRequest = Join-Path $ProjectDir '.service-stop-request.json'
    $NodePath = Resolve-Node24
    $NpmPath = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $NpmPath -PathType Leaf)) {
        throw "npm.cmd was not found beside the validated Node.js executable: $NpmPath"
    }
    $AppPort = Read-ConfiguredPort -Path (Join-Path $ProjectDir '.env.local')
    Set-Location $ProjectDir

    $acquireOutput = @(& $NodePath $Preflight acquire-lease --project-root $ProjectDir --owner windows-safe-restart --owner-pid $PID --manager windows 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $failure = Convert-FirstJsonObject -Lines $acquireOutput
        $failureCode = if ($failure -and $failure.failure.code) { $failure.failure.code } else { 'UNEXPECTED_ERROR' }
        throw 'Runtime validation or operation lease acquisition failed.'
    }
    $acquire = ($acquireOutput -join "`n") | ConvertFrom-Json
    $operationId = $acquire.lease.operationId
    if (-not $operationId) { throw 'Preflight returned no operation ID.' }

    if ($Deploy -and -not $SkipGitPull -and (Test-Path -LiteralPath (Join-Path $ProjectDir '.git'))) {
        Write-Step 'Pulling latest code...'
        & git pull --ff-only
        if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only failed.' }
    }

    if ($Deploy) {
        Write-Step 'Installing locked npm dependencies with Node.js 24...'
        & $NpmPath ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            $failureCode = 'DEPENDENCY_INSTALL_FAILED'
            $failureStage = 'dependency-install'
            throw 'npm ci failed; the existing service was not stopped.'
        }
    } elseif (-not (Test-Path -LiteralPath (Join-Path $ProjectDir '.next\BUILD_ID') -PathType Leaf)) {
        $failureCode = 'BUILD_FAILED'
        $failureStage = 'build-check'
        throw 'Production build is missing. Run .\scripts\deploy.ps1 before restart-only.'
    }

    Write-Step 'Validating storage and creating a verified backup...'
    $prepareOutput = @(& $NodePath $Preflight prepare --project-root $ProjectDir --operation-id $operationId --manager windows 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $failure = Convert-FirstJsonObject -Lines $prepareOutput
        if ($failure -and $failure.failure) {
            $failureCode = $failure.failure.code
            $dataState = $failure.failure.dataState
            $backupBatch = $failure.failure.backupBatch
        }
        $failureStage = 'preflight'
        throw 'Runtime, database validation, or verified backup failed.'
    }
    $prepared = ($prepareOutput -join "`n") | ConvertFrom-Json
    $backupBatch = $prepared.backup.path
    $dataState = 'validated'

    if ($Deploy) {
        Write-Step 'Building production application...'
        & $NpmPath run build
        if ($LASTEXITCODE -ne 0) {
            $failureCode = 'BUILD_FAILED'
            $failureStage = 'build'
            throw 'npm run build failed; the existing service was not stopped.'
        }
    }

    Write-Step "Stopping Scheduled Task '$TaskName' through its stop marker..."
    Stop-TrackedTaskGracefully
    Assert-PortAvailable

    if ($RemoveTask) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Scheduled Task '$TaskName' removed after a verified backup." -ForegroundColor Green
        return
    }

    Write-Step "Installing Scheduled Task '$TaskName' with NodePath=$NodePath..."
    try {
        & $Installer -TaskName $TaskName -ProjectDir $ProjectDir -LogonType $TaskLogonType `
            -TriggerType $TaskTriggerType -NodePath $NodePath -AppPort $AppPort | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "Installer exited with code $LASTEXITCODE."
        }
    } catch {
        $failureCode = 'SERVICE_START_FAILED'
        $failureStage = 'task-install'
        throw "Scheduled Task installation failed: $($_.Exception.Message)"
    }

    $restartBegan = $true
    Write-Step "Starting Scheduled Task '$TaskName'..."
    Start-ScheduledTask -TaskName $TaskName

    if (-not (Test-StorageHealth)) {
        $failureCode = 'STORAGE_HEALTH_FAILED'
        $failureStage = 'storage-health'
        throw "The task did not pass /api/health/storage within $WaitSeconds seconds."
    }

    Write-Host "Safe Windows restart completed. Node=$NodePath Port=$AppPort Backup=$backupBatch" -ForegroundColor Green
    Show-RecentLogs
} catch {
    $exitCode = 1
    if (-not $failureCode) {
        if ($_.Exception.Message.StartsWith('NODE_VERSION_MISMATCH:')) {
            $failureCode = 'NODE_VERSION_MISMATCH'
            $failureStage = 'runtime'
        } elseif ($_.Exception.Message.StartsWith('PORT_IN_USE:')) {
            $failureCode = 'PORT_IN_USE'
            $failureStage = 'port-check'
        } else {
            $failureCode = 'UNEXPECTED_ERROR'
            if (-not $failureStage) { $failureStage = 'windows-safe-restart' }
        }
    }
    $failureSummary = $_.Exception.Message
    Write-StructuredFailure -Code $failureCode -Stage $failureStage -Summary $failureSummary
    Show-RecentLogs
} finally {
    Clear-MatchingStopRequest -Generation $stopGeneration -WatchdogPid $stopWatchdogPid
    if ($operationId) {
        & $NodePath $LeaseRelease --project-root $ProjectDir --operation-id $operationId | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Operation lease $operationId could not be released by $LeaseRelease." -ForegroundColor Red
            $exitCode = 1
        }
    }
}

exit $exitCode
