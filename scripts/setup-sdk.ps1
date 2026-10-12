[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [string]$Destination
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$localRoot = Join-Path $repoRoot '.local'
if (-not $Destination) { $Destination = Join-Path $localRoot 'sdk' }
$Destination = [IO.Path]::GetFullPath($Destination)
$sourceZip = (Get-Item -LiteralPath $ZipPath).FullName
if (-not (Test-Path -LiteralPath $localRoot)) { New-Item -ItemType Directory -Path $localRoot | Out-Null }
if (Test-Path -LiteralPath $Destination) {
    throw "Destination already exists: $Destination. Use a new -Destination to preserve any existing SDK."
}

# Stage only below the local private directory. Never publish the SDK or its models.
$stagingRoot = Join-Path $localRoot ('sdk-stage-' + [guid]::NewGuid().ToString('N'))
$stagingFiles = Join-Path $stagingRoot 'files'
New-Item -ItemType Directory -Path $stagingFiles -Force | Out-Null
$archive = $null
try {
    $archive = [IO.Compression.ZipFile]::OpenRead($sourceZip)
    $header = @($archive.Entries | Where-Object {
        $_.FullName.Replace('\', '/') -match '(^|/)include/stitcher/ins_stitcher\.h$'
    })
    if ($header.Count -eq 0) {
        $nested = @($archive.Entries | Where-Object {
            $_.FullName.Replace('\', '/') -notmatch '^__MACOSX/' -and
            ([IO.Path]::GetFileName($_.FullName.Replace('\', '/'))) -match '^MediaSDK-[^/]+\.zip$'
        })
        if ($nested.Count -ne 1) { throw 'Expected exactly one MediaSDK ZIP in the bundle.' }
        $innerZip = Join-Path $stagingRoot 'MediaSDK.zip'
        [IO.Compression.ZipFileExtensions]::ExtractToFile($nested[0], $innerZip, $false)
        $archive.Dispose()
        $archive = [IO.Compression.ZipFile]::OpenRead($innerZip)
        $header = @($archive.Entries | Where-Object {
            $_.FullName.Replace('\', '/') -match '(^|/)include/stitcher/ins_stitcher\.h$'
        })
    }
    if ($header.Count -ne 1) { throw 'A unique MediaSDK public header was not found.' }
    $headerName = $header[0].FullName.Replace('\', '/')
    $prefix = $headerName.Substring(0, $headerName.Length - 'include/stitcher/ins_stitcher.h'.Length)
    $totalBytes = ($archive.Entries | Measure-Object -Property Length -Sum).Sum
    if ($totalBytes -gt 6GB) { throw 'Unexpected SDK expanded size exceeds 6 GB.' }
    $safePrefix = $stagingFiles.TrimEnd('\') + '\'
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if (-not $name.StartsWith($prefix, [StringComparison]::Ordinal)) { continue }
        $relative = $name.Substring($prefix.Length)
        if (-not $relative -or $relative.EndsWith('/')) { continue }
        if ($relative -match '^__MACOSX/' -or $relative -match '(^|/)\.DS_Store$') { continue }
        if ($relative -notmatch '^(bin|include|lib)/') { continue }
        if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':')) { throw 'Unsafe archive entry.' }
        $target = [IO.Path]::GetFullPath((Join-Path $stagingFiles $relative))
        if (-not $target.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Archive entry escapes the private SDK directory.'
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
    $archive.Dispose()
    $archive = $null
    foreach ($required in @('bin/MediaSDKTest.exe', 'bin/MediaSDK.dll', 'lib/MediaSDK.lib', 'include/stitcher/ins_stitcher.h')) {
        if (-not (Test-Path -LiteralPath (Join-Path $stagingFiles $required))) { throw "Missing SDK component: $required" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stagingFiles 'bin/models'))) { throw 'SDK model directory is missing.' }

    # The only move is an explicitly checked staging directory created by this run.
    $resolvedStaging = (Resolve-Path -LiteralPath $stagingFiles).Path
    if (-not $resolvedStaging.StartsWith($localRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Staging path escaped the application local directory.'
    }
    $destinationParent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Move-Item -LiteralPath $resolvedStaging -Destination $Destination

    $configPath = Join-Path $localRoot 'config.json'
    $config = @{}
    if (Test-Path -LiteralPath $configPath) {
        $previous = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        foreach ($property in $previous.PSObject.Properties) { $config[$property.Name] = $property.Value }
    }
    $config.sdkRoot = $Destination
    $config.sdkExecutable = Join-Path $Destination 'bin/MediaSDKTest.exe'
    $config.sdkKind = 'sample'
    $config.sdkModels = (Join-Path $Destination 'bin/models') + '\'
    $config.sdkCwd = Join-Path $Destination 'bin'
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Private SDK configured in $Destination"
    Write-Host "Configuration saved in $configPath. SDK files must remain excluded from Git."
} finally {
    if ($archive) { $archive.Dispose() }
    # Clean up only the staging tree created above, after verifying its absolute scope.
    if (Test-Path -LiteralPath $stagingRoot) {
        $resolvedStage = (Resolve-Path -LiteralPath $stagingRoot).Path
        if ($resolvedStage.StartsWith($localRoot.TrimEnd('\') + '\sdk-stage-', [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
