# Start ACP Chat with tunnel (Dev Tunnel or Cloudflare)
# Usage: .\start.ps1              → uses Dev Tunnel (permanent URL)
#        .\start.ps1 -Cloudflare  → uses Cloudflare quick tunnel (random URL)
param([switch]$Cloudflare)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$EnvFile = Join-Path $ProjectDir ".env.local"

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
$AppId = Get-RequiredEnvValue -Values $DotEnv -Name "AZURE_AD_CLIENT_ID"
$DevTunnelName = Get-RequiredEnvValue -Values $DotEnv -Name "DEV_TUNNEL_NAME"
$DevTunnelUrl = Get-RequiredEnvValue -Values $DotEnv -Name "DEV_TUNNEL_URL"

Write-Host "[$ProjectDir] Cleaning .next cache..." -ForegroundColor Cyan
Set-Location $ProjectDir
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue

Write-Host "[$ProjectDir] Building..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed" -ForegroundColor Red; exit 1 }

if ($Cloudflare) {
    # --- Cloudflare quick tunnel (random URL each time) ---
    Write-Host "Starting Cloudflare tunnel..." -ForegroundColor Cyan
    $tunnelLog = "$env:TEMP\cloudflared-$PID.log"
    $tunnel = Start-Process -FilePath "C:\Program Files (x86)\cloudflared\cloudflared.exe" `
        -ArgumentList "tunnel --url http://localhost:3000" `
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
        $found = $false
        $lines = $lines | ForEach-Object {
            if ($_ -match "^\s*#?\s*NEXTAUTH_URL\b") { $found = $true; "NEXTAUTH_URL=$tunnelUrl" } else { $_ }
        }
        if (-not $found) { $lines += "NEXTAUTH_URL=$tunnelUrl" }
        $lines | Set-Content $envFile
    }

    # Update Azure AD redirect URIs (publicClient platform)
    Write-Host "Updating Azure AD app redirect URIs..." -ForegroundColor Cyan
    $appObjId = (az ad app show --id $AppId --query "id" -o tsv 2>$null)
    if ($appObjId) {
        $bodyFile = "$env:TEMP\az-publicclient-update.json"
        @{ publicClient = @{ redirectUris = @("$tunnelUrl/api/auth/callback/azure-ad", "http://localhost:3000/api/auth/callback/azure-ad") } } |
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
        $found = $false
        $lines = $lines | ForEach-Object {
            if ($_ -match "^\s*#?\s*NEXTAUTH_URL\b") { $found = $true; "NEXTAUTH_URL=$tunnelUrl" } else { $_ }
        }
        if (-not $found) { $lines += "NEXTAUTH_URL=$tunnelUrl" }
        $lines | Set-Content $envFile
    }
}

# Kill any existing server on port 3000
$oldPids = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -ne 0 }
foreach ($p in $oldPids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
if ($oldPids) { Write-Host "Killed old server on port 3000" -ForegroundColor Yellow; Start-Sleep -Seconds 1 }

Write-Host "Starting Next.js server..." -ForegroundColor Cyan
$server = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" -WorkingDirectory $ProjectDir -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

if (-not $Cloudflare) {
    Write-Host "Starting Dev Tunnel ($DevTunnelName)..." -ForegroundColor Cyan
    $tunnel = Start-Process -FilePath "devtunnel" -ArgumentList "host $DevTunnelName" -PassThru -NoNewWindow
    Start-Sleep -Seconds 3
}

Write-Host "`nReady! $tunnelUrl" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop`n" -ForegroundColor DarkGray

try { $tunnel.WaitForExit() } catch {}

# Cleanup
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
$pids = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
if ($Cloudflare) { Remove-Item "$env:TEMP\cloudflared-$PID.log" -Force -ErrorAction SilentlyContinue }
Write-Host "Stopped." -ForegroundColor Yellow
