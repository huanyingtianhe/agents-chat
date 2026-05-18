# Copilot ACP + Azure Relay Setup Script
# Starts Copilot ACP and a relay listener to expose it via Azure Relay
# No devtunnel needed — uses Azure Relay Hybrid Connections

param(
    [int]$Port = 0,
    [int]$CheckInterval = 5,
    [int]$MaxRestarts = 0,
    [int]$RestartCooldown = 10,
    [string]$RelayConnectionString = $env:RELAY_CONNECTION_STRING,
    [string]$ConnectionName = $env:COMPUTERNAME.ToLower(),
    [string]$KeyVaultName = "__RELAY_KEY_VAULT_NAME__",
    [string]$SecretName = "__RELAY_KEY_VAULT_SECRET_NAME__",
    [string]$RelaySubscriptionId = "__RELAY_SUBSCRIPTION_ID__",
    [string]$RelayResourceGroup = "__RELAY_RESOURCE_GROUP__",
    [string]$NodePath,
    [string]$AgencyPath,
    [switch]$UninstallService,
    [switch]$RunAsService
)

$TaskName = "AgentsChatNode"

function Get-ScriptDirectory {
    if ($PSScriptRoot) { return $PSScriptRoot }
    if ($MyInvocation.MyCommand.Path) { return Split-Path -Parent (Resolve-Path $MyInvocation.MyCommand.Path) }
    return (Get-Location).Path
}

function Get-ExecutablePath([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Add-PathEntry([string]$PathEntry) {
    if (-not $PathEntry -or -not (Test-Path $PathEntry)) { return }
    $entries = $env:Path -split ';'
    if ($entries -notcontains $PathEntry) { $env:Path = "$env:Path;$PathEntry" }
}

function Update-ProcessPath {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    Add-PathEntry "C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin"
    Add-PathEntry "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin"
}

function Install-AzureCli {
    Write-Host "Azure CLI was not found. Installing Azure CLI..." -ForegroundColor Yellow
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Error "Azure CLI is required, but winget was not found. Install Azure CLI manually, run 'az login', then rerun this script."
        return $null
    }

    winget install --id Microsoft.AzureCLI -e --source winget --accept-package-agreements --accept-source-agreements 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to install Azure CLI with winget. Install Azure CLI manually, run 'az login', then rerun this script."
        return $null
    }

    Update-ProcessPath
    return Get-ExecutablePath "az"
}

function Resolve-AzureCliPath {
    $resolvedPath = Get-ExecutablePath "az"
    if ($resolvedPath) { return $resolvedPath }

    Update-ProcessPath
    $resolvedPath = Get-ExecutablePath "az"
    if ($resolvedPath) { return $resolvedPath }

    return Install-AzureCli
}

function Install-NodeJs {
    Write-Host "Node.js was not found. Installing Node.js LTS..." -ForegroundColor Yellow
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Error "Node.js is required, but winget was not found. Install Node.js manually from https://nodejs.org, then rerun this script."
        return $null
    }

    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to install Node.js with winget. Install Node.js manually from https://nodejs.org, then rerun this script."
        return $null
    }

    Update-ProcessPath
    $resolvedPath = Get-ExecutablePath "node"
    if ($resolvedPath) { return $resolvedPath }

    $defaultNodePath = "C:\Program Files\nodejs\node.exe"
    if (Test-Path $defaultNodePath) { return $defaultNodePath }

    return $null
}

function Resolve-NodePath([string]$CurrentPath) {
    if ($CurrentPath) { return $CurrentPath }

    $resolvedPath = Get-ExecutablePath "node"
    if ($resolvedPath) { return $resolvedPath }

    Update-ProcessPath
    $resolvedPath = Get-ExecutablePath "node"
    if ($resolvedPath) { return $resolvedPath }

    return Install-NodeJs
}

function Install-AgencyCli {
    Write-Host "The 'agency' CLI was not found. Installing agency..." -ForegroundColor Yellow
    try {
        iex "& { $(irm aka.ms/InstallTool.ps1)} agency"
    } catch {
        Write-Error "Failed to install the 'agency' CLI. $($_.Exception.Message)"
        return $null
    }

    Update-ProcessPath
    return Get-ExecutablePath "agency"
}

