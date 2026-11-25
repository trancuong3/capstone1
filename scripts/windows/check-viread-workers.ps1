# Unified zero-secret status checker for ViRead Windows workers (Voice :8010 & OCR :8020).
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$OcrRuntimeDir = "F:\c1\tools\ocr-runtime",
    [string]$OcrPythonExe = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    [string]$BindHost = "127.0.0.1",
    [int]$VoicePort = 8010,
    [int]$OcrPort = 8020,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot

$voicePy = Join-Path $VoiceRuntimeDir ".venv\Scripts\python.exe"
$voiceJsonRaw = & (Join-Path $scriptDir "Get-ViReadVoiceWorkerStatus.ps1") -VoiceRuntimeDir $VoiceRuntimeDir -BindHost $BindHost -Port $VoicePort -AsJson
$voiceExit = $LASTEXITCODE
$ocrJsonRaw = & (Join-Path $scriptDir "Get-ViReadOcrWorkerStatus.ps1") -OcrRuntimeDir $OcrRuntimeDir -BindHost $BindHost -Port $OcrPort -AsJson
$ocrExit = $LASTEXITCODE

$voiceReport = $voiceJsonRaw | ConvertFrom-Json
$ocrReport = $ocrJsonRaw | ConvertFrom-Json

$summary = @{
    voice_python_present = (Test-Path $voicePy)
    ocr_python_present   = (Test-Path $OcrPythonExe)
    voice_worker         = $voiceReport
    ocr_worker           = $ocrReport
    all_healthy          = ($voiceExit -eq 0 -and $ocrExit -eq 0)
}

if ($AsJson) {
    $summary | ConvertTo-Json -Depth 8
} else {
    Write-Host "=== ViRead Unified Workers Check ==="
    Write-Host "Voice Python (.venv): $($summary.voice_python_present) | Port ${VoicePort} listening=$($voiceReport.listening)"
    Write-Host "OCR Python (Py3.12):  $($summary.ocr_python_present) | Port ${OcrPort} listening=$($ocrReport.listening)"
    Write-Host "All Healthy:          $($summary.all_healthy)"
}

if ($summary.all_healthy) { exit 0 }
exit 1
