# Pack Agents Chat for transfer to another device.
# Usage: .\scripts\pack.ps1
#        .\scripts\pack.ps1 -NoHistory
param([switch]$NoHistory)

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ZipPath = Join-Path $ProjectDir 'acp-chat.zip'
$StagingDir = Join-Path $ProjectDir ".pack-staging-$PID"
$OperationId = $null

function Invoke-NodeJson {
    param([string[]]$Arguments)

    $output = & node @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Node command failed: node $($Arguments -join ' ')"
    }
    return ($output | Out-String | ConvertFrom-Json)
}

function Protect-PathAcl {
    param(
        [string]$Path,
        [switch]$Container
    )

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = if ($Container) {
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        [System.Security.AccessControl.InheritanceFlags]::None
    }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}
if (Test-Path -LiteralPath $StagingDir) {
    Remove-Item -LiteralPath $StagingDir -Recurse -Force
}

Write-Host 'Packing Agents Chat...' -ForegroundColor Cyan

try {
    New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null
    Protect-PathAcl -Path $StagingDir -Container

    $items = @(
        'app', 'lib', 'public',
        'agents.json', '.env.local',
        'package.json', 'package-lock.json',
        'tsconfig.json', 'next.config.ts', 'next-env.d.ts',
        'middleware.ts', 'scripts',
        'globals.css'
    )
    foreach ($item in $items) {
        $source = Join-Path $ProjectDir $item
        if (-not (Test-Path -LiteralPath $source)) {
            continue
        }
        $destination = Join-Path $StagingDir $item
        if (Test-Path -LiteralPath $source -PathType Container) {
            Copy-Item -LiteralPath $source -Destination $destination -Recurse
        } else {
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination
        }
    }

    if (-not $NoHistory) {
        $acquired = Invoke-NodeJson -Arguments @(
            (Join-Path $PSScriptRoot 'runtime-preflight.mjs'),
            'acquire-lease',
            '--project-root', $ProjectDir,
            '--owner', 'pack',
            '--owner-pid', "$PID"
        )
        $OperationId = $acquired.lease.operationId

        $prepared = Invoke-NodeJson -Arguments @(
            (Join-Path $PSScriptRoot 'runtime-preflight.mjs'),
            'prepare',
            '--project-root', $ProjectDir,
            '--operation-id', $OperationId
        )
        $backup = $prepared.backup
        $dataDestination = Join-Path $StagingDir '.data'
        New-Item -ItemType Directory -Path $dataDestination -Force | Out-Null
        Protect-PathAcl -Path $dataDestination -Container

        foreach ($database in @('chats.db', 'config.db')) {
            $snapshotPath = $backup.paths.PSObject.Properties[$database].Value
            if ([string]::IsNullOrWhiteSpace($snapshotPath) -or
                -not (Test-Path -LiteralPath $snapshotPath -PathType Leaf)) {
                throw "Verified snapshot does not contain required database: $database"
            }
            Copy-Item `
                -LiteralPath $snapshotPath `
                -Destination (Join-Path $dataDestination $database)
        }
    }

    Compress-Archive -Path (Join-Path $StagingDir '*') -DestinationPath $ZipPath -Force
    Protect-PathAcl -Path $ZipPath
} finally {
    if ($OperationId) {
        & node `
            (Join-Path $PSScriptRoot 'release-operation-lease.mjs') `
            --project-root $ProjectDir `
            --operation-id $OperationId
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Failed to release packaging lease $OperationId"
        }
    }
    if (Test-Path -LiteralPath $StagingDir) {
        Remove-Item -LiteralPath $StagingDir -Recurse -Force
    }
}

$size = [math]::Round((Get-Item -LiteralPath $ZipPath).Length / 1MB, 1)
Write-Host "Created: $ZipPath ($size MB)" -ForegroundColor Green
Write-Host ''
Write-Host 'Transfer this zip to the new device, then run:' -ForegroundColor Yellow
Write-Host '  Expand-Archive acp-chat.zip -DestinationPath agents-chat' -ForegroundColor White
Write-Host '  cd agents-chat' -ForegroundColor White
Write-Host '  .\scripts\setup.ps1' -ForegroundColor White
