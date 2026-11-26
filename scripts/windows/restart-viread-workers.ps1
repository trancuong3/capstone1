# Unified zero-secret restart script for ViRead Windows workers (Voice :8010 & OCR :8020).
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$OcrRuntimeDir = "F:\c1\tools\ocr-runtime",
    [string]$OcrPythonExe = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    [string]$BindHost = "127.0.0.1",
    [int]$VoicePort = 8010,
    [int]$OcrPort = 8020,
    [string]$TtsPrecision = "hybrid",
    [string]$SttMode = "ws",
    [string]$LocalEnvFile = "",
    [switch]$SkipVoice,
    [switch]$SkipOcr,
    [switch]$IncludeTunnels,
    [switch]$ReplaceIncompatibleWorker,
    [switch]$AllowDegradedOcrStart
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot

$stopArgs = @{
    VoiceRuntimeDir = $VoiceRuntimeDir
    OcrRuntimeDir   = $OcrRuntimeDir
}
if ($SkipVoice) { $stopArgs["SkipVoice"] = $true }
if ($SkipOcr) { $stopArgs["SkipOcr"] = $true }
if ($IncludeTunnels) { $stopArgs["IncludeTunnels"] = $true }

& (Join-Path $scriptDir "stop-viread-workers.ps1") @stopArgs

$startArgs = @{
    VoiceRuntimeDir = $VoiceRuntimeDir
    OcrRuntimeDir   = $OcrRuntimeDir
    OcrPythonExe    = $OcrPythonExe
    BindHost        = $BindHost
    VoicePort       = $VoicePort
    OcrPort         = $OcrPort
    TtsPrecision    = $TtsPrecision
    SttMode         = $SttMode
}
if ($LocalEnvFile) { $startArgs["LocalEnvFile"] = $LocalEnvFile }
if ($SkipVoice) { $startArgs["SkipVoice"] = $true }
if ($SkipOcr) { $startArgs["SkipOcr"] = $true }
if ($IncludeTunnels) { $startArgs["IncludeTunnels"] = $true }
if ($ReplaceIncompatibleWorker) { $startArgs["ReplaceIncompatibleWorker"] = $true }
if ($AllowDegradedOcrStart) { $startArgs["AllowDegradedOcrStart"] = $true }

& (Join-Path $scriptDir "start-viread-workers.ps1") @startArgs
exit $LASTEXITCODE
