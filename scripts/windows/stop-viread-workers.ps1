# Unified safe stop script for ViRead Windows workers (Voice :8010 & OCR :8020 + Autostart Supervisor).
# Only terminates owned processes recorded in worker state files; never shuts down the machine.
param(
    [string]$VoiceRuntimeDir = "",
    [string]$OcrRuntimeDir = "",
    [int]$VoicePort = 8010,
    [int]$OcrPort = 8020,
    [switch]$SkipVoice,
    [switch]$SkipOcr,
    [switch]$IncludeTunnels
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$WorkspaceParent = Split-Path -Parent $RepoRoot
if ([string]::IsNullOrWhiteSpace($VoiceRuntimeDir)) {
    $VoiceRuntimeDir = if ($env:VIREAD_VOICE_RUNTIME_DIR) {
        $env:VIREAD_VOICE_RUNTIME_DIR
    } elseif ($env:VIREAD_VOICE_RUNTIME_ROOT) {
        $env:VIREAD_VOICE_RUNTIME_ROOT
    } else {
        Join-Path $WorkspaceParent "tools\voice-runtime"
    }
}
if ([string]::IsNullOrWhiteSpace($OcrRuntimeDir)) {
    $OcrRuntimeDir = if ($env:VIREAD_OCR_RUNTIME_DIR) { $env:VIREAD_OCR_RUNTIME_DIR } else { Join-Path $WorkspaceParent "tools\ocr-runtime" }
}

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
