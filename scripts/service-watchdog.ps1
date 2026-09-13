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
$StopFile = Join-Path $ProjectDir '.service-stop'
$WatchdogPidFile = Join-Path $ProjectDir '.service-watchdog.pid'
$ChildPidFile = Join-Path $ProjectDir '.service-child.pid'
$RestartDelaySeconds = 10
$MaxBackoffSeconds = 120
$GraceSeconds = 15

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-ServiceLog {
    param([string]$Message)
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" |
        Tee-Object -FilePath $LogFile -Append
}

function Get-ChildProcessIds {
    param([int]$ParentId)
    $result = @()
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
        $result += Get-ChildProcessIds -ParentId ([int]$child.ProcessId)
        $result += [int]$child.ProcessId
    }
    return $result
}

function Stop-OwnedProcessTree {
    param([int]$RootPid)
    if (-not (Get-Process -Id $RootPid -ErrorAction SilentlyContinue)) { return }

    $ownedPids = @(Get-ChildProcessIds -ParentId $RootPid)
    $ownedPids += $RootPid
    Write-ServiceLog "Requesting graceful stop of tracked child PID $RootPid."
    Stop-Process -Id $RootPid -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds($GraceSeconds)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $RootPid -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 250
    }
    if (-not (Get-Process -Id $RootPid -ErrorAction SilentlyContinue)) { return }

    Write-ServiceLog "Grace period expired; forcing only the tracked child tree rooted at PID $RootPid."
    foreach ($ownedPid in $ownedPids) {
        Stop-Process -Id $ownedPid -Force -ErrorAction SilentlyContinue
    }
}

try {
    [IO.File]::WriteAllText($WatchdogPidFile, [string]$PID)
    $env:PATH = "$(Split-Path -Parent $NodePath);$env:PATH"
    $env:AGENTS_CHAT_SERVICE = '1'
    Write-ServiceLog "Watchdog starting. PID=$PID NodePath=$NodePath AppPort=$AppPort ProjectDir=$ProjectDir"

    $restartDelay = $RestartDelaySeconds
    while (-not (Test-Path -LiteralPath $StopFile)) {
        if (-not (Test-Path -LiteralPath $StartScript -PathType Leaf)) {
            Write-ServiceLog "Missing start script: $StartScript. Retrying in $restartDelay seconds."
            Start-Sleep -Seconds $restartDelay
            $restartDelay = [Math]::Min($restartDelay * 2, $MaxBackoffSeconds)
            continue
        }

        $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`" -NodePath `"$NodePath`" -AppPort $AppPort"
        $proc = Start-Process `
            -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
            -ArgumentList $arguments `
            -WorkingDirectory $ProjectDir `
            -WindowStyle Hidden `
            -RedirectStandardOutput $ChildLog `
            -RedirectStandardError $ChildErr `
            -PassThru
        [IO.File]::WriteAllText($ChildPidFile, [string]$proc.Id)
        Write-ServiceLog "start.ps1 launched. PID=$($proc.Id)"

        while (-not $proc.HasExited) {
            if (Test-Path -LiteralPath $StopFile) {
                Stop-OwnedProcessTree -RootPid $proc.Id
                break
            }
            Start-Sleep -Seconds 2
            try { $proc.Refresh() } catch { break }
        }

        $exitCode = $null
        try { $exitCode = $proc.ExitCode } catch {}
        Remove-Item $ChildPidFile -Force -ErrorAction SilentlyContinue
        Write-ServiceLog "start.ps1 exited. ExitCode=$exitCode"
        if (Test-Path -LiteralPath $StopFile) { break }

        Write-ServiceLog "Restarting in $restartDelay seconds."
        Start-Sleep -Seconds $restartDelay
        $restartDelay = [Math]::Min($restartDelay * 2, $MaxBackoffSeconds)
    }
} catch {
    Write-ServiceLog "Watchdog failure: $($_.Exception.Message)"
    exit 1
} finally {
    Remove-Item $ChildPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $WatchdogPidFile -Force -ErrorAction SilentlyContinue
    Write-ServiceLog 'Watchdog exiting.'
}