function Resolve-AgencyPath([string]$CurrentPath) {
    if ($CurrentPath) { return $CurrentPath }

    $resolvedPath = Get-ExecutablePath "agency"
    if ($resolvedPath) { return $resolvedPath }

    Update-ProcessPath
    $resolvedPath = Get-ExecutablePath "agency"
    if ($resolvedPath) { return $resolvedPath }

    return Install-AgencyCli
}

function Get-AzureAccountEmail {
    if (-not (Resolve-AzureCliPath)) { return $null }
    $email = az account show --query "user.name" -o tsv 2>$null
    if ($LASTEXITCODE -eq 0 -and $email) { return $email.Trim() }
    return $null
}

function Test-IsTemplatePlaceholder([string]$Value) {
    if (-not $Value) { return $false }
    return $Value -match '^__.*__$'
}

function Test-CanUseKeyVaultLookup([string]$VaultName, [string]$VaultSecretName) {
    if (-not $VaultName -or -not $VaultSecretName) { return $false }
    if (Test-IsTemplatePlaceholder $VaultName) { return $false }
    if (Test-IsTemplatePlaceholder $VaultSecretName) { return $false }
    return $true
}

function Get-RelayAzureScopeArguments {
    if (
        -not $RelaySubscriptionId -or
        -not $RelayResourceGroup -or
        (Test-IsTemplatePlaceholder $RelaySubscriptionId) -or
        (Test-IsTemplatePlaceholder $RelayResourceGroup)
    ) { return $null }

    return @("--subscription", $RelaySubscriptionId, "--resource-group", $RelayResourceGroup)
}

