# Report status of the standalone ViRead Remote OCR Worker (never prints secrets).
param(
    [string]$OcrRuntimeDir = "F:\c1\tools\ocr-runtime",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8020,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"

$stateFile = Join-Path $OcrRuntimeDir "ocr-worker-state.json"
$state = if (Test-Path $stateFile) { Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$listening = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)

$health = $null
$version = $null
try {
    $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
} catch { }
try {
    $version = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/version" -TimeoutSec 3
} catch { }

$report = @{
    endpoint     = "http://${BindHost}:${Port}"
    listening    = $listening
    statePresent = ($null -ne $state)
    health       = $health
    version      = $version
    logsDir      = Join-Path $OcrRuntimeDir "logs"
}

if ($AsJson) {
    $report | ConvertTo-Json -Depth 6
} else {
    Write-Host "=== ViRead Remote OCR Worker Status ==="
    Write-Host "Endpoint:  $($report.endpoint) (listening=$listening)"
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
