# Stop all ViRead Windows workers (OCR Worker :8020 + autostart supervisor, Cloudflare Tunnels, and Voice Worker :8010).
param(
    [string]$VoiceRuntimeDir = "",
    [string]$OcrRuntimeDir = "",
    [string]$TunnelRuntimeDir = "",
    [int]$VoicePort = 8010,
    [int]$OcrPort = 8020
)

$ErrorActionPreference = "Continue"
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
if ([string]::IsNullOrWhiteSpace($TunnelRuntimeDir)) {
    $TunnelRuntimeDir = Join-Path $WorkspaceParent "viread-staging-tunnels"
}

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
