# Report status of ViRead local Windows host processes, ports, health, and OCR readiness.
# Never prints secrets, tokens, or passwords.
param(
    [string]$ConfigPath = "",
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
if (-not $ConfigPath) { $ConfigPath = Join-Path $scriptDir "viread-host.config.json" }
if (-not (Test-Path $ConfigPath)) {
    Write-Error "Config not found: $ConfigPath"
    exit 2
}

$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeDir = [string]$cfg.runtimeDir
$stateFile = Join-Path $runtimeDir "state.json"

function Get-ProcInfo([int]$pidVal) {
    if ($pidVal -le 0) { return @{ running = $false; pid = $null } }
    $p = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
    if (-not $p) { return @{ running = $false; pid = $pidVal } }
    return @{
        running = $true
        pid = $p.Id
        name = $p.ProcessName
        memoryMb = [math]::Round($p.WorkingSet64 / 1MB, 1)
    }
}

$state = if (Test-Path $stateFile) { Get-Content $stateFile -Raw | ConvertFrom-Json } else { $null }
$beHealth = $null
try {
    $beHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.backendPort)/health" -TimeoutSec 4
} catch { }

$report = @{
    configPath   = (Resolve-Path $ConfigPath).Path
    lanOrigin    = "https://$($cfg.lanHost):$($cfg.httpsPort)"
    lanApiUrl    = "https://$($cfg.lanHost):$($cfg.httpsPort)$($cfg.apiProxyPrefix)"
    statePresent = ($null -ne $state)
    processes    = @{
        backend  = if ($state) { Get-ProcInfo ([int]$state.backendPid) } else { @{ running = $false } }
        frontend = if ($state) { Get-ProcInfo ([int]$state.frontendPid) } else { @{ running = $false } }
        proxy    = if ($state) { Get-ProcInfo ([int]$state.proxyPid) } else { @{ running = $false } }
    }
    ports = @{
        backendListening  = [bool](Get-NetTCPConnection -LocalPort ([int]$cfg.backendPort) -State Listen -ErrorAction SilentlyContinue)
        frontendListening = [bool](Get-NetTCPConnection -LocalPort ([int]$cfg.frontendPort) -State Listen -ErrorAction SilentlyContinue)
        proxyListening    = [bool](Get-NetTCPConnection -LocalPort ([int]$cfg.httpsPort) -State Listen -ErrorAction SilentlyContinue)
    }
    backendHealth = $beHealth
    logsDir       = Join-Path $runtimeDir "logs"
    caCertPem     = Join-Path $runtimeDir "certs\viread-lan-ca.pem"
}

if ($AsJson) {
    $report | ConvertTo-Json -Depth 6
} else {
    Write-Host "=== ViRead Local Windows Host Status ==="
    Write-Host "LAN Origin: $($report.lanOrigin)"
    Write-Host "LAN API:    $($report.lanApiUrl)"
    Write-Host "Backend:    running=$($report.processes.backend.running) pid=$($report.processes.backend.pid) port=$($cfg.backendPort) listen=$($report.ports.backendListening)"
    Write-Host "Frontend:   running=$($report.processes.frontend.running) pid=$($report.processes.frontend.pid) port=$($cfg.frontendPort) listen=$($report.ports.frontendListening)"
    Write-Host "Proxy TLS:  running=$($report.processes.proxy.running) pid=$($report.processes.proxy.pid) port=$($cfg.httpsPort) listen=$($report.ports.proxyListening)"
    if ($beHealth) {
        Write-Host "Health:     status=$($beHealth.status) db=$($beHealth.database.status) ocr_ready=$($beHealth.ocr.ready)"
    } else {
        Write-Host "Health:     UNREACHABLE"
    }
    Write-Host "Logs:       $($report.logsDir)"
}

if ($report.processes.backend.running -and $report.processes.frontend.running -and $report.processes.proxy.running -and $beHealth -and $beHealth.ocr.ready) {
    exit 0
}
exit 1
