# Unified zero-secret launcher for ViRead Windows workers (Voice :8010 & OCR :8020).
# Reads secrets only from process env or an untracked local .env file; never logs secrets,
# never modifies global ExecutionPolicy, and never shuts down the machine.
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
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

function Import-UntrackedEnv([string]$envPath) {
    if (-not $envPath -or -not (Test-Path $envPath)) { return }
    foreach ($line in (Get-Content $envPath -Encoding UTF8)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
        $idx = $trimmed.IndexOf("=")
        if ($idx -le 0) { continue }
        $k = $trimmed.Substring(0, $idx).Trim()
        $v = $trimmed.Substring($idx + 1).Trim()
        if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        if ($k -and (-not [Environment]::GetEnvironmentVariable($k, "Process"))) {
            [Environment]::SetEnvironmentVariable($k, $v, "Process")
        }
    }
}

$resolvedEnv = if ($LocalEnvFile) { $LocalEnvFile } else { Join-Path $repoRoot "backend\.env" }
Import-UntrackedEnv $resolvedEnv

if (-not $SkipVoice) {
    $voicePy = Join-Path $VoiceRuntimeDir ".venv\Scripts\python.exe"
    if (-not (Test-Path $voicePy)) {
        [Console]::Error.WriteLine("Voice runtime Python missing at $voicePy. Run scripts\windows\Download-ViReadVoiceModels.ps1 first.")
        exit 2
    }
    $existingVoice = Get-NetTCPConnection -LocalPort $VoicePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existingVoice -and -not $ReplaceIncompatibleWorker) {
        Write-Host "Voice worker already listening on ${BindHost}:${VoicePort} (PID=$($existingVoice.OwningProcess)); skipping duplicate launch."
    } else {
        $voiceArgs = @{
            VoiceRuntimeDir = $VoiceRuntimeDir
            BindHost        = $BindHost
            Port            = $VoicePort
            TtsPrecision    = $TtsPrecision
            SttMode         = $SttMode
        }
        if ($ReplaceIncompatibleWorker) { $voiceArgs["ReplaceIncompatibleWorker"] = $true }
        & (Join-Path $scriptDir "Start-ViReadVoiceWorker.ps1") @voiceArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}

if (-not $SkipOcr) {
    if (-not (Test-Path $OcrPythonExe)) {
        [Console]::Error.WriteLine("OCR Python executable missing at $OcrPythonExe.")
        exit 2
    }
    $existingOcr = Get-NetTCPConnection -LocalPort $OcrPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existingOcr) {
        Write-Host "OCR worker already listening on ${BindHost}:${OcrPort} (PID=$($existingOcr.OwningProcess)); skipping duplicate launch."
    } else {
        $ocrArgs = @{
            OcrRuntimeDir = $OcrRuntimeDir
            PythonExe     = $OcrPythonExe
            BindHost      = $BindHost
            Port          = $OcrPort
        }
        if ($AllowDegradedOcrStart) { $ocrArgs["AllowDegradedStart"] = $true }
        & (Join-Path $scriptDir "Start-ViReadOcrWorker.ps1") @ocrArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}

if ($IncludeTunnels) {
    & (Join-Path $scriptDir "Start-ViReadTunnels.ps1")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "ViRead Windows workers started safely."
exit 0
