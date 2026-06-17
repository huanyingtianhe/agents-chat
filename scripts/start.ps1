# Start ACP Chat with tunnel (Dev Tunnel or Cloudflare) or just the local server
# Usage: .\start.ps1              → uses Dev Tunnel (permanent URL)
#        .\start.ps1 -Cloudflare  → uses Cloudflare quick tunnel (random URL)
#        .\start.ps1 -NoTunnel    → just start the local server (no tunnel, no Azure AD update)
param(
    [switch]$Cloudflare,
    [switch]$NoTunnel
)

if ($Cloudflare -and $NoTunnel) {
    Write-Host "-Cloudflare and -NoTunnel are mutually exclusive" -ForegroundColor Red
    exit 2
}

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectDir ".env.local"
$AppPort = 3000

function Read-DotEnvFile {
    param([Parameter(Mandatory=$true)][string]$Path)

    $values = @{}
    if (-not (Test-Path $Path)) {
        throw "Environment file not found: $Path"
    }

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

function Get-RequiredEnvValue {
    param(
        [Parameter(Mandatory=$true)][hashtable]$Values,
        [Parameter(Mandatory=$true)][string]$Name
    )

    if (-not $Values.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($Values[$Name])) {
        throw "Missing required value '$Name' in $EnvFile"
    }

    return $Values[$Name]
}

$DotEnv = Read-DotEnvFile -Path $EnvFile
if ($NoTunnel) {
    $AppId = $null
    $DevTunnelName = $null
    $DevTunnelUrl = $null
} else {
    $AppId = Get-RequiredEnvValue -Values $DotEnv -Name "AZURE_AD_CLIENT_ID"
    $DevTunnelName = Get-RequiredEnvValue -Values $DotEnv -Name "DEV_TUNNEL_NAME"
    $DevTunnelUrl = Get-RequiredEnvValue -Values $DotEnv -Name "DEV_TUNNEL_URL"
}

Write-Host "[$ProjectDir] Cleaning .next cache..." -ForegroundColor Cyan
Set-Location $ProjectDir
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue

Write-Host "[$ProjectDir] Building..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed" -ForegroundColor Red; exit 1 }

if ($NoTunnel) {
    Write-Host "No tunnel mode: serving on http://localhost:$AppPort only" -ForegroundColor Cyan
    $tunnelUrl = "http://localhost:$AppPort"
} elseif ($Cloudflare) {
    # --- Cloudflare quick tunnel (random URL each time) ---
    Write-Host "Starting Cloudflare tunnel..." -ForegroundColor Cyan
    $tunnelLog = "$env:TEMP\cloudflared-$PID.log"
    $tunnel = Start-Process -FilePath "C:\Program Files (x86)\cloudflared\cloudflared.exe" `
        -ArgumentList "tunnel --url http://localhost:$AppPort" `
        -PassThru -NoNewWindow -RedirectStandardError $tunnelLog

    $tunnelUrl = $null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Path $tunnelLog) {
            $match = Select-String -Path $tunnelLog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
            if ($match) { $tunnelUrl = $match.Matches[0].Value; break }
        }
    }
    if (-not $tunnelUrl) {
        Write-Host "Failed to get tunnel URL" -ForegroundColor Red
        Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
        exit 1
    }
    Write-Host "Tunnel: $tunnelUrl" -ForegroundColor Green

    # Update .env.local
    $envFile = Join-Path $ProjectDir ".env.local"
    if (Test-Path $envFile) {
        $lines = Get-Content $envFile
        $hasNextAuthUrl = [bool]($lines | Where-Object { $_ -match "^\s*#?\s*NEXTAUTH_URL\b" } | Select-Object -First 1)
        $lines = $lines | ForEach-Object {
            if ($_ -match "^\s*#?\s*NEXTAUTH_URL\b") { "NEXTAUTH_URL=$tunnelUrl" } else { $_ }
        }
        if (-not $hasNextAuthUrl) { $lines += "NEXTAUTH_URL=$tunnelUrl" }
        $lines | Set-Content $envFile
    }

    # Update Azure AD redirect URIs (publicClient platform)
    Write-Host "Updating Azure AD app redirect URIs..." -ForegroundColor Cyan
    $appObjId = (az ad app show --id $AppId --query "id" -o tsv 2>$null)
    if ($appObjId) {
        $bodyFile = "$env:TEMP\az-publicclient-update.json"
        @{ publicClient = @{ redirectUris = @("$tunnelUrl/api/auth/callback/azure-ad", "http://localhost:$AppPort/api/auth/callback/azure-ad") } } |
            ConvertTo-Json -Depth 3 | Set-Content $bodyFile -Encoding UTF8
        az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$appObjId" --body "@$bodyFile" --headers "Content-Type=application/json" 2>$null
        if ($LASTEXITCODE -eq 0) { Write-Host "Azure AD redirect updated" -ForegroundColor Green }
        else { Write-Host "Warning: Failed to update Azure AD app" -ForegroundColor Yellow }
        Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "Warning: Failed to get app (run 'az login' first?)" -ForegroundColor Yellow
    }
} else {
    # --- Dev Tunnel (permanent URL) ---
    $tunnelUrl = $DevTunnelUrl

    # Ensure .env.local has the permanent URL
    $envFile = Join-Path $ProjectDir ".env.local"
    if (Test-Path $envFile) {
        $lines = Get-Content $envFile
        $hasNextAuthUrl = [bool]($lines | Where-Object { $_ -match "^\s*#?\s*NEXTAUTH_URL\b" } | Select-Object -First 1)
        $lines = $lines | ForEach-Object {
            if ($_ -match "^\s*#?\s*NEXTAUTH_URL\b") { "NEXTAUTH_URL=$tunnelUrl" } else { $_ }
        }
        if (-not $hasNextAuthUrl) { $lines += "NEXTAUTH_URL=$tunnelUrl" }
        $lines | Set-Content $envFile
    }
}