function Format-TaskArgument([string]$Name, [string]$Value) {
    if ($null -eq $Value -or $Value -eq "") { return "" }
    return " -$Name `"$Value`""
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Stop-ServiceProcesses([string]$ScriptDir) {
    $relayScript = Join-Path $ScriptDir "relay-listener.js"
    $setupScript = Join-Path $ScriptDir "setup-node.ps1"
    $currentPid = $PID

    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.Name -in @("node.exe", "agency.exe", "pwsh.exe", "powershell.exe")) -and $_.CommandLine
    }

    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        $isRelay = $process.Name -eq "node.exe" -and $commandLine.Contains($relayScript)
        $isCopilotAcp = $process.Name -eq "agency.exe" -and $commandLine -match "\bcopilot\b" -and $commandLine -match "--acp"
        $isSupervisor = $process.ProcessId -ne $currentPid -and $process.Name -in @("pwsh.exe", "powershell.exe") -and $commandLine.Contains($setupScript) -and $commandLine -match "-RunAsService"

        if (-not ($isRelay -or $isCopilotAcp -or $isSupervisor)) { continue }

        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        if ($isRelay) { Write-Host "Stopped relay listener process (PID $($process.ProcessId))." -ForegroundColor Gray }
        elseif ($isCopilotAcp) { Write-Host "Stopped Copilot ACP process (PID $($process.ProcessId))." -ForegroundColor Gray }
        elseif ($isSupervisor) { Write-Host "Stopped service supervisor process (PID $($process.ProcessId))." -ForegroundColor Gray }
    }
}

function Write-LogTail([string]$Path, [int]$LineCount = 40) {
    if (Test-Path $Path) {
        Write-Host "Last $LineCount lines from ${Path}:" -ForegroundColor Gray
        Get-Content $Path -Tail $LineCount -ErrorAction SilentlyContinue
    } else {
        Write-Host "Log file was not created yet: $Path" -ForegroundColor Yellow
    }
}

function Remove-AzureRelayHybridConnection([string]$ConnectionString, [string]$HybridConnectionName, [string]$VaultName, [string]$VaultSecretName) {
    if (-not (Resolve-AzureCliPath)) {
        Write-Host "Azure CLI could not be installed or located. Azure Relay Hybrid Connection was not deleted." -ForegroundColor Red
        return $false
    }

    if (-not $ConnectionString) {
        if (-not (Test-CanUseKeyVaultLookup $VaultName $VaultSecretName)) {
            Write-Host "Relay connection string is missing. Download a rendered setup ZIP or pass -RelayConnectionString." -ForegroundColor Red
            return $false
        }

        Write-Host "Fetching relay connection string from Key Vault '$VaultName' for cleanup..." -ForegroundColor Yellow
        $ConnectionString = az keyvault secret show --vault-name $VaultName --name $VaultSecretName --query "value" -o tsv 2>&1
        if ($LASTEXITCODE -ne 0 -or -not $ConnectionString) {
            Write-Host "Failed to fetch secret '$VaultSecretName' from Key Vault '$VaultName'. Azure Relay Hybrid Connection was not deleted." -ForegroundColor Red
            if ($ConnectionString) { Write-Host $ConnectionString -ForegroundColor Gray }
            return $false
        }
    }

    $nsMatch = $ConnectionString -match 'Endpoint=sb://([^.]+)\.'
    if (-not $nsMatch) {
        Write-Host "Relay connection string does not contain a recognizable Service Bus namespace endpoint. Azure Relay Hybrid Connection was not deleted." -ForegroundColor Red
        return $false
    }

    $nsName = $Matches[1]
    $relayScopeArgs = Get-RelayAzureScopeArguments
    if (-not $relayScopeArgs) {
        Write-Host "Set RelaySubscriptionId and RelayResourceGroup to delete the Azure Relay Hybrid Connection." -ForegroundColor Yellow
        return $false
    }

    Write-Host "Deleting hybrid connection '$HybridConnectionName' from namespace '$nsName'..." -ForegroundColor Yellow
    $deleteOutput = az relay hyco delete @relayScopeArgs --namespace-name $nsName --name $HybridConnectionName 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Deleted hybrid connection '$HybridConnectionName'." -ForegroundColor Green
        return $true
    }

    if ($deleteOutput -match "(?i)(not found|notfound|could not be found|does not exist)") {
        Write-Host "Hybrid connection '$HybridConnectionName' was already absent." -ForegroundColor Green
        return $true
    }

    Write-Host "Failed to delete hybrid connection '$HybridConnectionName'." -ForegroundColor Red
    if ($deleteOutput) { Write-Host $deleteOutput -ForegroundColor Gray }
    return $false
}

if (-not (Test-IsAdministrator)) {
    Write-Error "Administrator permission is required. Open PowerShell as Administrator and rerun this script."
    exit 1
}

if ($UninstallService) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $uninstallScriptDir = Get-ScriptDirectory
    Stop-ServiceProcesses $uninstallScriptDir
    $relayDeleted = Remove-AzureRelayHybridConnection $RelayConnectionString $ConnectionName $KeyVaultName $SecretName
    Remove-Item (Join-Path (Join-Path $uninstallScriptDir "logs") "service-pids.json") -Force -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    if (-not $relayDeleted) {
        Write-Error "Local service was removed, but Azure Relay Hybrid Connection cleanup did not complete. Fix the Azure CLI error and rerun with -UninstallService."
        exit 1
    }
    exit 0
}

# ─── Install as a startup scheduled task unless the task is already running us ───
if (-not $RunAsService) {
    $scriptPath = $MyInvocation.MyCommand.Path
    if (-not $scriptPath) { $scriptPath = Join-Path (Get-Location) "setup-node.ps1" }
    $workingDirectory = Split-Path $scriptPath
    $powershellPath = Get-ExecutablePath "pwsh"
    if (-not $powershellPath) { $powershellPath = Get-ExecutablePath "powershell" }
    if (-not $powershellPath) {
        Write-Error "PowerShell executable was not found. Install PowerShell 7 or use Windows PowerShell."
        exit 1
    }

    if (-not $NodePath) { $NodePath = Resolve-NodePath $NodePath }
    if (-not $NodePath) {
        Write-Error "Node.js is required. Install it first, then rerun this command."
        exit 1
    }

    if (-not $AgencyPath) { $AgencyPath = Resolve-AgencyPath $AgencyPath }
    if (-not $AgencyPath) {
        Write-Error "The 'agency' CLI is required, but setup could not install or locate it. Install it manually, then rerun this command."
        exit 1
    }

    $installLogDir = Join-Path $workingDirectory "logs"
    if (-not (Test-Path $installLogDir)) { New-Item -ItemType Directory -Path $installLogDir -Force | Out-Null }
    $serviceLog = Join-Path $installLogDir "service.log"

    $scriptArguments = " -Port $Port -CheckInterval $CheckInterval -MaxRestarts $MaxRestarts -RestartCooldown $RestartCooldown"
    $scriptArguments += Format-TaskArgument "ConnectionName" $ConnectionName
    $scriptArguments += Format-TaskArgument "KeyVaultName" $KeyVaultName
    $scriptArguments += Format-TaskArgument "SecretName" $SecretName
    $scriptArguments += Format-TaskArgument "RelaySubscriptionId" $RelaySubscriptionId
    $scriptArguments += Format-TaskArgument "RelayResourceGroup" $RelayResourceGroup
    $scriptArguments += Format-TaskArgument "NodePath" $NodePath
    $scriptArguments += Format-TaskArgument "AgencyPath" $AgencyPath
    if ($RelayConnectionString) { $scriptArguments += Format-TaskArgument "RelayConnectionString" $RelayConnectionString }
    $commandText = "& `"$scriptPath`" -RunAsService$scriptArguments *>> `"$serviceLog`""
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($commandText))
    $argList = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand $encodedCommand"

    $action = New-ScheduledTaskAction -Execute $powershellPath -Argument $argList -WorkingDirectory $workingDirectory
    $taskUser = "$env:USERDOMAIN\$env:USERNAME"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
    $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Highest

    try {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
    } catch {
        Write-Error "Failed to register '$TaskName'. Run PowerShell as Administrator and try again. $($_.Exception.Message)"
        exit 1
    }

    Write-Host "Registered scheduled task '$TaskName' to start when $taskUser logs in." -ForegroundColor Green
    Write-Host "  Script: $scriptPath" -ForegroundColor Gray
    Write-Host "  Node:   $NodePath" -ForegroundColor Gray
    Write-Host "  Agency: $AgencyPath" -ForegroundColor Gray

    try {
        $taskBeforeStart = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $taskBeforeStart -or $taskBeforeStart.State -ne "Running") {
            Remove-Item $serviceLog -Force -ErrorAction SilentlyContinue
        }

        $serviceStartTime = Get-Date
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Write-Host "Started scheduled task '$TaskName'." -ForegroundColor Green

        Write-Host "Checking service startup..." -ForegroundColor Yellow
        for ($i = 0; $i -lt 10; $i++) {
            Start-Sleep -Seconds 1
            $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            if ($task -and $task.State -eq "Running") { break }
        }

        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task -and $task.State -eq "Running") {
            Write-Host "Service supervisor is running." -ForegroundColor Green
            Write-Host "  Log: $serviceLog" -ForegroundColor Gray

            Write-Host "Waiting for ACP server and relay listener to become ready..." -ForegroundColor Yellow
            $serviceReady = $false
            for ($i = 0; $i -lt 90; $i++) {
                Start-Sleep -Seconds 1
                $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
                if (-not $task -or $task.State -ne "Running") { break }

                if (Test-Path $serviceLog) {
                    $recentLog = Get-Content $serviceLog -Tail 120 -ErrorAction SilentlyContinue
                    if ($recentLog -contains "=== Running ===") {
                        $serviceReady = $true
                        break
                    }
                }
            }

            if ($serviceReady) {
                Write-Host "ACP server and relay listener are ready." -ForegroundColor Green
            } else {
                Write-Host "Service supervisor is running, but ACP/relay readiness was not confirmed within 90 seconds." -ForegroundColor Red
                if ($serviceStartTime) { Write-Host "  Started waiting at: $serviceStartTime" -ForegroundColor Gray }
                Write-LogTail $serviceLog 80
                exit 1
            }

            if (Test-Path $serviceLog) {
                $recentLog = Get-Content $serviceLog -Tail 60 -ErrorAction SilentlyContinue
                $errorLines = $recentLog | Where-Object { $_ -match "(?i)(failed|error|required|timed out|no available port|giving up|exceeded)" }
                if ($errorLines) {
                    Write-Host "Service log contains startup warnings/errors:" -ForegroundColor Yellow
                    $errorLines | Select-Object -Last 10
                }
            }
        } else {
            Write-Host "Scheduled task '$TaskName' stopped during startup." -ForegroundColor Red
            if ($taskInfo) {
                Write-Host "  LastTaskResult: $($taskInfo.LastTaskResult)" -ForegroundColor Red
                Write-Host "  LastRunTime:    $($taskInfo.LastRunTime)" -ForegroundColor Gray
            }
            Write-LogTail $serviceLog 60
            exit 1
        }
    } catch {
        Write-Host "Registered, but could not start '$TaskName' immediately. Start it with: Start-ScheduledTask -TaskName $TaskName" -ForegroundColor Yellow
        Write-Host "  Log: $serviceLog" -ForegroundColor Gray
    }

    Write-Host "  To remove: .\setup-node.ps1 -UninstallService" -ForegroundColor Gray
    exit 0
}

