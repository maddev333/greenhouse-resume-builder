#Requires -Version 7.0
<#
.SYNOPSIS
    Packages the engagements chat UI as an Azure Web App ZIP and optionally deploys it.

.DESCRIPTION
    The archive itself is produced by `npm run package:webapp:ui`, which shares all staging and
    deterministic-zip logic with the other Web App artifacts in scripts/package-webapps.mjs. This
    wrapper adds the Azure CLI deployment step and the App Service configuration reminders.

.PARAMETER OutputPath
    Also copy the archive here after packaging. By default it is left at .deploy\engagements-ui.zip.

.PARAMETER SkipPackage
    Deploy the existing .deploy\engagements-ui.zip without rebuilding it.

.PARAMETER ResourceGroup
    Resource group of the target Web App. Triggers deployment.

.PARAMETER WebAppName
    Name of the target Web App. Triggers deployment.

.PARAMETER Subscription
    Optional subscription id or name passed to the Azure CLI.

.EXAMPLE
    ./scripts/package-ui-webapp.ps1

.EXAMPLE
    ./scripts/package-ui-webapp.ps1 -ResourceGroup rg-greenhouse -WebAppName greenhouse-chat-host
#>
[CmdletBinding(DefaultParameterSetName = 'Package')]
param(
    [string]$OutputPath,

    [switch]$SkipPackage,

    [Parameter(ParameterSetName = 'Deploy', Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceGroup,

    [Parameter(ParameterSetName = 'Deploy', Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$WebAppName,

    [Parameter(ParameterSetName = 'Deploy')]
    [string]$Subscription
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$ArtifactPath = Join-Path $RepoRoot '.deploy\engagements-ui.zip'

function Assert-Tool {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Hint
    )

    if (-not (Get-Command -Name $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' was not found on PATH. $Hint"
    }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    Push-Location -LiteralPath $RepoRoot
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

Assert-Tool -Name 'npm' -Hint 'Install Node.js 20 or later.'
if ($PSCmdlet.ParameterSetName -eq 'Deploy') {
    Assert-Tool -Name 'az' -Hint 'Install the Azure CLI and run `az login`.'
}

# --- 1. Package -----------------------------------------------------------
if ($SkipPackage) {
    Write-Host '==> Skipping package; reusing the existing archive' -ForegroundColor Yellow
    if (-not (Test-Path -LiteralPath $ArtifactPath)) {
        throw "No archive at $ArtifactPath. Run without -SkipPackage."
    }
}
else {
    Write-Host '==> Packaging the UI (npm run package:webapp:ui)' -ForegroundColor Cyan
    Invoke-Native -FilePath 'npm' -Arguments @('run', 'package:webapp:ui')
}

$archive = Get-Item -LiteralPath $ArtifactPath
$relativeArchive = [System.IO.Path]::GetRelativePath($RepoRoot, $archive.FullName)
Write-Host ("Archive {0} ({1:N2} MB)" -f $relativeArchive, ($archive.Length / 1MB)) -ForegroundColor Green

if ($OutputPath) {
    $destinationDirectory = Split-Path -Parent $OutputPath
    if ($destinationDirectory -and -not (Test-Path -LiteralPath $destinationDirectory)) {
        New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    }
    Copy-Item -LiteralPath $archive.FullName -Destination $OutputPath -Force
    Write-Host "Copied to $OutputPath" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Web App settings (no .env or secrets are included in the archive):'
Write-Host '  HOST_PORT             chat host port      (default 8080 - matches App Service Linux)'
Write-Host '  SANDBOX_PORT          sandbox proxy port  (default 8081)'
Write-Host '  ORCHESTRATOR_URL      public URL of the agent gateway'
Write-Host '  ENGAGEMENTS_MCP_URL   public URL of the engagements MCP /mcp endpoint'
Write-Host ''
Write-Host 'Note: serve.ts binds two ports because the MCP App sandbox must be a distinct origin.' -ForegroundColor Yellow
Write-Host '      A single App Service only routes one port, so deploy this ZIP to two Web Apps' -ForegroundColor Yellow
Write-Host '      (host + sandbox) or front them with a gateway that exposes both origins.' -ForegroundColor Yellow

# --- 2. Optional deploy ---------------------------------------------------
if ($PSCmdlet.ParameterSetName -eq 'Deploy') {
    Write-Host ''
    Write-Host "==> Deploying to $WebAppName ($ResourceGroup)" -ForegroundColor Cyan
    $azArguments = @(
        'webapp', 'deploy',
        '--resource-group', $ResourceGroup,
        '--name', $WebAppName,
        '--src-path', $archive.FullName,
        '--type', 'zip'
    )
    if ($Subscription) {
        $azArguments += @('--subscription', $Subscription)
    }
    Invoke-Native -FilePath 'az' -Arguments $azArguments
    Write-Host 'Deployment complete.' -ForegroundColor Green
}