# Kill any existing server on the supervised app port
$oldPids = Get-NetTCPConnection -LocalPort $AppPort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -ne 0 }
foreach ($p in $oldPids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
if ($oldPids) { Write-Host "Killed old server on port $AppPort" -ForegroundColor Yellow; Start-Sleep -Seconds 1 }

# Logging defaults for pino + pino-roll (override via .env.local if needed)
if (-not $env:LOG_LEVEL)            { $env:LOG_LEVEL = "info" }
if (-not $env:LOG_DIR)              { $env:LOG_DIR = Join-Path $ProjectDir "logs" }
if (-not $env:LOG_FILE)             { $env:LOG_FILE = "app.log" }
if (-not $env:LOG_ROTATE_FREQUENCY) { $env:LOG_ROTATE_FREQUENCY = "daily" }
if (-not $env:LOG_ROTATE_SIZE)      { $env:LOG_ROTATE_SIZE = "10m" }
if (-not $env:LOG_RETENTION)        { $env:LOG_RETENTION = "7" }
New-Item -ItemType Directory -Force -Path $env:LOG_DIR | Out-Null
Write-Host "Logs -> $($env:LOG_DIR)\$($env:LOG_FILE) (level=$($env:LOG_LEVEL), rotate=$($env:LOG_ROTATE_FREQUENCY)/$($env:LOG_ROTATE_SIZE), keep=$($env:LOG_RETENTION))" -ForegroundColor DarkGray

Write-Host "Starting Next.js server on port $AppPort..." -ForegroundColor Cyan
$serverOut = Join-Path $env:LOG_DIR "server.log"
$serverErr = Join-Path $env:LOG_DIR "server-error.log"
$nextStartCommand = "npx next start --port $AppPort"
$server = Start-Process -FilePath "cmd.exe" -ArgumentList "/c $nextStartCommand" -WorkingDirectory $ProjectDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr
Start-Sleep -Seconds 2

if (-not $Cloudflare -and -not $NoTunnel) {
    Write-Host "Starting Dev Tunnel ($DevTunnelName)..." -ForegroundColor Cyan
    $tunnel = Start-Process -FilePath "devtunnel" -ArgumentList "host $DevTunnelName" -PassThru -NoNewWindow
    Start-Sleep -Seconds 3
}

Write-Host "`nReady! $tunnelUrl" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop`n" -ForegroundColor DarkGray

$healthCheckUrl = "http://localhost:$AppPort/api/auth/providers"
$tunnelHealthCheckUrl = $null
if (-not $NoTunnel) {
    $tunnelHealthCheckUrl = "$($tunnelUrl.TrimEnd('/'))/api/auth/providers"
    Write-Host "Public tunnel health check: $tunnelHealthCheckUrl" -ForegroundColor DarkGray
}
$healthFailures = 0
$tunnelHealthFailures = 0
$maxHealthFailures = 3
$maxTunnelHealthFailures = 3
$exitCode = 0

# Wait for the server to respond before entering the monitoring loop
Write-Host "Waiting for server to become ready at $healthCheckUrl..." -ForegroundColor Cyan
$startupDeadline = (Get-Date).AddSeconds(60)
$startupReady = $false
while ((Get-Date) -lt $startupDeadline) {
    try { $server.Refresh() } catch {}
    if ($server.HasExited) {
        Write-Host "Next.js server exited during startup (code $($server.ExitCode))." -ForegroundColor Red
        $exitCode = 1
        break
    }
    try {
        $r = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) {
            Write-Host "Server is ready." -ForegroundColor Green
            $startupReady = $true
            break
        }
    } catch { }
    Start-Sleep -Seconds 3
}

if (-not $startupReady -and $exitCode -eq 0) {
    Write-Host "Server did not become ready within 60 seconds; exiting." -ForegroundColor Red
    $exitCode = 1
}

try {
    while ($exitCode -eq 0) {
        Start-Sleep -Seconds 10

        try { $server.Refresh() } catch {}
        if ($server.HasExited) {
            Write-Host "Next.js server exited unexpectedly with code $($server.ExitCode)." -ForegroundColor Red
            $exitCode = 1
            break
        }

        if ($tunnel) {
            try { $tunnel.Refresh() } catch {}
            if ($tunnel.HasExited) {
                Write-Host "Tunnel exited unexpectedly with code $($tunnel.ExitCode)." -ForegroundColor Red
                $exitCode = 1
                break
            }
        }

        try {
            $response = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                $healthFailures = 0
            } else {
                $healthFailures++
                Write-Host "Health check failed: $healthCheckUrl returned HTTP $($response.StatusCode) ($healthFailures/$maxHealthFailures)." -ForegroundColor Yellow
            }
        } catch {
            $healthFailures++
            Write-Host "Health check failed: $healthCheckUrl did not respond ($healthFailures/$maxHealthFailures). $($_.Exception.Message)" -ForegroundColor Yellow
        }

        if ($healthFailures -ge $maxHealthFailures) {
            Write-Host "Health check failed $healthFailures times; exiting so service-watchdog.ps1 can restart the app." -ForegroundColor Red
            $exitCode = 1
            break
        }

        if ($tunnelHealthCheckUrl) {
            try {
                $tunnelResponse = Invoke-WebRequest -Uri $tunnelHealthCheckUrl -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 5 -ErrorAction Stop
                if ($tunnelResponse.StatusCode -ge 200 -and $tunnelResponse.StatusCode -lt 400) {
                    if ($tunnelHealthFailures -gt 0) {
                        Write-Host "Tunnel health check recovered: $tunnelHealthCheckUrl returned HTTP $($tunnelResponse.StatusCode)." -ForegroundColor Green
                    }
                    $tunnelHealthFailures = 0
                } else {
                    $tunnelHealthFailures++
                    Write-Host "Tunnel health check failed: $tunnelHealthCheckUrl returned HTTP $($tunnelResponse.StatusCode) ($tunnelHealthFailures/$maxTunnelHealthFailures)." -ForegroundColor Yellow
                }
            } catch {
                $statusCode = $null
                if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
                    $statusCode = [int]$_.Exception.Response.StatusCode
                }

                if ($statusCode -and $statusCode -ge 200 -and $statusCode -lt 400) {
                    if ($tunnelHealthFailures -gt 0) {
                        Write-Host "Tunnel health check recovered: $tunnelHealthCheckUrl returned HTTP $statusCode." -ForegroundColor Green
                    }
                    $tunnelHealthFailures = 0
                } elseif ($statusCode) {
                    $tunnelHealthFailures++
                    Write-Host "Tunnel health check failed: $tunnelHealthCheckUrl returned HTTP $statusCode ($tunnelHealthFailures/$maxTunnelHealthFailures)." -ForegroundColor Yellow
                } else {
                    $tunnelHealthFailures++
                    Write-Host "Tunnel health check failed: $tunnelHealthCheckUrl did not respond ($tunnelHealthFailures/$maxTunnelHealthFailures). $($_.Exception.Message)" -ForegroundColor Yellow
                }
            }

            if ($tunnelHealthFailures -ge $maxTunnelHealthFailures) {
                Write-Host "Tunnel health check failed $tunnelHealthFailures times; exiting so service-watchdog.ps1 can restart the app and dev tunnel." -ForegroundColor Red
                $exitCode = 1
                break
            }
        }
    }
} catch {
    Write-Host "Supervisor loop failed: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    # Cleanup
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    $pids = Get-NetTCPConnection -LocalPort $AppPort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    if ($Cloudflare) { Remove-Item "$env:TEMP\cloudflared-$PID.log" -Force -ErrorAction SilentlyContinue }
    Write-Host "Stopped." -ForegroundColor Yellow
}

exit $exitCode
