[CmdletBinding()]
param(
    [int]$Port = 4000,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtimePath = Join-Path $root '.runtime'

function Test-HuyPerfumeApi {
    param([int]$TargetPort)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$TargetPort/api/health" -TimeoutSec 2
        return $response.Content -like '*huyperfume-server*'
    } catch {
        return $false
    }
}

function Get-PortOwners {
    param([int]$TargetPort)

    try {
        return @(Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        $lines = @(netstat -ano | Select-String -Pattern "[:.]$TargetPort\s+.*LISTENING\s+\d+")
        return @($lines | ForEach-Object {
            if ($_.Line -match '\s(\d+)\s*$') { [int]$matches[1] }
        } | Select-Object -Unique)
    }
}

$ownerIds = @(Get-PortOwners -TargetPort $Port)
if ($ownerIds.Count -eq 0) {
    Write-Output "Port $Port is free."
    return
}

$apiResponds = Test-HuyPerfumeApi -TargetPort $Port

foreach ($ownerId in $ownerIds) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue
    $commandLine = ''
    if ($processInfo -and $null -ne $processInfo.CommandLine) {
        $commandLine = [string]$processInfo.CommandLine
    }
    $looksLikeHuyPerfume =
        $apiResponds -or
        $commandLine -like "*$root*" -or
        $commandLine -match '(^|\s|\\)server\.js(\s|$)'

    if (-not $looksLikeHuyPerfume) {
        throw "Port $Port is used by PID $ownerId and it does not look like HuyPerfume. Stop it manually or change PORT."
    }

    if ($DryRun) {
        Write-Output "Would stop backend API on port $Port (PID $ownerId)."
        continue
    }

    Stop-Process -Id $ownerId -Force -ErrorAction Stop
    Write-Output "Stopped backend API on port $Port (PID $ownerId)."
}

Remove-Item -LiteralPath (Join-Path $runtimePath 'api.pid.json') -Force -ErrorAction SilentlyContinue
