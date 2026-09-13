# Start an existing guarded Agents-Chat production build.

param(
    [switch]$Cloudflare,
    [switch]$NoTunnel,
    [string]$NodePath,
    [int]$AppPort = 3000,
    [string]$Generation,
    [int]$WatchdogPid = 0,
    [string]$StopRequestPath
)

$ErrorActionPreference = 'Stop'
if ($Cloudflare -and $NoTunnel) {
    throw '-Cloudflare and -NoTunnel are mutually exclusive.'
}

$ProjectDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectDir '.env.local'
$Preflight = Join-Path $PSScriptRoot 'runtime-preflight.mjs'
$ServerLauncher = Join-Path $PSScriptRoot 'start-server.mjs'
$BuildId = Join-Path $ProjectDir '.next\BUILD_ID'
$LogDir = Join-Path $ProjectDir 'logs'
$server = $null
$tunnel = $null

function Read-DotEnvFile {
    param([string]$Path)
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#')) { return }
        $parts = $line -split '=', 2
        if ($parts.Count -ne 2) { return }
        $value = $parts[1].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$parts[0].Trim()] = $value
    }
    return $values
}

function Get-RequiredEnvValue {
    param([hashtable]$Values, [string]$Name)
    if (-not $Values.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($Values[$Name])) {
        throw "Missing required value '$Name' in $EnvFile"
    }
    return $Values[$Name]
}

function Set-NextAuthUrl {
    param([string]$Url)
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { return }
    $lines = @(Get-Content -LiteralPath $EnvFile)
    $found = $false
    $updated = @($lines | ForEach-Object {
        if ($_ -match '^\s*#?\s*NEXTAUTH_URL\b') {
            $found = $true
            "NEXTAUTH_URL=$Url"
        } else {
            $_
        }
    })
    if (-not $found) { $updated += "NEXTAUTH_URL=$Url" }
    $updated | Set-Content -LiteralPath $EnvFile
}

function Stop-TrackedProcess {
    param($Process, [string]$Name)
    if (-not $Process) { return }
    try { $Process.Refresh() } catch { return }
    if ($Process.HasExited) { return }
    Write-Host "Stopping tracked $Name process PID $($Process.Id)..." -ForegroundColor Yellow
    Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
    if (-not $Process.WaitForExit(10000)) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
}

