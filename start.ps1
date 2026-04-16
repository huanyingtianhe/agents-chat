# Start ACP Chat with tunnel (Dev Tunnel or Cloudflare)
# Usage: .\start.ps1              → uses Dev Tunnel (permanent URL)
#        .\start.ps1 -Cloudflare  → uses Cloudflare quick tunnel (random URL)
param([switch]$Cloudflare)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$AppId = "144243eb-8775-41e5-a57d-9bae004dbc7b"
$DevTunnelName = "acp-chat"
$DevTunnelUrl = "https://pghzvjm6-3000.asse.devtunnels.ms"

Write-Host "Building..." -ForegroundColor Cyan
Set-Location $ProjectDir
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
