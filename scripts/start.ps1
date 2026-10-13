[CmdletBinding()]
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $appRoot
$appPort = if ($env:PORT) { [int]$env:PORT } else { 3600 }
$appUrl = "http://127.0.0.1:$appPort"
$localDir = Join-Path $appRoot '.local'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$existing = $false
try { $response = Invoke-WebRequest -Uri $appUrl -UseBasicParsing -TimeoutSec 2; $existing = $response.Content.Contains('orbit-token') } catch {}
if (-not $existing) {
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $serverScript = Join-Path $appRoot 'scripts/bootstrap.mjs'
    $serverProcess = Start-Process -FilePath $nodeExe -ArgumentList @('"' + $serverScript + '"', '--start') -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $localDir 'server.log') -RedirectStandardError (Join-Path $localDir 'server-error.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($serverProcess.HasExited) { throw "El servidor terminó. Revisa .local/server-error.log." }
        try { $response = Invoke-WebRequest -Uri $appUrl -UseBasicParsing -TimeoutSec 1; if ($response.Content.Contains('orbit-token')) { $ready = $true; break } } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'El servidor no respondió a tiempo. Revisa los registros en .local.' }
    Write-Host "Orbit360 en ejecución (PID $($serverProcess.Id)). Para cerrarlo: Stop-Process -Id $($serverProcess.Id)"
}
Write-Host $appUrl
if (-not $NoBrowser) { Start-Process $appUrl }