$scriptDir = Get-ScriptDirectory
$logDir = Join-Path $scriptDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Service mode entered. User=$env:USERNAME Computer=$env:COMPUTERNAME"

# If no connection string provided, fetch from Azure Key Vault
if (-not $RelayConnectionString) {
    if (-not (Test-CanUseKeyVaultLookup $KeyVaultName $SecretName)) {
        Write-Error "Relay connection string is missing. Download a rendered setup ZIP or pass -RelayConnectionString."
        exit 1
    }

    if (-not (Resolve-AzureCliPath)) {
        Write-Error "Azure CLI is required to fetch the relay connection string from Key Vault. Install Azure CLI manually, run 'az login', then rerun this script."
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

function Stop-PortOwner([int]$Port) {
    $portPid = (netstat -ano 2>$null | Select-String "127\.0\.0\.1:$Port\s" | ForEach-Object {
        ($_ -split '\s+')[-1]
    } | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1)
    if ($portPid) {
        Write-Host "Port $Port in use by PID $portPid, killing it..." -ForegroundColor Yellow
        Stop-Process -Id ([int]$portPid) -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
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
Stop-PortOwner $Port

# Step 2: Ensure Node.js, agency, and hyco-ws are available
if (-not $NodePath) { $NodePath = Resolve-NodePath $NodePath }
if (-not $NodePath) {
    Write-Error "Node.js is required. Please install it first."
    exit 1
}

if (-not $AgencyPath) { $AgencyPath = Resolve-AgencyPath $AgencyPath }
if (-not $AgencyPath) {
    Write-Error "The 'agency' CLI is required, but setup could not install or locate it. Install it manually, then rerun this command."
    exit 1
}
Write-Host "Script directory: $scriptDir" -ForegroundColor Gray
if (-not (Test-Path (Join-Path $scriptDir "node_modules\hyco-ws"))) {
    Write-Host "Installing hyco-ws..." -ForegroundColor Yellow
    Push-Location $scriptDir
    npm install hyco-ws --no-optional --no-fund --no-audit 2>&1 | Write-Host
    Pop-Location
}

# Step 3: Create hybrid connection if it doesn't exist (requires az cli logged in)
if (Resolve-AzureCliPath) {
    $nsMatch = $RelayConnectionString -match 'Endpoint=sb://([^.]+)\.'
    if ($nsMatch) {
        $nsName = $Matches[1]
        $relayScopeArgs = Get-RelayAzureScopeArguments
        if (-not $relayScopeArgs) {
            Write-Host "Skipping hybrid connection create/update because RelaySubscriptionId or RelayResourceGroup is not configured." -ForegroundColor Yellow
        } else {
            $azureAccountEmail = Get-AzureAccountEmail
            $createArguments = @(
                "relay", "hyco", "create",
                "--subscription", $RelaySubscriptionId,
                "--resource-group", $RelayResourceGroup,
                "--namespace-name", $nsName,
                "--name", $ConnectionName
            )
            if ($azureAccountEmail) {
                $createArguments += @("--user-metadata", "AzureAccountEmail=$azureAccountEmail")
                Write-Host "Azure account: $azureAccountEmail" -ForegroundColor Gray
            } else {
                Write-Host "Could not read Azure account email; creating hybrid connection without user metadata." -ForegroundColor Yellow
            }

            Write-Host "Creating hybrid connection '$ConnectionName' on namespace '$nsName' (if needed)..." -ForegroundColor Yellow
            # Use Start-Process with timeout + spinner so user sees progress
            $tmpOut = [System.IO.Path]::GetTempFileName()
            $tmpErr = [System.IO.Path]::GetTempFileName()
            $proc = Start-Process -FilePath "az" `
                -ArgumentList $createArguments `
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
                    if ($azureAccountEmail) {
                        Write-Host "  Updating hybrid connection user metadata..." -ForegroundColor Yellow
                        az relay hyco update @relayScopeArgs --namespace-name $nsName --name $ConnectionName --user-metadata "AzureAccountEmail=$azureAccountEmail" 2>&1 | Write-Host
                        if ($LASTEXITCODE -ne 0) {
                            Write-Host "  Failed to update user metadata." -ForegroundColor Yellow
                        }
                    }
                } else {
                    Write-Host "  Skipped (connection may already exist)." -ForegroundColor Gray
                    if ($errText) { Write-Host $errText -ForegroundColor Gray }
                }
            }
            Remove-Item $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
        }
    }
} else {
    Write-Error "Azure CLI is required to create the Hybrid Connection. Install Azure CLI manually, run 'az login', then rerun this script."
    exit 1
}

# Step 4: Start processes
$copilotLog = Join-Path $logDir "copilot.log"
$copilotErrLog = Join-Path $logDir "copilot-err.log"
$relayLog = Join-Path $logDir "relay.log"
$relayErrLog = Join-Path $logDir "relay-err.log"

function Start-Copilot {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting Copilot ACP on port $Port..." -ForegroundColor Yellow
    Stop-PortOwner $Port
    Remove-Item $copilotLog, $copilotErrLog -Force -ErrorAction SilentlyContinue
    return Start-Process -FilePath $AgencyPath -ArgumentList "copilot", "--acp", "--port", "$Port", "--yolo" `
        -RedirectStandardOutput $copilotLog -RedirectStandardError $copilotErrLog `
        -WindowStyle Hidden -PassThru
}

function Start-Relay {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting relay listener: $ConnectionName..." -ForegroundColor Yellow
    $relayScript = Join-Path $scriptDir "relay-listener.js"
    $env:RELAY_CONNECTION_STRING = $RelayConnectionString
    $env:RELAY_CONNECTION_NAME = $ConnectionName
    $env:ACP_PORT = "$Port"
    Remove-Item $relayLog, $relayErrLog -Force -ErrorAction SilentlyContinue
    return Start-Process -FilePath $NodePath -ArgumentList "`"$relayScript`"" `
        -WorkingDirectory $scriptDir `
        -RedirectStandardOutput $relayLog -RedirectStandardError $relayErrLog `
        -WindowStyle Hidden -PassThru
}

function Test-TcpConnect([string]$HostName, [int]$Port, [int]$TimeoutMs = 1000) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Wait-CopilotReady([System.Diagnostics.Process]$Process, [int]$ReadyPort, [string]$ErrorLogPath, [int]$TimeoutSeconds = 30) {
    Write-Host "Waiting for Copilot ACP to accept connections on localhost:$ReadyPort..." -ForegroundColor Yellow
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) {
            Write-Host "Copilot failed to start. Check logs:" -ForegroundColor Red
            Get-Content $ErrorLogPath -ErrorAction SilentlyContinue | Select-Object -Last 10
            return $false
        }

        if (Test-TcpConnect "127.0.0.1" $ReadyPort 1000) {
            Write-Host "  Copilot ACP is ready." -ForegroundColor Green
            return $true
        }

        Start-Sleep -Seconds 1
    }

    Write-Host "Copilot ACP did not become ready within $TimeoutSeconds seconds. Check logs:" -ForegroundColor Red
    Get-Content $ErrorLogPath -ErrorAction SilentlyContinue | Select-Object -Last 10
    return $false
}

