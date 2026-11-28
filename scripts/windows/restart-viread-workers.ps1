# Unified zero-secret restart script for ViRead Windows workers (Voice :8010 & OCR :8020).
param(
    [string]$VoiceRuntimeDir = "",
    [string]$OcrRuntimeDir = "",
    [string]$OcrPythonExe = "",
    [string]$BindHost = "127.0.0.1",
    [int]$VoicePort = 8010,
    [int]$OcrPort = 8020,
    [string]$TtsPrecision = "int8",
    [string]$SttMode = "ws",
    [string]$LocalEnvFile = "",
    [switch]$SkipVoice,
    [switch]$SkipOcr,
    [switch]$SkipTunnel,
    [switch]$IncludeTunnels,
    [switch]$ReplaceIncompatibleWorker,
    [switch]$AllowDegradedOcrStart
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
if ([string]::IsNullOrWhiteSpace($OcrPythonExe)) {
    $OcrPythonExe = @(
        (Join-Path $RepoRoot "backend\.venv\Scripts\python.exe"),
        (Join-Path $RepoRoot ".venv\Scripts\python.exe"),
        (Join-Path $WorkspaceParent ".venv\Scripts\python.exe")
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($OcrPythonExe)) {
        $OcrPythonExe = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
    }
}

$stopArgs = @{
    VoiceRuntimeDir = $VoiceRuntimeDir
    OcrRuntimeDir   = $OcrRuntimeDir
    VoicePort       = $VoicePort
    OcrPort         = $OcrPort
}
if ($SkipVoice) { $stopArgs["SkipVoice"] = $true }
if ($SkipOcr) { $stopArgs["SkipOcr"] = $true }
if ($IncludeTunnels) { $stopArgs["IncludeTunnels"] = $true }

& (Join-Path $scriptDir "stop-viread-workers.ps1") @stopArgs

$startArgs = @{
    VoiceRuntimeDir = $VoiceRuntimeDir
    OcrRuntimeDir   = $OcrRuntimeDir
    OcrVenvPython   = $OcrPythonExe
    BindHost        = $BindHost
    VoicePort       = $VoicePort
    OcrPort         = $OcrPort
    TtsPrecision    = $TtsPrecision
    SttMode         = $SttMode
}
if ($LocalEnvFile) { $startArgs["LocalEnvFile"] = $LocalEnvFile }
if ($SkipVoice) { $startArgs["SkipVoice"] = $true }
if ($SkipOcr) { $startArgs["SkipOcr"] = $true }
if ($SkipTunnel -or (-not $IncludeTunnels)) { $startArgs["SkipTunnel"] = $true }
if ($ReplaceIncompatibleWorker) { $startArgs["ReplaceIncompatibleVoiceWorker"] = $true }
if ($AllowDegradedOcrStart) { $startArgs["AllowDegradedStart"] = $true }

& (Join-Path $scriptDir "start-viread-workers.ps1") @startArgs
exit $LASTEXITCODE
