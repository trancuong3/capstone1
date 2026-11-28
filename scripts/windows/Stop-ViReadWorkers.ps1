# Stop all ViRead Windows workers (OCR Worker :8020 + autostart supervisor, Cloudflare Tunnels, and Voice Worker :8010).
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$OcrRuntimeDir = "F:\c1\tools\ocr-runtime",
    [string]$TunnelRuntimeDir = "F:\c1\viread-staging-tunnels",
    [int]$VoicePort = 8010,
    [int]$OcrPort = 8020
)

$ErrorActionPreference = "Continue"
$scriptDir = $PSScriptRoot

Write-Host "=== Stopping ViRead Windows Workers ===" -ForegroundColor Cyan

$stopOcr = Join-Path $scriptDir "Stop-ViReadOcrWorker.ps1"
if (Test-Path -LiteralPath $stopOcr) {
    & $stopOcr -OcrRuntimeDir $OcrRuntimeDir -Port $OcrPort
}

$stopTunnels = Join-Path $scriptDir "Stop-ViReadTunnels.ps1"
if (Test-Path -LiteralPath $stopTunnels) {
    & $stopTunnels -RuntimeDir $TunnelRuntimeDir
}

$stopVoice = Join-Path $scriptDir "Stop-ViReadVoiceWorker.ps1"
if (Test-Path -LiteralPath $stopVoice) {
    & $stopVoice -VoiceRuntimeDir $VoiceRuntimeDir -Port $VoicePort
}

Write-Host "All ViRead Windows workers stopped." -ForegroundColor Green
exit 0