function Wait-RelayReady([System.Diagnostics.Process]$Process, [string]$ReadyLogPath, [string]$ErrorLogPath, [int]$TimeoutSeconds = 30) {
    Write-Host "Waiting for relay listener to report ready..." -ForegroundColor Yellow
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) {
            Write-Host "Relay listener failed to start. Check logs:" -ForegroundColor Red
            Get-Content $ErrorLogPath -ErrorAction SilentlyContinue | Select-Object -Last 10
            return $false
        }

        if (Select-String -Path $ReadyLogPath -Pattern "Relay listener is ready" -Quiet -ErrorAction SilentlyContinue) {
            Write-Host "  Relay listener is ready." -ForegroundColor Green
            return $true
        }

        Start-Sleep -Seconds 1
    }

    Write-Host "Relay listener did not report ready within $TimeoutSeconds seconds. Check logs:" -ForegroundColor Red
    Get-Content $ErrorLogPath -ErrorAction SilentlyContinue | Select-Object -Last 10
    Get-Content $ReadyLogPath -ErrorAction SilentlyContinue | Select-Object -Last 10
    return $false
}

$copilotRestarts = 0
$relayRestarts = 0

function Test-RestartAllowed([int]$RestartCount) {
    return $MaxRestarts -eq 0 -or $RestartCount -le $MaxRestarts
}

