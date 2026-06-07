[CmdletBinding()]
param(
    [switch]$Restart,
    [switch]$OpenBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$serverPath = Join-Path $root 'backend'
$frontendPath = Join-Path $root 'frontend'
$runtimePath = Join-Path $root '.runtime'
$logPath = Join-Path $runtimePath 'logs'
$startupLog = Join-Path $logPath 'startup.log'

New-Item -ItemType Directory -Path $logPath -Force | Out-Null

function Write-AppLog {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    Add-Content -LiteralPath $startupLog -Value $line
    Write-Output $line
}

function Test-TcpPort {
    param(
        [int]$Port,
        [int]$TimeoutMilliseconds = 700
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $asyncResult = $client.BeginConnect('localhost', $Port, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return $false
        }
        $client.EndConnect($asyncResult)
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Test-HttpEndpoint {
    param([string]$Uri)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
    } catch {
        return $false
    }
}

function Wait-Until {
    param(
        [scriptblock]$Condition,
        [int]$TimeoutSeconds,
        [string]$Description
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) {
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "Timed out waiting for $Description."
}

function Save-ManagedProcess {
    param(
        [string]$Name,
        [System.Diagnostics.Process]$Process
    )

    $record = @{
        id = $Process.Id
        startTimeTicks = $Process.StartTime.ToUniversalTime().Ticks
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json
    Set-Content -LiteralPath (Join-Path $runtimePath "$Name.pid.json") -Value $record -Encoding UTF8
}

function Stop-ManagedProcess {
    param([string]$Name)

    $pidPath = Join-Path $runtimePath "$Name.pid.json"
    if (-not (Test-Path $pidPath)) {
        return
    }

    try {
        $record = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
        $process = Get-Process -Id ([int]$record.id) -ErrorAction Stop
        $sameProcess = $process.StartTime.ToUniversalTime().Ticks -eq [long]$record.startTimeTicks
        if ($sameProcess -and $process.ProcessName -eq 'node') {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            Write-AppLog "Stopped $Name (PID $($process.Id))."
        }
    } catch {
        Write-AppLog "Could not stop $Name from ${pidPath}: $($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
}

function Start-ManagedProcess {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [string[]]$Arguments
    )

    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $stdout = Join-Path $logPath "$Name.out.log"
    $stderr = Join-Path $logPath "$Name.err.log"
    try {
        $process = Start-Process -FilePath $nodePath `
            -ArgumentList $Arguments `
            -WorkingDirectory $WorkingDirectory `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -PassThru
    } catch [System.ArgumentException] {
        if ($_.Exception.Message -notlike '*Path*PATH*' -and $_.Exception.Message -notlike '*PATH*Path*') {
            throw
        }

        $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $processInfo.FileName = $nodePath
        $processInfo.Arguments = ($Arguments | ForEach-Object {
            if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
        }) -join ' '
        $processInfo.WorkingDirectory = $WorkingDirectory
        $processInfo.UseShellExecute = $false
        $processInfo.CreateNoWindow = $true
        $process = [System.Diagnostics.Process]::Start($processInfo)
        Write-AppLog "Started $Name without redirected logs because the current shell has duplicate Path/PATH variables."
    }
    Save-ManagedProcess -Name $Name -Process $process
    Write-AppLog "Started $Name (PID $($process.Id))."
}

if (-not (Test-Path (Join-Path $serverPath 'node_modules'))) {
    throw 'Backend dependencies are missing. Run npm install --prefix backend once.'
}
if (-not (Test-Path (Join-Path $frontendPath 'node_modules'))) {
    throw 'Frontend dependencies are missing. Run npm install --prefix frontend once.'
}

if ($Restart) {
    Write-AppLog 'Restart requested. Stopping managed HuyPerfume processes.'
    Stop-ManagedProcess -Name 'api'
    Stop-ManagedProcess -Name 'frontend-user'
    Stop-ManagedProcess -Name 'frontend-admin'
    Start-Sleep -Seconds 2
}

if (-not (Test-HttpEndpoint 'http://localhost:4000/api/health/ready')) {
    Write-AppLog 'Waiting for SQL Server on port 1433.'
    Wait-Until -TimeoutSeconds 60 -Description 'SQL Server' -Condition { Test-TcpPort -Port 1433 }

    if (Test-TcpPort -Port 4000) {
        throw 'Port 4000 is occupied, but the HuyPerfume API is not ready. Check .runtime/logs.'
    }

    Start-ManagedProcess -Name 'api' -WorkingDirectory $serverPath -Arguments @('server.js')
    Wait-Until -TimeoutSeconds 45 -Description 'the API readiness endpoint' -Condition {
        Test-HttpEndpoint 'http://localhost:4000/api/health/ready'
    }
} else {
    Write-AppLog 'API is already ready.'
}

$viteScript = Join-Path $frontendPath 'node_modules\vite\bin\vite.js'
if (-not (Test-HttpEndpoint 'http://localhost:5177/home')) {
    if (Test-TcpPort -Port 5177) {
        throw 'Port 5177 is occupied, but the user frontend is not responding.'
    }
    Start-ManagedProcess -Name 'frontend-user' -WorkingDirectory $frontendPath -Arguments @($viteScript, '--mode', 'user', '--host', 'localhost')
    Wait-Until -TimeoutSeconds 30 -Description 'the user frontend' -Condition {
        Test-HttpEndpoint 'http://localhost:5177/home'
    }
} else {
    Write-AppLog 'User frontend is already ready.'
}

if (-not (Test-HttpEndpoint 'http://localhost:5178/')) {
    if (Test-TcpPort -Port 5178) {
        throw 'Port 5178 is occupied, but the admin frontend is not responding.'
    }
    Start-ManagedProcess -Name 'frontend-admin' -WorkingDirectory $frontendPath -Arguments @($viteScript, '--mode', 'admin', '--host', 'localhost')
    Wait-Until -TimeoutSeconds 30 -Description 'the admin frontend' -Condition {
        Test-HttpEndpoint 'http://localhost:5178/'
    }
} else {
    Write-AppLog 'Admin frontend is already ready.'
}

Write-AppLog 'HuyPerfume is ready: API :4000, user frontend :5177, admin frontend :5178.'

if ($OpenBrowser) {
    Start-Process 'http://localhost:5177/home'
}
