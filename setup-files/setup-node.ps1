# Copilot ACP + Azure Relay Setup Script
# Starts Copilot ACP and a relay listener to expose it via Azure Relay
# No devtunnel needed — uses Azure Relay Hybrid Connections

param(
    [int]$Port = 0,
    [int]$CheckInterval = 5,
    [string]$RelayConnectionString = $env:RELAY_CONNECTION_STRING,
    [string]$ConnectionName = $env:COMPUTERNAME.ToLower(),
    [string]$KeyVaultName = "agents-chat-kv",
    [string]$SecretName = "relay-connection-string",
    [switch]$RegisterStartup,
    [switch]$UnregisterStartup
)

$TaskName = "AgentsChatNode"

# ─── Register/unregister as a scheduled task that starts on login ───
if ($RegisterStartup) {
    $scriptPath = $MyInvocation.MyCommand.Path
    if (-not $scriptPath) { $scriptPath = Join-Path (Get-Location) "setup-node.ps1" }
    $argList = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
    if ($RelayConnectionString) { $argList += " -RelayConnectionString `"$RelayConnectionString`"" }
    if ($ConnectionName -ne $env:COMPUTERNAME.ToLower()) { $argList += " -ConnectionName `"$ConnectionName`"" }

    $action = New-ScheduledTaskAction -Execute "pwsh.exe" -Argument $argList -WorkingDirectory (Split-Path $scriptPath)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
    Write-Host "Registered scheduled task '$TaskName' to start on login." -ForegroundColor Green
    Write-Host "  Script: $scriptPath" -ForegroundColor Gray
    Write-Host "  To remove: .\setup-node.ps1 -UnregisterStartup" -ForegroundColor Gray
    exit 0
}

if ($UnregisterStartup) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    exit 0
}

# If no connection string provided, fetch from Azure Key Vault
if (-not $RelayConnectionString) {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        Write-Error "Azure CLI is required to fetch the relay connection string from Key Vault. Install it and run 'az login'."
        exit 1
    }
    Write-Host "Fetching relay connection string from Key Vault '$KeyVaultName'..." -ForegroundColor Yellow
    $RelayConnectionString = az keyvault secret show --vault-name $KeyVaultName --name $SecretName --query "value" -o tsv 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $RelayConnectionString) {
        Write-Error "Failed to fetch secret '$SecretName' from Key Vault '$KeyVaultName'. Ensure you are logged in with 'az login' and have access."
        exit 1
    }
    Write-Host "  Connection string retrieved from Key Vault." -ForegroundColor Green
}

# Test if a port is in use (pure .NET — no WMI/CIM, works everywhere)
function Test-PortInUse([int]$Port) {
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        $listener.Stop()
        return $false
    } catch {
        return $true
    }
}

# Auto-select an available port
function Find-AvailablePort {
    param([int]$StartPort = 3000, [int]$EndPort = 3100)
    for ($p = $StartPort; $p -le $EndPort; $p++) {
        if (-not (Test-PortInUse $p)) { return $p }
    }
    Write-Error "No available port found in range $StartPort-$EndPort"
    exit 1
}

if ($Port -eq 0) {
    $Port = Find-AvailablePort
    Write-Host "Auto-selected port: $Port" -ForegroundColor Green
} elseif (Test-PortInUse $Port) {
    Write-Host "Port $Port is in use, finding an available port..." -ForegroundColor Yellow
    $Port = Find-AvailablePort -StartPort $Port
    Write-Host "Using port: $Port" -ForegroundColor Green
}

Write-Host "=== Copilot ACP + Azure Relay Setup ===" -ForegroundColor Cyan
Write-Host "Connection Name: $ConnectionName"
Write-Host "ACP Port:        $Port"
Write-Host ""

# Step 1: Kill whatever is listening on the copilot port (use netstat — no WMI)
$portPid = (netstat -ano 2>$null | Select-String "127\.0\.0\.1:$Port\s" | ForEach-Object {
    ($_ -split '\s+')[-1]
} | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1)
if ($portPid) {
    Write-Host "Port $Port in use by PID $portPid, killing it..." -ForegroundColor Yellow
    Stop-Process -Id ([int]$portPid) -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# Step 2: Ensure Node.js and hyco-ws are available
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required. Please install it first."
    exit 1
}
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent (Resolve-Path $MyInvocation.MyCommand.Path) }
if (-not $scriptDir) { $scriptDir = Get-Location }
Write-Host "Script directory: $scriptDir" -ForegroundColor Gray
if (-not (Test-Path (Join-Path $scriptDir "node_modules\hyco-ws"))) {
    Write-Host "Installing hyco-ws..." -ForegroundColor Yellow
    Push-Location $scriptDir
    npm install hyco-ws --no-optional --no-fund --no-audit 2>&1 | Write-Host
    Pop-Location
}

