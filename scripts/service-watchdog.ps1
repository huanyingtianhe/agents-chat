# Scheduled Task watchdog for Agents-Chat.

param(
    [Parameter(Mandatory=$true)]
    [string]$NodePath,
    [int]$AppPort = 3000
)

$ErrorActionPreference = 'Continue'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot 'start.ps1'
$LogDir = Join-Path $ProjectDir 'logs'
$LogFile = Join-Path $LogDir 'service-watchdog.log'
$ChildLog = Join-Path $LogDir 'start-service-child.log'
$ChildErr = Join-Path $LogDir 'start-service-child.err.log'
$StopRequest = Join-Path $ProjectDir '.service-stop-request.json'
$LegacyStopFile = Join-Path $ProjectDir '.service-stop'
$WatchdogStateFile = Join-Path $ProjectDir '.service-watchdog-state.json'
$ChildStateFile = Join-Path $ProjectDir '.service-child-state.json'
$RestartDelaySeconds = 10
$MaxBackoffSeconds = 120
$GraceSeconds = 35
$Generation = [guid]::NewGuid().ToString('D')

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-ServiceLog {
    param([string]$Message)
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" |
        Tee-Object -FilePath $LogFile -Append
}

function Write-JsonFile {
    param([string]$Path, $Value)
    $temporary = "$Path.$PID.new"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Compress))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw) | ConvertFrom-Json } catch { return $null }
}

function Test-StopRequested {
    $request = Read-JsonFile -Path $StopRequest
    return (
        $request -and [string]$request.Generation -eq $Generation -and
        [int]$request.WatchdogPid -eq $PID
    )
}

function Clear-MatchingStopRequest {
    $request = Read-JsonFile -Path $StopRequest
    if ($request -and [string]$request.Generation -eq $Generation -and
        [int]$request.WatchdogPid -eq $PID) {
        Remove-Item -LiteralPath $StopRequest -Force -ErrorAction SilentlyContinue
    }
}

function Clear-OwnedStateFile {
    param([string]$Path)
    $state = Read-JsonFile -Path $Path
    if ($state -and [string]$state.Generation -eq $Generation) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
}

function Wait-ForStopRequest {
    param([int]$Seconds)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-StopRequested) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return (Test-StopRequested)
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

function Complete-CooperativeChildStop {
    param([int]$RootPid)
    $ownedProcesses = @(Get-OwnedProcessSnapshots -RootPid $RootPid)
    Write-ServiceLog "Waiting for start.ps1 PID $RootPid and its captured descendants to stop cooperatively."
    $remaining = @(Wait-ForOwnedProcesses -Snapshots $ownedProcesses -Deadline (Get-Date).AddSeconds($GraceSeconds))
    if ($remaining.Count -eq 0) { return }

    Write-ServiceLog "Grace period expired; forcing only remaining owned processes from generation $Generation."
    foreach ($snapshot in $remaining) {
        if (Test-ProcessSnapshot -Snapshot $snapshot) {
            Stop-Process -Id ([int]$snapshot.Pid) -Force -ErrorAction SilentlyContinue
        }
    }
    $remaining = @(Wait-ForOwnedProcesses -Snapshots $remaining -Deadline (Get-Date).AddSeconds(5))
    if ($remaining.Count -gt 0) {
        Write-ServiceLog "Owned processes still running after forced shutdown: $((@($remaining | ForEach-Object { $_.Pid })) -join ', ')"
    }
}

try {
    Remove-Item -LiteralPath $LegacyStopFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $StopRequest -Force -ErrorAction SilentlyContinue
    $watchdogProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    Write-JsonFile -Path $WatchdogStateFile -Value ([ordered]@{
        Generation = $Generation
        Pid = $PID
        CreationDate = [string]$watchdogProcess.CreationDate
        StartedAt = (Get-Date).ToUniversalTime().ToString('o')
    })
    $env:PATH = "$(Split-Path -Parent $NodePath);$env:PATH"
    $env:AGENTS_CHAT_SERVICE = '1'
    Write-ServiceLog "Watchdog starting. Generation=$Generation PID=$PID NodePath=$NodePath AppPort=$AppPort ProjectDir=$ProjectDir"

    $restartDelay = $RestartDelaySeconds
    while (-not (Test-StopRequested)) {
        if (-not (Test-Path -LiteralPath $StartScript -PathType Leaf)) {
            Write-ServiceLog "Missing start script: $StartScript. Retrying in $restartDelay seconds."
            if (Wait-ForStopRequest -Seconds $restartDelay) { break }
            $restartDelay = [Math]::Min($restartDelay * 2, $MaxBackoffSeconds)
            continue
        }

        $escapedStart = $StartScript.Replace('"', '""')
        $escapedNode = $NodePath.Replace('"', '""')
        $escapedStopRequest = $StopRequest.Replace('"', '""')
        $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$escapedStart`" -NodePath `"$escapedNode`" -AppPort $AppPort -Generation `"$Generation`" -WatchdogPid $PID -StopRequestPath `"$escapedStopRequest`""
        $proc = Start-Process `
            -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
            -ArgumentList $arguments `
            -WorkingDirectory $ProjectDir `
            -WindowStyle Hidden `
            -RedirectStandardOutput $ChildLog `
            -RedirectStandardError $ChildErr `
            -PassThru
        $childProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction SilentlyContinue
        $childCreationDate = ''
        if ($childProcess) { $childCreationDate = [string]$childProcess.CreationDate }
        Write-JsonFile -Path $ChildStateFile -Value ([ordered]@{
            Generation = $Generation
            Pid = $proc.Id
            CreationDate = $childCreationDate
            StartedAt = (Get-Date).ToUniversalTime().ToString('o')
        })
        Write-ServiceLog "start.ps1 launched. Generation=$Generation PID=$($proc.Id)"

        while (-not $proc.HasExited) {
            if (Test-StopRequested) {
                Complete-CooperativeChildStop -RootPid $proc.Id
                break
            }
            Start-Sleep -Milliseconds 500
            try { $proc.Refresh() } catch { break }
        }

        $exitCode = $null
        try { $exitCode = $proc.ExitCode } catch {}
        Clear-OwnedStateFile -Path $ChildStateFile
        Write-ServiceLog "start.ps1 exited. ExitCode=$exitCode"
        if (Test-StopRequested) { break }

        Write-ServiceLog "Restarting in $restartDelay seconds."
        if (Wait-ForStopRequest -Seconds $restartDelay) { break }
        $restartDelay = [Math]::Min($restartDelay * 2, $MaxBackoffSeconds)
    }
} catch {
    Write-ServiceLog "Watchdog failure: $($_.Exception.Message)"
    exit 1
} finally {
    Clear-OwnedStateFile -Path $ChildStateFile
    Clear-OwnedStateFile -Path $WatchdogStateFile
    Clear-MatchingStopRequest
    Write-ServiceLog "Watchdog exiting. Generation=$Generation"
}
