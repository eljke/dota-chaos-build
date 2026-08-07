#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://github\.com/[^/]+/[^/]+/?$')]
    [string]$RepositoryUrl,

    [string]$RegistrationToken,

    [string]$RunnerName = "$env:COMPUTERNAME-dota-verifier",

    [string]$RunnerRoot = "$env:ProgramData\GitHubActions\dota-verifier",

    [string]$Labels = 'dota-verifier'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter()]
        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath"
    }
}

function Read-PlainTextSecret {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Prompt
    )

    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

if ([string]::IsNullOrWhiteSpace($RegistrationToken)) {
    $RegistrationToken = Read-PlainTextSecret 'GitHub runner registration token'
}

if ([string]::IsNullOrWhiteSpace($RegistrationToken)) {
    throw 'Registration token is required.'
}

$RepositoryUrl = $RepositoryUrl.TrimEnd('/')
$RunnerRoot = [IO.Path]::GetFullPath($RunnerRoot)

if (Test-Path (Join-Path $RunnerRoot '.runner')) {
    throw "Runner is already configured in $RunnerRoot."
}

if (Test-Path $RunnerRoot) {
    $existingItems = @(Get-ChildItem -LiteralPath $RunnerRoot -Force)
    if ($existingItems.Count -gt 0) {
        throw "Runner directory is not empty: $RunnerRoot"
    }
}
else {
    New-Item -ItemType Directory -Path $RunnerRoot -Force | Out-Null
}

$headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'dota-chaos-windows-runner-installer'
    'X-GitHub-Api-Version' = '2022-11-28'
}

Write-Host 'Resolving the latest official GitHub Actions runner release...'
$release = Invoke-RestMethod `
    -Uri 'https://api.github.com/repos/actions/runner/releases/latest' `
    -Headers $headers

$asset = $release.assets |
    Where-Object { $_.name -match '^actions-runner-win-x64-\d+\.\d+\.\d+\.zip$' } |
    Select-Object -First 1

if (-not $asset) {
    throw 'The Windows x64 runner archive was not found in the latest release.'
}

$archivePath = Join-Path $env:TEMP $asset.name

try {
    Write-Host "Downloading $($asset.name)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $archivePath

    $digestProperty = $asset.PSObject.Properties['digest']
    if ($digestProperty -and $digestProperty.Value -match '^sha256:(?<hash>[0-9a-fA-F]{64})$') {
        $expectedHash = $Matches.hash
        $actualHash = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash
        if ($actualHash -ne $expectedHash) {
            throw 'Downloaded runner archive SHA-256 does not match the GitHub release digest.'
        }
    }

    Expand-Archive -Path $archivePath -DestinationPath $RunnerRoot -Force
}
finally {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
}

$configPath = Join-Path $RunnerRoot 'config.cmd'

$configArguments = @(
    '--unattended',
    '--url', $RepositoryUrl,
    '--token', $RegistrationToken,
    '--name', $RunnerName,
    '--labels', $Labels,
    '--work', '_work',
    '--replace',
    '--runasservice'
)

Push-Location $RunnerRoot
try {
    Write-Host "Registering runner $RunnerName..."
    Invoke-NativeCommand -FilePath $configPath -Arguments $configArguments
}
finally {
    Pop-Location
    $RegistrationToken = $null
}

Write-Host ''
Write-Host 'Runner installation completed.'
Write-Host "Name:   $RunnerName"
Write-Host "Labels: self-hosted, Windows, X64, $Labels"
Write-Host "Root:   $RunnerRoot"
Write-Host 'No inbound firewall port is required.'