# Step 3: Create hybrid connection if it doesn't exist (requires az cli logged in)
if (Get-Command az -ErrorAction SilentlyContinue) {
    $nsMatch = $RelayConnectionString -match 'Endpoint=sb://([^.]+)\.'
    if ($nsMatch) {
        $nsName = $Matches[1]
        Write-Host "Creating hybrid connection '$ConnectionName' on namespace '$nsName' (if needed)..." -ForegroundColor Yellow
        # Use Start-Process with timeout + spinner so user sees progress
        $tmpOut = [System.IO.Path]::GetTempFileName()
        $tmpErr = [System.IO.Path]::GetTempFileName()
        $proc = Start-Process -FilePath "az" `
            -ArgumentList "relay hyco create --resource-group wulei-test --namespace-name $nsName --name $ConnectionName" `
            -NoNewWindow -PassThru -Wait:$false `
            -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
        $waited = 0
        while (-not $proc.HasExited -and $waited -lt 30) {
            $spinChar = @('|','/','-','\')[$waited % 4]
            Write-Host "`r  Waiting for az CLI... $spinChar ($waited`s)" -NoNewline
            Start-Sleep -Seconds 1
            $waited++
        }
        Write-Host ""
        if (-not $proc.HasExited) {
            try { $proc.Kill() } catch {}
            Write-Host "  az CLI timed out (30s). Run 'az login' first, then re-run this script." -ForegroundColor Yellow
        } elseif ($proc.ExitCode -eq 0) {
            Write-Host "  Done." -ForegroundColor Green
        } else {
            $errText = Get-Content $tmpErr -Raw -ErrorAction SilentlyContinue
            if ($errText -match "already exists") {
                Write-Host "  Connection already exists." -ForegroundColor Green
            } else {
                Write-Host "  Skipped (connection may already exist)." -ForegroundColor Gray
                if ($errText) { Write-Host "  $errText" -ForegroundColor Gray }
            }
        }
        Remove-Item $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "  az CLI not found. Install Azure CLI, run 'az login', then re-run this script." -ForegroundColor Yellow
}

# Step 4: Start processes
$logDir = Join-Path $scriptDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$copilotLog = Join-Path $logDir "copilot.log"
$relayLog = Join-Path $logDir "relay.log"

function Start-Copilot {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting Copilot ACP on port $Port..." -ForegroundColor Yellow
    return Start-Process -FilePath "agency" -ArgumentList "copilot", "--acp", "--port", "$Port", "--yolo" `
        -RedirectStandardOutput $copilotLog -RedirectStandardError (Join-Path $logDir "copilot-err.log") `
        -WindowStyle Hidden -PassThru
}

function Start-Relay {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting relay listener: $ConnectionName..." -ForegroundColor Yellow
    $relayScript = Join-Path $scriptDir "relay-listener.js"
    $env:RELAY_CONNECTION_STRING = $RelayConnectionString
    $env:RELAY_CONNECTION_NAME = $ConnectionName
    $env:ACP_PORT = "$Port"
    return Start-Process -FilePath "node" -ArgumentList "`"$relayScript`"" `
        -WorkingDirectory $scriptDir `
        -RedirectStandardOutput $relayLog -RedirectStandardError (Join-Path $logDir "relay-err.log") `
        -WindowStyle Hidden -PassThru
}

$MaxRestarts = 5
$RestartCooldown = 10
$copilotRestarts = 0
$relayRestarts = 0

$copilotProc = Start-Copilot
Start-Sleep -Seconds 2
$relayProc = Start-Relay

Start-Sleep -Seconds 2

# Check startup
if ($copilotProc.HasExited) {
    Write-Host "Copilot failed to start. Check logs:" -ForegroundColor Red
    Get-Content (Join-Path $logDir "copilot-err.log") -ErrorAction SilentlyContinue | Select-Object -Last 10
}
if ($relayProc.HasExited) {
    Write-Host "Relay listener failed to start. Check logs:" -ForegroundColor Red
    Get-Content (Join-Path $logDir "relay-err.log") -ErrorAction SilentlyContinue | Select-Object -Last 10
}

Write-Host ""
Write-Host "=== Running ===" -ForegroundColor Green
Write-Host "Connection Name: $ConnectionName" -ForegroundColor Cyan
Write-Host "Local ACP:       localhost:$Port"
Write-Host "Logs:            $logDir"
Write-Host ""
Write-Host "From your Next.js server, connect with:" -ForegroundColor Yellow
Write-Host "  RELAY_CONNECTION_STRING=... node relay-sender.js $ConnectionName" -ForegroundColor Gray
Write-Host ""
Write-Host "Watching processes (Ctrl+C to stop)..." -ForegroundColor Gray

# Step 5: Watch loop
try {
    while ($true) {
        Start-Sleep -Seconds $CheckInterval

        if ($copilotProc.HasExited) {
            $copilotRestarts++
            if ($copilotRestarts -gt $MaxRestarts) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Copilot exceeded $MaxRestarts restarts. Giving up." -ForegroundColor Red
            } else {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Copilot exited (code: $($copilotProc.ExitCode)). Restart $copilotRestarts/$MaxRestarts..." -ForegroundColor Red
                Get-Content (Join-Path $logDir "copilot-err.log") -ErrorAction SilentlyContinue | Select-Object -Last 5
                Start-Sleep -Seconds $RestartCooldown
                $copilotProc = Start-Copilot
            }
        }

        if ($relayProc.HasExited) {
            $relayRestarts++
            if ($relayRestarts -gt $MaxRestarts) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Relay exceeded $MaxRestarts restarts. Giving up." -ForegroundColor Red
            } else {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Relay exited (code: $($relayProc.ExitCode)). Restart $relayRestarts/$MaxRestarts..." -ForegroundColor Red
                Get-Content (Join-Path $logDir "relay-err.log") -ErrorAction SilentlyContinue | Select-Object -Last 5
                Start-Sleep -Seconds $RestartCooldown
                $relayProc = Start-Relay
            }
        }

        if ($copilotRestarts -gt $MaxRestarts -and $relayRestarts -gt $MaxRestarts) {
            Write-Error "Both processes failed repeatedly. Exiting."
            exit 1
        }
    }
} finally {
    Write-Host "`nShutting down..." -ForegroundColor Yellow
    if (-not $copilotProc.HasExited) {
        Stop-Process -Id $copilotProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  Stopped copilot (PID $($copilotProc.Id))" -ForegroundColor Gray
    }
    if (-not $relayProc.HasExited) {
        Stop-Process -Id $relayProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  Stopped relay (PID $($relayProc.Id))" -ForegroundColor Gray
    }
    Write-Host "Cleanup complete." -ForegroundColor Green
}
