# Setup ACP Chat on a new device
# Usage: .\setup.ps1
# Prerequisites: Node.js 18+, Dev Tunnel CLI (winget install Microsoft.devtunnel), agency CLI
param(
    [string]$TunnelName = "acp-chat",
    [string]$AppId = "144243eb-8775-41e5-a57d-9bae004dbc7b"
)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot

Write-Host "=== ACP Chat Setup ===" -ForegroundColor Cyan
Write-Host ""

# ─── 1. Check prerequisites ───
Write-Host "[1/6] Checking prerequisites..." -ForegroundColor Cyan
$missing = @()
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $missing += "Node.js (https://nodejs.org)" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $missing += "npm" }
if (-not (Get-Command devtunnel -ErrorAction SilentlyContinue)) { $missing += "Dev Tunnel CLI (winget install Microsoft.devtunnel)" }
if ($missing.Count -gt 0) {
    Write-Host "Missing:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
$nodeVer = (node --version) -replace '^v', ''
Write-Host "  Node.js $nodeVer, npm $(npm --version), devtunnel OK" -ForegroundColor Green

# ─── 2. Install npm dependencies ───
Write-Host "[2/6] Installing dependencies..." -ForegroundColor Cyan
Set-Location $ProjectDir
npm install --loglevel=error
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }
Write-Host "  Done" -ForegroundColor Green

# ─── 3. Update agents.json cwd paths ───
Write-Host "[3/6] Checking agents.json..." -ForegroundColor Cyan
$agentsFile = Join-Path $ProjectDir "agents.json"
if (Test-Path $agentsFile) {
    $agentsData = Get-Content $agentsFile -Raw | ConvertFrom-Json
    $needsUpdate = $false
    foreach ($agent in $agentsData.agents) {
        if ($agent.cwd -and -not (Test-Path $agent.cwd)) {
            Write-Host "  WARNING: Agent '$($agent.id)' cwd not found: $($agent.cwd)" -ForegroundColor Yellow
            $newCwd = Read-Host "  Enter new cwd for '$($agent.id)' (or press Enter to skip)"
            if ($newCwd -and (Test-Path $newCwd)) {
                $agent.cwd = $newCwd
                $needsUpdate = $true
            } elseif ($newCwd) {
                Write-Host "  Path not found, skipping" -ForegroundColor Yellow
            }
        } else {
            Write-Host "  Agent '$($agent.id)' cwd OK: $($agent.cwd)" -ForegroundColor Green
        }
    }
    if ($needsUpdate) {
        $agentsData | ConvertTo-Json -Depth 5 | Set-Content $agentsFile -Encoding UTF8
        Write-Host "  agents.json updated" -ForegroundColor Green
    }
} else {
    Write-Host "  agents.json not found — create one manually" -ForegroundColor Yellow
}

# ─── 4. Set up Dev Tunnel ───
Write-Host "[4/6] Setting up Dev Tunnel..." -ForegroundColor Cyan
$loginCheck = devtunnel user show 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Logging in to Dev Tunnel..." -ForegroundColor Yellow
    devtunnel user login
    if ($LASTEXITCODE -ne 0) { Write-Host "Dev Tunnel login failed" -ForegroundColor Red; exit 1 }
}

# Check if tunnel already exists
$tunnelList = devtunnel list 2>&1 | Out-String
if ($tunnelList -match $TunnelName) {
    Write-Host "  Tunnel '$TunnelName' already exists" -ForegroundColor Green
} else {
    Write-Host "  Creating tunnel '$TunnelName'..." -ForegroundColor Yellow
    devtunnel create $TunnelName --allow-anonymous
    if ($LASTEXITCODE -ne 0) { Write-Host "Failed to create tunnel" -ForegroundColor Red; exit 1 }
    devtunnel port create $TunnelName --port-number 3000
    if ($LASTEXITCODE -ne 0) { Write-Host "Failed to create port" -ForegroundColor Red; exit 1 }
}

# Get tunnel URL
$tunnelShow = devtunnel show $TunnelName 2>&1 | Out-String
$tunnelUrlMatch = [regex]::Match($tunnelShow, 'https://[a-zA-Z0-9-]+\.devtunnels\.ms')
if ($tunnelUrlMatch.Success) {
    $tunnelUrl = $tunnelUrlMatch.Value
} else {
    # Fallback: ask user
    Write-Host "  Could not auto-detect tunnel URL." -ForegroundColor Yellow
    $tunnelUrl = Read-Host "  Paste your Dev Tunnel URL (e.g. https://xxxxx-3000.asse.devtunnels.ms)"
}
Write-Host "  Tunnel URL: $tunnelUrl" -ForegroundColor Green

# ─── 5. Update .env.local and start.ps1 ───
Write-Host "[5/6] Updating configuration..." -ForegroundColor Cyan

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
    Write-Host "  .env.local → NEXTAUTH_URL=$tunnelUrl" -ForegroundColor Green
} else {
    Write-Host "  WARNING: .env.local not found — create one with NEXTAUTH_SECRET, etc." -ForegroundColor Yellow
}

# Update start.ps1
$startFile = Join-Path $ProjectDir "start.ps1"
if (Test-Path $startFile) {
    $content = Get-Content $startFile -Raw
    $content = $content -replace '(\$DevTunnelUrl\s*=\s*")[^"]*(")', "`$1$tunnelUrl`$2"
    $content | Set-Content $startFile
    Write-Host "  start.ps1 → DevTunnelUrl=$tunnelUrl" -ForegroundColor Green
}

# ─── 6. Update Azure AD redirect (optional) ───
Write-Host "[6/6] Azure AD redirect URI..." -ForegroundColor Cyan
if (Get-Command az -ErrorAction SilentlyContinue) {
    $azAccount = az account show 2>&1
    if ($LASTEXITCODE -eq 0) {
        $bodyFile = "$env:TEMP\az-setup-update.json"
        $appObjId = (az ad app show --id $AppId --query "id" -o tsv 2>$null)
        if ($appObjId) {
            @{ publicClient = @{ redirectUris = @(
                "$tunnelUrl/api/auth/callback/azure-ad",
                "http://localhost:3000/api/auth/callback/azure-ad"
            ) } } | ConvertTo-Json -Depth 3 | Set-Content $bodyFile -Encoding UTF8
            az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$appObjId" --body "@$bodyFile" --headers "Content-Type=application/json" 2>$null
            if ($LASTEXITCODE -eq 0) { Write-Host "  Azure AD redirect updated" -ForegroundColor Green }
            else { Write-Host "  Warning: Failed to update Azure AD app" -ForegroundColor Yellow }
            Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue
        } else {
            Write-Host "  Skipped (app not found — run 'az login' first?)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  Skipped (not logged in to Azure CLI)" -ForegroundColor Yellow
    }
} else {
    Write-Host "  Skipped (Azure CLI not installed)" -ForegroundColor Yellow
}

# ─── Done ───
Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "To start:" -ForegroundColor White
Write-Host "  .\start.ps1" -ForegroundColor Yellow
Write-Host ""
Write-Host "Tunnel URL: $tunnelUrl" -ForegroundColor Cyan
