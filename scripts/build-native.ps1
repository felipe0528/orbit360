[CmdletBinding()]
param([string]$SdkRoot, [ValidateSet('Release', 'RelWithDebInfo')][string]$Configuration = 'Release')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configPath = Join-Path $repoRoot '.local/config.json'
if (-not $SdkRoot -and (Test-Path -LiteralPath $configPath)) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.PSObject.Properties.Name -contains 'sdkRoot') { $SdkRoot = $config.sdkRoot }
}
if (-not $SdkRoot) { $SdkRoot = $env:INSTA360_MEDIA_SDK }
if (-not $SdkRoot) { throw 'Supply -SdkRoot or run setup-sdk.ps1 first.' }
$SdkRoot = (Resolve-Path -LiteralPath $SdkRoot).Path
$cmakeCommand = Get-Command cmake -ErrorAction SilentlyContinue
if ($cmakeCommand) { $cmake = $cmakeCommand.Source }
else {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Install Visual Studio Build Tools with Desktop development with C++ and CMake.' }
    $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsRoot) { throw 'An MSVC x64 C++ toolchain was not found.' }
    $cmake = Join-Path $vsRoot 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
    if (-not (Test-Path -LiteralPath $cmake)) { throw 'CMake was not found; add the CMake tools component to Visual Studio Build Tools.' }
}
$buildDir = Join-Path $repoRoot '.local/native-build'
& $cmake -S (Join-Path $repoRoot 'native') -B $buildDir -A x64 "-DINSTA360_MEDIA_SDK=$SdkRoot"
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed.' }
& $cmake --build $buildDir --config $Configuration
if ($LASTEXITCODE -ne 0) { throw 'Native compilation failed.' }
$exe = Join-Path $buildDir "$Configuration/orbit360-stitch.exe"
& $exe --help
if ($LASTEXITCODE -ne 0) { throw 'Native bridge help check failed.' }
Write-Host "Native bridge built: $exe"
Write-Host 'The bridge has not replaced the configured sample adapter. SDK binaries remain private.'
