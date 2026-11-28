# Report status of the standalone or autostart-supervised ViRead Remote OCR Worker (never prints secrets).
param(
    [string]$OcrRuntimeDir = "",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8020,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WorkspaceParent = Split-Path -Parent $RepoRoot
if ([string]::IsNullOrWhiteSpace($OcrRuntimeDir)) {
    $OcrRuntimeDir = if ($env:VIREAD_OCR_RUNTIME_DIR) { $env:VIREAD_OCR_RUNTIME_DIR } else { Join-Path $WorkspaceParent "tools\ocr-runtime" }
}

$stateFile = Join-Path $OcrRuntimeDir "ocr-worker-state.json"
$autostartStateFile = Join-Path $OcrRuntimeDir "autostart-state.json"
$autostartStopFile = Join-Path $OcrRuntimeDir "autostart.stop"

$state = if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$autoState = if (Test-Path -LiteralPath $autostartStateFile) { Get-Content -LiteralPath $autostartStateFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$stopSentinelPresent = Test-Path -LiteralPath $autostartStopFile

$supervisorPid = if ($autoState -and $autoState.PSObject.Properties["supervisorPid"] -and $null -ne $autoState.supervisorPid) { [int]$autoState.supervisorPid } else { $null }
$supervisorRunning = $false
if ($supervisorPid -and $supervisorPid -gt 0) {
    $supProc = Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue
    if ($supProc -and (-not $supProc.HasExited) -and ($supProc.ProcessName -in @("powershell", "pwsh"))) {
        $supervisorRunning = $true
    }
}

$listening = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)

$health = $null
$version = $null
try {
    $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
} catch { }
try {
    $version = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/version" -TimeoutSec 3
} catch { }

$autostartReport = @{
    statePresent        = ($null -ne $autoState)
    stopSentinelPresent = $stopSentinelPresent
    supervisorPid       = $supervisorPid
    supervisorRunning   = $supervisorRunning
    workerPid           = if ($autoState -and $autoState.PSObject.Properties["workerPid"]) { $autoState.workerPid } else { $null }
    status              = if ($autoState -and $autoState.PSObject.Properties["status"]) { [string]$autoState.status } else { $null }
    repoRoot            = if ($autoState -and $autoState.PSObject.Properties["repoRoot"]) { $autoState.repoRoot } else { $null }
    pythonExe           = if ($autoState -and $autoState.PSObject.Properties["pythonExe"]) { $autoState.pythonExe } else { $null }
}

$report = @{
    endpoint     = "http://${BindHost}:${Port}"
    listening    = $listening
    statePresent = ($null -ne $state -or $null -ne $autoState)
    autostart    = $autostartReport
    health       = $health
    version      = $version
    logsDir      = Join-Path $OcrRuntimeDir "logs"
}

if ($AsJson) {
    $report | ConvertTo-Json -Depth 6
} else {
    Write-Host "=== ViRead Remote OCR Worker Status ==="
    Write-Host "Endpoint:  $($report.endpoint) (listening=$listening)"
    Write-Host "Autostart: state=$($autostartReport.statePresent) supervisorRunning=$supervisorRunning (pid=$supervisorPid, status=$($autostartReport.status), stopSentinel=$stopSentinelPresent)"
    if ($health) {
        $modelProfile = if ($health.model) { $health.model.profile } else { "unknown" }
        $priority = if ($health.system) { $health.system.process_priority } else { "unknown" }
        Write-Host "Status:    $($health.status) (ready=$($health.ready), worker_status=$($health.worker_status)) | Model=$modelProfile | ActiveJobs=$($health.active_job_count)/$($health.concurrency_limit) | Priority=$priority"
        if ($health.engines) {
            Write-Host "Engines:   paddleocr=$($health.engines.paddleocr.detail_status) | vietocr=$($health.engines.vietocr.detail_status) | tesseract_vie=$($health.engines.tesseract_vie.detail_status)"
        }
    } else {
        Write-Host "Status:    UNREACHABLE"
    }
    Write-Host "Logs:      $($report.logsDir)"
}

if ($listening -and $health -and $health.ready -eq $true) {
    exit 0
}
exit 1
