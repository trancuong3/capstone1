# Unified safe stop script for ViRead Windows workers (Voice :8010 & OCR :8020).
# Only terminates owned processes recorded in worker state files; never shuts down the machine.
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$OcrRuntimeDir = "F:\c1\tools\ocr-runtime",
    [switch]$SkipVoice,
    [switch]$SkipOcr,
    [switch]$IncludeTunnels
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot

if (-not $SkipVoice) {
    & (Join-Path $scriptDir "Stop-ViReadVoiceWorker.ps1") -VoiceRuntimeDir $VoiceRuntimeDir
}
if (-not $SkipOcr) {
    & (Join-Path $scriptDir "Stop-ViReadOcrWorker.ps1") -OcrRuntimeDir $OcrRuntimeDir
}
if ($IncludeTunnels) {
    & (Join-Path $scriptDir "Stop-ViReadTunnels.ps1")
}

Write-Host "ViRead Windows workers stop sequence completed."
exit 0
