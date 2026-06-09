# Tunnel Watchdog - monitors Dev Tunnel health and restarts if unresponsive
# Usage: .\tunnel-watchdog.ps1
#   Starts the dev tunnel and monitors it every 60 seconds.
#   If the tunnel fails 3 consecutive health checks, it restarts automatically.

param(
    [int]$CheckIntervalSeconds = 60,
    [int]$MaxFailures = 3,
    [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectDir ".env.local"

# Read tunnel config from .env.local
function Read-DotEnvFile {
    param([string]$Path)
    $values = @{}
    if (-not (Test-Path $Path)) { throw "Environment file not found: $Path" }
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $parts = $line -split "=", 2
        if ($parts.Count -ne 2) { return }
        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$key] = $value
    }
    return $values
}

$DotEnv = Read-DotEnvFile -Path $EnvFile
$TunnelName = $DotEnv["DEV_TUNNEL_NAME"]
$TunnelUrl = $DotEnv["DEV_TUNNEL_URL"]

if (-not $TunnelName -or -not $TunnelUrl) {
    Write-Host "ERROR: DEV_TUNNEL_NAME and DEV_TUNNEL_URL must be set in .env.local" -ForegroundColor Red
    exit 1
}

Write-Host "Tunnel Watchdog Started" -ForegroundColor Cyan
Write-Host "  Tunnel:   $TunnelName" -ForegroundColor Gray
Write-Host "  URL:      $TunnelUrl" -ForegroundColor Gray
Write-Host "  Interval: ${CheckIntervalSeconds}s | Max failures: $MaxFailures" -ForegroundColor Gray
Write-Host ""

$tunnelProcess = $null
$consecutiveFailures = 0

function Start-Tunnel {
    # Kill any existing devtunnel host processes
    Get-Process -Name "devtunnel" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  Killing existing devtunnel process (PID $($_.Id))..." -ForegroundColor Yellow
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2

    Write-Host "$(Get-Date -Format 'HH:mm:ss') Starting tunnel ($TunnelName)..." -ForegroundColor Cyan
    $proc = Start-Process -FilePath "devtunnel" -ArgumentList "host $TunnelName" -PassThru -NoNewWindow
    Start-Sleep -Seconds 5
    return $proc
}

function Test-TunnelHealth {
    try {
        $response = Invoke-WebRequest -Uri $TunnelUrl -TimeoutSec $TimeoutSeconds -UseBasicParsing -MaximumRedirection 5 -ErrorAction Stop
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    } catch {
        # A 4xx from the app (e.g., 401 auth redirect) still means tunnel is working
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $code = [int]$_.Exception.Response.StatusCode
            return ($code -ge 200 -and $code -lt 500)
        }
        return $false
    }
}

# Initial start
$tunnelProcess = Start-Tunnel

Write-Host "$(Get-Date -Format 'HH:mm:ss') Watchdog monitoring active. Press Ctrl+C to stop.`n" -ForegroundColor Green

try {
    while ($true) {
        Start-Sleep -Seconds $CheckIntervalSeconds

        # Check if process is still alive
        if ($tunnelProcess.HasExited) {
            Write-Host "$(Get-Date -Format 'HH:mm:ss') [WARN] Tunnel process exited (code $($tunnelProcess.ExitCode)). Restarting..." -ForegroundColor Yellow
            $tunnelProcess = Start-Tunnel
            $consecutiveFailures = 0
            continue
        }

        # Health check via HTTP
        $healthy = Test-TunnelHealth
        if ($healthy) {
            if ($consecutiveFailures -gt 0) {
                Write-Host "$(Get-Date -Format 'HH:mm:ss') [OK] Tunnel recovered." -ForegroundColor Green
            }
            $consecutiveFailures = 0
        } else {
            $consecutiveFailures++
            Write-Host "$(Get-Date -Format 'HH:mm:ss') [WARN] Health check failed ($consecutiveFailures/$MaxFailures)" -ForegroundColor Yellow

            if ($consecutiveFailures -ge $MaxFailures) {
                Write-Host "$(Get-Date -Format 'HH:mm:ss') [ACTION] Restarting tunnel after $MaxFailures consecutive failures..." -ForegroundColor Red
                Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
                $tunnelProcess = Start-Tunnel
                $consecutiveFailures = 0
            }
        }
    }
} finally {
    Write-Host "`nStopping tunnel..." -ForegroundColor Yellow
    if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
        Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Watchdog stopped." -ForegroundColor Yellow
}
