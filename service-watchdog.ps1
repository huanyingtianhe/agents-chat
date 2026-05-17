# Agents-Chat Windows Service Watchdog
# Runs under Windows Service Control Manager and keeps start.ps1 alive.

$ErrorActionPreference = 'Continue'

$ProjectDir = 'Q:\repos\Agents-Chat'
$StartScript = Join-Path $ProjectDir 'start.ps1'
$LogDir = Join-Path $ProjectDir 'logs'
$LogFile = Join-Path $LogDir 'service-watchdog.log'
$StopFile = Join-Path $ProjectDir '.service-stop'
$RestartDelaySeconds = 10
$MaxBackoffSeconds = 120

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-ServiceLog {
    param([string]$Message)
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$timestamp] $Message" | Tee-Object -FilePath $LogFile -Append
}

function Stop-Port3000Processes {
    try {
        $oldPids = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            Where-Object { $_ -and $_ -ne 0 }
        foreach ($p in $oldPids) {
            Write-ServiceLog "Stopping leftover process on port 3000: PID $p"
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-ServiceLog "Failed to inspect/stop port 3000 processes: $($_.Exception.Message)"
    }
}

function Stop-ProcessTree {
    param([int]$Pid)
    if (-not $Pid) { return }
    try {
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$Pid" -ErrorAction SilentlyContinue
        foreach ($child in $children) { Stop-ProcessTree -Pid ([int]$child.ProcessId) }
        Stop-Process -Id $Pid -Force -ErrorAction SilentlyContinue
    } catch {
        Write-ServiceLog "Failed to stop process tree at PID $Pid`: $($_.Exception.Message)"
    }
}

Write-ServiceLog 'Agents-Chat service watchdog starting...'
Write-ServiceLog "User: $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
Write-ServiceLog "ProjectDir: $ProjectDir"

$env:PATH = "C:\Program Files\nodejs;C:\Users\wulei\AppData\Local\Microsoft\WinGet\Links;$env:PATH"
$env:AGENTS_CHAT_SERVICE = '1'

$restartDelay = $RestartDelaySeconds
while (-not (Test-Path $StopFile)) {
    if (-not (Test-Path $ProjectDir)) {
        Write-ServiceLog "Project directory missing: $ProjectDir. Retrying in $restartDelay seconds."
        Start-Sleep -Seconds $restartDelay
        $restartDelay = [Math]::Min($restartDelay * 2, $MaxBackoffSeconds)
        continue
    }
    if (-not (Test-Path $StartScript)) {
        Write-ServiceLog "start.ps1 missing: $StartScript. Retrying in $restartDelay seconds."
        Start-Sleep -Seconds $restartDelay
        $restartDelay = [Math]::Min($restartDelay * 2, $MaxBackoffSeconds)
        continue
    }

    Stop-Port3000Processes
    Set-Location $ProjectDir
    Write-ServiceLog 'Launching start.ps1...'

    $childLog = Join-Path $LogDir 'start-service-child.log'
    $childErr = Join-Path $LogDir 'start-service-child.err.log'
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $StartScript)
    $proc = Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
        -ArgumentList $args `
        -WorkingDirectory $ProjectDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $childLog `
        -RedirectStandardError $childErr `
        -PassThru

    Write-ServiceLog "start.ps1 process launched. PID=$($proc.Id)"

    while (-not $proc.HasExited) {
        if (Test-Path $StopFile) {
            Write-ServiceLog 'Stop file detected; stopping child process tree.'
            Stop-ProcessTree -Pid $proc.Id
            break
        }
        Start-Sleep -Seconds 5
        try { $proc.Refresh() } catch { break }
    }

    $exitCode = $null
    try { $exitCode = $proc.ExitCode } catch { }
    Write-ServiceLog "start.ps1 process exited. ExitCode=$exitCode"

    if (Test-Path $StopFile) { break }

    Write-ServiceLog "Watchdog restarting in $restartDelay seconds..."
    Start-Sleep -Seconds $restartDelay
    $restartDelay = [Math]::Min($restartDelay * 2, $MaxBackoffSeconds)
}

Write-ServiceLog 'Agents-Chat service watchdog exiting.'
