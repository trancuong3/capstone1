# Unified safe stop script for ViRead Windows workers (Voice :8010 & OCR :8020 + Autostart Supervisor).
# Only terminates owned processes recorded in worker state files; never shuts down the machine.
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$OcrRuntimeDir = "F:\c1\tools\ocr-runtime",
    [int]$VoicePort = 8010,
    [int]$OcrPort = 8020,
    [switch]$SkipVoice,
    [switch]$SkipOcr,
    [switch]$IncludeTunnels
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot

if (-not $SkipVoice) {
    & (Join-Path $scriptDir "Stop-ViReadVoiceWorker.ps1") -VoiceRuntimeDir $VoiceRuntimeDir -Port $VoicePort
}
if (-not $SkipOcr) {
    & (Join-Path $scriptDir "Stop-ViReadOcrWorker.ps1") -OcrRuntimeDir $OcrRuntimeDir -Port $OcrPort
}
if ($IncludeTunnels) {
    & (Join-Path $scriptDir "Stop-ViReadTunnels.ps1")
}

Write-Host "ViRead Windows workers stop sequence completed."
exit 0
