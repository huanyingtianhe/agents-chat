# Pack ACP Chat for transfer to another device
# Usage: .\pack.ps1              → creates acp-chat.zip
#        .\pack.ps1 -NoHistory   → excludes chat history (.data/)
param([switch]$NoHistory)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$ZipName = "acp-chat.zip"
$ZipPath = Join-Path $ProjectDir $ZipName
$TempDir = Join-Path $env:TEMP "acp-chat-pack-$PID"

if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }

Write-Host "Packing ACP Chat..." -ForegroundColor Cyan

# Files/folders to include
$items = @(
    "app", "lib", "public",
    "agents.json", ".env.local",
    "package.json", "package-lock.json",
    "tsconfig.json", "next.config.ts", "next-env.d.ts",
    "middleware.ts", "start.ps1", "setup.ps1",
    "globals.css"
)
if (-not $NoHistory) { $items += ".data\chats.db" }

# Copy to temp staging dir
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
foreach ($item in $items) {
    $src = Join-Path $ProjectDir $item
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $TempDir $item
    if (Test-Path $src -PathType Container) {
        Copy-Item $src $dst -Recurse
    } else {
        Copy-Item $src $dst
    }
}

# Create zip
Compress-Archive -Path "$TempDir\*" -DestinationPath $ZipPath -Force
Remove-Item $TempDir -Recurse -Force

$size = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
Write-Host "Created: $ZipPath ($size MB)" -ForegroundColor Green
Write-Host ""
Write-Host "Transfer this zip to the new device, then run:" -ForegroundColor Yellow
Write-Host "  Expand-Archive acp-chat.zip -DestinationPath agents-chat" -ForegroundColor White
Write-Host "  cd agents-chat" -ForegroundColor White
Write-Host "  .\setup.ps1" -ForegroundColor White