$copilotProc = Start-Copilot
if (-not (Wait-CopilotReady $copilotProc $Port $copilotErrLog 30)) {
    if ($copilotProc -and -not $copilotProc.HasExited) { Stop-Process -Id $copilotProc.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}

$relayProc = Start-Relay
if (-not (Wait-RelayReady $relayProc $relayLog $relayErrLog 30)) {
    if ($relayProc -and -not $relayProc.HasExited) { Stop-Process -Id $relayProc.Id -Force -ErrorAction SilentlyContinue }
    if ($copilotProc -and -not $copilotProc.HasExited) { Stop-Process -Id $copilotProc.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}

Write-Host ""
Write-Host "=== Running ===" -ForegroundColor Green
Write-Host "Connection Name: $ConnectionName" -ForegroundColor Cyan
Write-Host "Local ACP:       localhost:$Port"
Write-Host "Logs:            $logDir"
Write-Host "Restart policy:  $(if ($MaxRestarts -eq 0) { 'infinite' } else { "$MaxRestarts per process" })"
Write-Host ""
Write-Host "From your Next.js server, connect with:" -ForegroundColor Yellow
Write-Host "  RELAY_CONNECTION_STRING=... node relay-sender.js $ConnectionName" -ForegroundColor Gray
Write-Host ""
Write-Host "Watching processes (Ctrl+C to stop)..." -ForegroundColor Gray

# Step 5: Watch loop
try {
    while ($true) {
        Start-Sleep -Seconds $CheckInterval

        if ($copilotProc -and $copilotProc.HasExited) {
            $copilotRestarts++
            if (-not (Test-RestartAllowed $copilotRestarts)) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Copilot exceeded $MaxRestarts restarts. Giving up." -ForegroundColor Red
                $copilotProc = $null
            } else {
                $restartLabel = if ($MaxRestarts -eq 0) { "restart $copilotRestarts" } else { "restart $copilotRestarts/$MaxRestarts" }
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Copilot exited (code: $($copilotProc.ExitCode)). $restartLabel..." -ForegroundColor Red
                Get-Content (Join-Path $logDir "copilot-err.log") -ErrorAction SilentlyContinue | Select-Object -Last 5
                Start-Sleep -Seconds $RestartCooldown
                $copilotProc = Start-Copilot
                if (-not (Wait-CopilotReady $copilotProc $Port $copilotErrLog 30)) {
                    if ($copilotProc -and -not $copilotProc.HasExited) { Stop-Process -Id $copilotProc.Id -Force -ErrorAction SilentlyContinue }
                }
            }
        }

        if ($relayProc -and $relayProc.HasExited) {
            $relayRestarts++
            if (-not (Test-RestartAllowed $relayRestarts)) {
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Relay exceeded $MaxRestarts restarts. Giving up." -ForegroundColor Red
                $relayProc = $null
            } else {
                $restartLabel = if ($MaxRestarts -eq 0) { "restart $relayRestarts" } else { "restart $relayRestarts/$MaxRestarts" }
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Relay exited (code: $($relayProc.ExitCode)). $restartLabel..." -ForegroundColor Red
                Get-Content (Join-Path $logDir "relay-err.log") -ErrorAction SilentlyContinue | Select-Object -Last 5
                Start-Sleep -Seconds $RestartCooldown
                $relayProc = Start-Relay
                if (-not (Wait-RelayReady $relayProc $relayLog $relayErrLog 30)) {
                    if ($relayProc -and -not $relayProc.HasExited) { Stop-Process -Id $relayProc.Id -Force -ErrorAction SilentlyContinue }
                }
            }
        }

        if ($MaxRestarts -gt 0 -and $copilotRestarts -gt $MaxRestarts -and $relayRestarts -gt $MaxRestarts) {
            Write-Error "Both processes failed repeatedly. Exiting."
            exit 1
        }
    }
} finally {
    Write-Host "`nShutting down..." -ForegroundColor Yellow
    if ($copilotProc -and -not $copilotProc.HasExited) {
        Stop-Process -Id $copilotProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  Stopped copilot (PID $($copilotProc.Id))" -ForegroundColor Gray
    }
    if ($relayProc -and -not $relayProc.HasExited) {
        Stop-Process -Id $relayProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  Stopped relay (PID $($relayProc.Id))" -ForegroundColor Gray
    }
    Write-Host "Cleanup complete." -ForegroundColor Green
}