function Test-StopRequested {
    if ([string]::IsNullOrWhiteSpace($Generation) -or $WatchdogPid -le 0 -or
        [string]::IsNullOrWhiteSpace($StopRequestPath) -or
        -not (Test-Path -LiteralPath $StopRequestPath -PathType Leaf)) {
        return $false
    }
    try {
        $request = (Get-Content -LiteralPath $StopRequestPath -Raw) | ConvertFrom-Json
        return (
            [string]$request.Generation -eq $Generation -and
            [int]$request.WatchdogPid -eq $WatchdogPid
        )
    } catch {
        return $false
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

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js was not found. Install or activate Node.js 24.' }
    $NodePath = (& $nodeCommand.Source -p 'process.execPath').Trim()
}
if (-not [IO.Path]::IsPathRooted($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "NodePath must be an existing absolute Node.js 24 executable path: $NodePath"
}
$nodeMajor = (& $NodePath -p "process.versions.node.split('.')[0]").Trim()
if ($LASTEXITCODE -ne 0 -or $nodeMajor -ne '24') {
    throw "NodePath must run Node.js 24: $NodePath"
}
if (-not (Test-Path -LiteralPath $BuildId -PathType Leaf)) {
    throw "Production build is missing ($BuildId). Run .\scripts\deploy.ps1 from an elevated PowerShell session."
}
if ($AppPort -lt 1 -or $AppPort -gt 65535) {
    throw "AppPort must be between 1 and 65535."
}

Set-Location $ProjectDir
& $NodePath $Preflight check-only --project-root $ProjectDir --manager windows
if ($LASTEXITCODE -ne 0) {
    throw "Runtime/storage check-only failed under Node executable: $NodePath"
}

$DotEnv = Read-DotEnvFile -Path $EnvFile
$exitCode = 0
try {
    if ($NoTunnel) {
        $tunnelUrl = "http://localhost:$AppPort"
    } elseif ($Cloudflare) {
        $AppId = Get-RequiredEnvValue -Values $DotEnv -Name 'AZURE_AD_CLIENT_ID'
        $tunnelLog = Join-Path $LogDir "cloudflared-$PID.log"
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
        $tunnel = Start-Process -FilePath 'C:\Program Files (x86)\cloudflared\cloudflared.exe' `
            -ArgumentList "tunnel --url http://localhost:$AppPort" `
            -PassThru -NoNewWindow -RedirectStandardError $tunnelLog
        $tunnelUrl = $null
        for ($i = 0; $i -lt 30; $i++) {
            if (Wait-ForStopRequest -Seconds 1) { return }
            $match = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($match) { $tunnelUrl = $match.Matches[0].Value; break }
        }
        if (-not $tunnelUrl) { throw "Failed to obtain a Cloudflare tunnel URL. Log: $tunnelLog" }
        Write-Host "Cloudflare tunnel: $tunnelUrl" -ForegroundColor Green
        Set-NextAuthUrl -Url $tunnelUrl
        $appObjectId = (& az ad app show --id $AppId --query id -o tsv 2>$null)
        if ($LASTEXITCODE -eq 0 -and $appObjectId) {
            $azureBody = Join-Path $LogDir "az-publicclient-update-$PID.json"
            @{
                publicClient = @{
                    redirectUris = @(
                        "$tunnelUrl/api/auth/callback/azure-ad",
                        "http://localhost:$AppPort/api/auth/callback/azure-ad"
                    )
                }
            } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $azureBody -Encoding UTF8
            & az rest --method PATCH `
                --url "https://graph.microsoft.com/v1.0/applications/$appObjectId" `
                --body "@$azureBody" `
                --headers 'Content-Type=application/json' 2>$null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "Azure AD redirect update failed. Run 'az login' and restart." -ForegroundColor Yellow
            }
            Remove-Item -LiteralPath $azureBody -Force -ErrorAction SilentlyContinue
        } else {
            Write-Host "Azure AD application lookup failed. Run 'az login' and restart." -ForegroundColor Yellow
        }
    } else {
        $DevTunnelName = Get-RequiredEnvValue -Values $DotEnv -Name 'DEV_TUNNEL_NAME'
        $tunnelUrl = Get-RequiredEnvValue -Values $DotEnv -Name 'DEV_TUNNEL_URL'
        Set-NextAuthUrl -Url $tunnelUrl
    }

    if (Test-StopRequested) { return }
    if (-not $env:LOG_LEVEL) { $env:LOG_LEVEL = 'info' }
    if (-not $env:LOG_DIR) { $env:LOG_DIR = $LogDir }
    if (-not $env:LOG_FILE) { $env:LOG_FILE = 'app.log' }
    if (-not $env:LOG_ROTATE_FREQUENCY) { $env:LOG_ROTATE_FREQUENCY = 'daily' }
    if (-not $env:LOG_ROTATE_SIZE) { $env:LOG_ROTATE_SIZE = '10m' }
    if (-not $env:LOG_RETENTION) { $env:LOG_RETENTION = '7' }
    New-Item -ItemType Directory -Force -Path $env:LOG_DIR | Out-Null
    $serverOut = Join-Path $env:LOG_DIR 'server.log'
    $serverErr = Join-Path $env:LOG_DIR 'server-error.log'
    $serverArguments = "`"$ServerLauncher`" --port $AppPort"
    $server = Start-Process -FilePath $NodePath `
        -ArgumentList $serverArguments `
        -WorkingDirectory $ProjectDir `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $serverOut `
        -RedirectStandardError $serverErr

    if (-not $Cloudflare -and -not $NoTunnel) {
        $tunnel = Start-Process -FilePath 'devtunnel' `
            -ArgumentList @('host', $DevTunnelName) `
            -PassThru -NoNewWindow
    }

    $healthCheckUrl = "http://localhost:$AppPort/api/health/storage"
    $tunnelHealthCheckUrl = $null
    if (-not $NoTunnel) { $tunnelHealthCheckUrl = "$($tunnelUrl.TrimEnd('/'))/api/health/storage" }
    $healthFailures = 0
    $tunnelHealthFailures = 0
    $maxHealthFailures = 3
    $maxTunnelHealthFailures = 3

    Write-Host "Waiting for server to become ready at $healthCheckUrl..." -ForegroundColor Cyan
    $startupDeadline = (Get-Date).AddSeconds(60)
    $startupReady = $false
    while ((Get-Date) -lt $startupDeadline) {
        if (Test-StopRequested) { return }
        $server.Refresh()
        if ($server.HasExited) { $exitCode = 1; break }
        try {
            $response = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                $startupReady = $true
                break
            }
        } catch {}
        if (Wait-ForStopRequest -Seconds 3) { return }
    }
    if (-not $startupReady -and $exitCode -eq 0) { $exitCode = 1 }

    while ($exitCode -eq 0) {
        if (Wait-ForStopRequest -Seconds 10) { break }
        $server.Refresh()
        if ($server.HasExited) { $exitCode = 1; break }
        if ($tunnel) {
            $tunnel.Refresh()
            if ($tunnel.HasExited) { $exitCode = 1; break }
        }
        try {
            $response = Invoke-WebRequest -Uri $healthCheckUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                $healthFailures = 0
            } else {
                $healthFailures++
            }
        } catch {
            $healthFailures++
            Write-Host "Health check failed: $healthCheckUrl ($healthFailures/$maxHealthFailures)." -ForegroundColor Yellow
        }
        if ($healthFailures -ge $maxHealthFailures) { $exitCode = 1; break }

        if ($tunnelHealthCheckUrl) {
            try {
                $response = Invoke-WebRequest -Uri $tunnelHealthCheckUrl -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 5 -ErrorAction Stop
                if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                    $tunnelHealthFailures = 0
                } else {
                    $tunnelHealthFailures++
                }
            } catch {
                $tunnelHealthFailures++
                Write-Host "Tunnel health check failed: $tunnelHealthCheckUrl ($tunnelHealthFailures/$maxTunnelHealthFailures)." -ForegroundColor Yellow
            }
            if ($tunnelHealthFailures -ge $maxTunnelHealthFailures) { $exitCode = 1; break }
        }
    }
} finally {
    Stop-TrackedProcess -Process $tunnel -Name 'tunnel'
    Stop-TrackedProcess -Process $server -Name 'server'
}

if ($exitCode -ne 0) {
    Write-Host "Managed process became unhealthy. Logs: $serverOut ; $serverErr" -ForegroundColor Red
}
exit $exitCode
