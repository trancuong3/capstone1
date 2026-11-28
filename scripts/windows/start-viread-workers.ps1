# Unified Windows One-Click Launcher for ViRead Voice Worker (:8010), Cloudflare Tunnel, and CUDA OCR Worker (:8020).
# Zero hardcoded secrets: reads tokens/URLs from parameters, environment variables, backend\.env, or F:\c1\tools\viread-workers.env.
param(
    [Alias("OcrPythonExe")]
    [string]$OcrVenvPython = $(if (Test-Path -LiteralPath "F:\c1\capstone1\.venv\Scripts\python.exe") { "F:\c1\capstone1\.venv\Scripts\python.exe" } else { "C:\Users\cuong\AppData\Local\Programs\Python\Python312\python.exe" }),
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$OcrRuntimeDir = "F:\c1\tools\ocr-runtime",
    [string]$TunnelRuntimeDir = "F:\c1\viread-staging-tunnels",
    [string]$CloudflaredExe = "C:\Program Files (x86)\cloudflared\cloudflared.exe",
    [string]$BindHost = "127.0.0.1",
    [int]$VoicePort = 8010,
    [int]$OcrPort = 8020,
    [int]$OcrCpuThreads = 2,
    [int]$OcrStartupTimeoutSeconds = 240,
    [string]$TtsPrecision = "int8",
    [string]$SttMode = "ws",
    [string]$LocalEnvFile = "",
    [string]$BackendUrl = "",
    [string]$OcrWorkerToken = "",
    [string]$VoiceWorkerToken = "",
    [switch]$SkipVoice,
    [switch]$SkipOcr,
    [switch]$SkipTunnel,
    [switch]$SkipBackendHealthCheck,
    [Alias("ReplaceIncompatibleWorker")]
    [switch]$ReplaceIncompatibleVoiceWorker,
    [Alias("AllowDegradedOcrStart")]
    [switch]$AllowDegradedStart,
    [switch]$AllowCpuOcrFallback,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$voicePyExe = Join-Path $VoiceRuntimeDir ".venv\Scripts\python.exe"

function Write-Section([string]$title) {
    Write-Host ""
    Write-Host "=== $title ===" -ForegroundColor Cyan
}

function Write-CheckOk([string]$msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-CheckWarn([string]$msg) {
    Write-Host "  [WARN] $msg" -ForegroundColor Yellow
}

function Write-CheckFail([string]$msg) {
    [Console]::Error.WriteLine("  [FAIL] $msg")
}

function Resolve-Setting([string]$explicitVal, [string]$envKey, [string]$fallbackEnvKey = "") {
    if ($explicitVal -and $explicitVal.Trim()) {
        return $explicitVal.Trim()
    }
    foreach ($candidateKey in @($envKey, $fallbackEnvKey)) {
        if (-not $candidateKey) { continue }
        $val = [Environment]::GetEnvironmentVariable($candidateKey, "Process")
        if ($val -and $val.Trim()) {
            return $val.Trim()
        }
    }
    $envCandidates = New-Object System.Collections.Generic.List[string]
    if ($LocalEnvFile -and $LocalEnvFile.Trim()) {
        $envCandidates.Add($LocalEnvFile.Trim())
    }
    $envCandidates.Add((Join-Path $repoRoot "backend\.env"))
    $envCandidates.Add("F:\c1\tools\viread-workers.env")
    $envCandidates.Add("F:\c1\capstone1\backend\.env")

    foreach ($candidateKey in @($envKey, $fallbackEnvKey)) {
        if (-not $candidateKey) { continue }
        foreach ($envFile in ($envCandidates | Select-Object -Unique)) {
            if (-not (Test-Path -LiteralPath $envFile)) { continue }
            foreach ($rawLine in [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)) {
                if ($null -eq $rawLine) { continue }
                $trimmed = $rawLine.TrimStart([char]0xFEFF).Trim()
                if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
                if ($trimmed -match "^(?:export\s+)?$([regex]::Escape($candidateKey))\s*=\s*(.*)$") {
                    $parsed = $Matches[1].Trim()
                    if (($parsed.StartsWith('"') -and $parsed.EndsWith('"') -and $parsed.Length -ge 2) -or
                        ($parsed.StartsWith("'") -and $parsed.EndsWith("'") -and $parsed.Length -ge 2)) {
                        $parsed = $parsed.Substring(1, $parsed.Length - 2)
                    }
                    if ($parsed.Trim()) { return $parsed.Trim() }
                }
            }
        }
    }
    return ""
}

if (-not $PSBoundParameters.ContainsKey("OcrVenvPython")) {
    $configuredOcrPy = Resolve-Setting "" "VIREAD_OCR_PYTHON_EXE"
    if ($configuredOcrPy -and (Test-Path -LiteralPath $configuredOcrPy)) {
        $OcrVenvPython = $configuredOcrPy
    }
}

function Get-ListeningOwner([int]$portNum) {
    $conn = Get-NetTCPConnection -LocalPort $portNum -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    $ownerPid = [int]$conn.OwningProcess
    $cmdLine = ""
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
        if ($cim -and $cim.CommandLine) { $cmdLine = [string]$cim.CommandLine }
    } catch { }
    return [PSCustomObject]@{
        Port        = $portNum
        Pid         = $ownerPid
        CommandLine = $cmdLine
    }
}

function Invoke-PythonProbe([string]$pythonExe, [string]$code) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = ($code | & $pythonExe - 2>&1)
        return [PSCustomObject]@{
            ExitCode = $LASTEXITCODE
            Output   = @($output | ForEach-Object { $_.ToString() })
        }
    } finally {
        $ErrorActionPreference = $prevEap
    }
}

Write-Section "1. Pre-flight Validation (CUDA OCR venv, Voice runtime, Models, Ports)"

# 1a. Validate CUDA OCR venv + ABI pins (must use CUDA venv, NOT CPU system python)
if (-not $SkipOcr) {
    if (-not (Test-Path -LiteralPath $OcrVenvPython)) {
        Write-CheckFail "CUDA OCR Python venv not found at '$OcrVenvPython'."
        exit 2
    }
    $env:LMDB_FORCE_CPYTHON = "1"
    $ocrProbeCode = @'
import importlib.metadata as md, importlib.util as iu, json, os, sys
os.environ.setdefault("LMDB_FORCE_CPYTHON", "1")
import torch
required_modules = ("torch", "paddle", "paddleocr", "vietocr", "cv2", "numpy", "pytesseract", "google.protobuf")
missing_modules = [m for m in required_modules if iu.find_spec(m) is None]
if missing_modules:
    raise RuntimeError(f"Missing required OCR packages: {', '.join(missing_modules)}")
info = {
    "python": sys.executable,
    "torch": torch.__version__,
    "cuda_available": bool(torch.cuda.is_available()),
    "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    "numpy": md.version("numpy"),
    "protobuf": md.version("protobuf"),
    "opencv": md.version("opencv-python-headless"),
    "pytesseract": md.version("pytesseract"),
    "paddlepaddle": md.version("paddlepaddle"),
    "paddleocr": md.version("paddleocr"),
    "vietocr": md.version("vietocr"),
}
print(json.dumps(info))
'@
    $ocrProbeRes = Invoke-PythonProbe -pythonExe $OcrVenvPython -code $ocrProbeCode
    if ($ocrProbeRes.ExitCode -ne 0) {
        Write-CheckFail "Failed probing CUDA OCR venv ($OcrVenvPython): $($ocrProbeRes.Output -join "`n")"
        exit 2
    }
    $ocrProbeJson = ($ocrProbeRes.Output | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1) | ConvertFrom-Json
    $expectedPins = @{
        numpy       = "1.26.4"
        protobuf    = "3.20.2"
        opencv      = "4.10.0.84"
        pytesseract = "0.3.13"
    }
    foreach ($kv in $expectedPins.GetEnumerator()) {
        $actual = [string]$ocrProbeJson.($kv.Key)
        if ($actual -ne $kv.Value) {
            Write-CheckFail "OCR ABI pin mismatch for $($kv.Key): expected $($kv.Value), got $actual"
            exit 2
        }
    }
    if (-not $ocrProbeJson.cuda_available) {
        if ($AllowCpuOcrFallback) {
            Write-CheckWarn "torch.cuda.is_available()=False in $OcrVenvPython (continuing due to -AllowCpuOcrFallback)"
        } else {
            Write-CheckFail "OCR venv $OcrVenvPython does not have CUDA enabled (torch=$($ocrProbeJson.torch)). Use F:\c1\capstone1\.venv or pass -AllowCpuOcrFallback."
            exit 2
        }
    } else {
        Write-CheckOk "OCR CUDA venv valid: torch=$($ocrProbeJson.torch) gpu='$($ocrProbeJson.gpu_name)' numpy=$($ocrProbeJson.numpy) protobuf=$($ocrProbeJson.protobuf) cv2=$($ocrProbeJson.opencv) pytesseract=$($ocrProbeJson.pytesseract)"
    }
}

# 1b. Validate Voice runtime venv
if (-not $SkipVoice) {
    if (-not (Test-Path -LiteralPath $voicePyExe)) {
        Write-CheckFail "Voice runtime Python not found at '$voicePyExe'. Run scripts\windows\Download-ViReadVoiceModels.ps1 first."
        exit 2
    }
    $voiceProbeCode = @'
import importlib.util as iu, json
required_modules = ("vieneu", "sherpa_onnx", "onnxruntime")
missing_modules = [m for m in required_modules if iu.find_spec(m) is None]
if missing_modules:
    raise RuntimeError(f"Missing required Voice packages: {', '.join(missing_modules)}")
print(json.dumps({"ok": True}))
'@
    $voiceProbeRes = Invoke-PythonProbe -pythonExe $voicePyExe -code $voiceProbeCode
    if ($voiceProbeRes.ExitCode -ne 0) {
        Write-CheckFail "Voice runtime validation failed ($voicePyExe): $($voiceProbeRes.Output -join "`n")"
        exit 2
    }
    Write-CheckOk "Voice runtime venv valid: $voicePyExe"
}

# 1c. Validate local models presence
if (-not $SkipVoice) {
    $sherpaDir = Join-Path $VoiceRuntimeDir "models\sherpa-onnx-zipformer-vi-30M-int8-2026-02-09"
    if (Test-Path -LiteralPath $sherpaDir) {
        Write-CheckOk "Sherpa-ONNX Vietnamese STT model present at $sherpaDir"
    } else {
        Write-CheckWarn "Sherpa-ONNX model directory not found at $sherpaDir (worker may attempt download or mark STT degraded)"
    }

    $hfCacheDir = Join-Path $VoiceRuntimeDir "hf-cache"
    if (Test-Path -LiteralPath $hfCacheDir) {
        Write-CheckOk "VieNeu TTS HuggingFace cache present at $hfCacheDir"
    } else {
        Write-CheckWarn "VieNeu HF cache directory not found at $hfCacheDir"
    }
}

if (-not $SkipOcr) {
    $paddleCacheDir = Join-Path $env:USERPROFILE ".paddleocr\whl"
    if (Test-Path -LiteralPath $paddleCacheDir) {
        Write-CheckOk "PaddleOCR model cache present at $paddleCacheDir"
    } else {
        Write-CheckWarn "PaddleOCR model cache not found at $paddleCacheDir (first warmup will download weights)"
    }
}

# 1d. Validate cloudflared if tunnel enabled
$resolvedCloudflared = $CloudflaredExe
if (-not $SkipTunnel -and -not $SkipVoice) {
    if (-not (Test-Path -LiteralPath $resolvedCloudflared)) {
        $cfCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
        if ($cfCmd -and (Test-Path -LiteralPath $cfCmd.Source)) {
            $resolvedCloudflared = $cfCmd.Source
        } else {
            Write-CheckFail "cloudflared executable not found at '$CloudflaredExe' or PATH."
            exit 2
        }
    }
    Write-CheckOk "cloudflared found: $resolvedCloudflared"
}

# 1e. Check ports and duplicate process diagnostics
if (-not $SkipVoice) {
    $voiceOwner = Get-ListeningOwner $VoicePort
    if ($voiceOwner) {
        if ($voiceOwner.CommandLine -match "voice_worker\.py") {
            Write-CheckOk "Port :$VoicePort already owned by ViRead voice_worker.py (PID=$($voiceOwner.Pid)); will reuse idempotently"
        } else {
            Write-CheckFail "Port :$VoicePort is occupied by foreign process PID=$($voiceOwner.Pid) ($($voiceOwner.CommandLine))"
            exit 4
        }
    } else {
        Write-CheckOk "Port :$VoicePort is free"
    }
}

if (-not $SkipOcr) {
    $ocrOwner = Get-ListeningOwner $OcrPort
    if ($ocrOwner) {
        if ($ocrOwner.CommandLine -match "ocr_worker\.worker") {
            $existingOcrReady = $false
            try {
                $oh = Invoke-RestMethod -Uri "http://${BindHost}:${OcrPort}/health" -TimeoutSec 3
                if ($oh -and $oh.ready -eq $true) { $existingOcrReady = $true }
            } catch { }
            if ($existingOcrReady) {
                Write-CheckOk "Port :$OcrPort already owned by healthy ViRead ocr_worker (PID=$($ocrOwner.Pid)); will reuse idempotently"
            } else {
                Write-CheckWarn "Port :$OcrPort owned by unhealthy/degraded ViRead ocr_worker (PID=$($ocrOwner.Pid)); Start-ViReadOcrWorker will replace it cleanly"
            }
        } else {
            Write-CheckFail "Port :$OcrPort is occupied by foreign process PID=$($ocrOwner.Pid) ($($ocrOwner.CommandLine))"
            exit 4
        }
    } else {
        Write-CheckOk "Port :$OcrPort is free"
    }
}

$effectiveBackendUrl = Resolve-Setting $BackendUrl "VIREAD_OCR_BACKEND_URL" "VIREAD_BACKEND_URL"
$effectiveOcrToken = Resolve-Setting $OcrWorkerToken "VIREAD_OCR_WORKER_TOKEN"
$effectiveVoiceToken = Resolve-Setting $VoiceWorkerToken "VIREAD_VOICE_WORKER_TOKEN" "VIREAD_LOCAL_VOICE_WORKER_TOKEN"

if (-not $SkipOcr) {
    if ($effectiveBackendUrl) {
        Write-CheckOk "Target Backend URL resolved: $effectiveBackendUrl"
    } else {
        Write-CheckWarn "VIREAD_OCR_BACKEND_URL/VIREAD_BACKEND_URL is not set; OCR worker will start in local-health-only mode until backend URL + token are configured."
    }
    if ($effectiveOcrToken.Length -ge 32) {
        Write-CheckOk "VIREAD_OCR_WORKER_TOKEN configured (length=$($effectiveOcrToken.Length), redacted)"
    } elseif ($effectiveBackendUrl) {
        Write-CheckWarn "VIREAD_OCR_WORKER_TOKEN is missing or shorter than 32 chars; outbound OCR claims will fail auth."
    }
}

if ($ValidateOnly) {
    Write-Host ""
    Write-Host "Pre-flight validation complete (-ValidateOnly). Exiting without starting workers." -ForegroundColor Green
    exit 0
}

if (-not $SkipVoice) {
    Write-Section "2. Starting Voice Worker (:$VoicePort, AboveNormal Priority)"
    $voiceArgs = @{
        VoiceRuntimeDir = $VoiceRuntimeDir
        BindHost        = $BindHost
        Port            = $VoicePort
        TtsPrecision    = $TtsPrecision
        SttMode         = $SttMode
        Priority        = "AboveNormal"
    }
    if ($effectiveVoiceToken) {
        $voiceArgs["VoiceWorkerToken"] = $effectiveVoiceToken
    }
    if ($ReplaceIncompatibleVoiceWorker) {
        $voiceArgs["ReplaceIncompatibleWorker"] = $true
    }
    & (Join-Path $scriptDir "Start-ViReadVoiceWorker.ps1") @voiceArgs
    if ($LASTEXITCODE -ne 0) {
        Write-CheckFail "Start-ViReadVoiceWorker.ps1 failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}

$voicePublicUrl = ""
$tunnelMode = "skipped"
if (-not $SkipTunnel -and -not $SkipVoice) {
    Write-Section "3. Starting Cloudflare HTTPS Tunnel (Voice :$VoicePort)"
    $tunnelRaw = & (Join-Path $scriptDir "Start-ViReadTunnels.ps1") `
        -CloudflaredExe $resolvedCloudflared `
        -RuntimeDir $TunnelRuntimeDir `
        -VoicePort $VoicePort `
        -VoiceOnly `
        -AsJson
    if ($LASTEXITCODE -ne 0) {
        Write-CheckFail "Start-ViReadTunnels.ps1 failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
    try {
        $tunnelObj = ($tunnelRaw -join "`n") | ConvertFrom-Json
        if ($tunnelObj -and $tunnelObj.tunnels -and $tunnelObj.tunnels.voice) {
            $voicePublicUrl = [string]$tunnelObj.tunnels.voice
        }
        $namedVoiceToken = [Environment]::GetEnvironmentVariable("VIREAD_CLOUDFLARED_VOICE_TOKEN", "Process")
        $tunnelMode = if ($namedVoiceToken -and $namedVoiceToken.Trim()) { "named_tunnel" } else { "quick_tunnel" }
        Write-CheckOk "Voice HTTPS tunnel ready ($tunnelMode): $voicePublicUrl -> http://${BindHost}:${VoicePort}"
    } catch {
        Write-CheckWarn "Tunnel started but JSON output could not be parsed; check $TunnelRuntimeDir\tunnel-urls.json"
    }
}

if (-not $SkipOcr) {
    Write-Section "4. Starting Outbound HTTPS CUDA OCR Worker (:$OcrPort, BelowNormal Priority)"
    $ocrArgs = @{
        OcrRuntimeDir         = $OcrRuntimeDir
        PythonExe             = $OcrVenvPython
        BindHost              = $BindHost
        Port                  = $OcrPort
        CpuThreads            = $OcrCpuThreads
        StartupTimeoutSeconds = $OcrStartupTimeoutSeconds
        Priority              = "BelowNormal"
    }
    if ($effectiveBackendUrl) {
        $ocrArgs["BackendUrl"] = $effectiveBackendUrl
    }
    if ($effectiveOcrToken) {
        $ocrArgs["OcrWorkerToken"] = $effectiveOcrToken
    }
    if ($AllowDegradedStart) {
        $ocrArgs["AllowDegradedStart"] = $true
    }
    & (Join-Path $scriptDir "Start-ViReadOcrWorker.ps1") @ocrArgs
    if ($LASTEXITCODE -ne 0) {
        Write-CheckFail "Start-ViReadOcrWorker.ps1 failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}

Write-Section "5. Health & Heartbeat Verification"
$voiceHeaders = @{}
if ($effectiveVoiceToken) {
    $voiceHeaders["Authorization"] = "Bearer $effectiveVoiceToken"
    $voiceHeaders["X-ViRead-Voice-Token"] = $effectiveVoiceToken
}
if (-not $SkipVoice) {
    try {
        $vHealth = Invoke-RestMethod -Uri "http://${BindHost}:${VoicePort}/health" -Headers $voiceHeaders -TimeoutSec 5
        Write-CheckOk "Voice Worker :$VoicePort status=$($vHealth.status) stt_ready=$($vHealth.stt_ready) tts_ready=$($vHealth.tts_ready)"
    } catch {
        Write-CheckFail "Voice Worker local /health check failed: $_"
        exit 6
    }
}

if (-not $SkipOcr) {
    try {
        $oHealth = Invoke-RestMethod -Uri "http://${BindHost}:${OcrPort}/health" -TimeoutSec 5
        Write-CheckOk "OCR Worker :$OcrPort status=$($oHealth.status) ready=$($oHealth.ready) cuda=$($oHealth.system.cuda_available) model=$($oHealth.model.profile)"
    } catch {
        Write-CheckFail "OCR Worker local /health check failed: $_"
        exit 6
    }
}

if ($voicePublicUrl) {
    try {
        $tHealth = Invoke-RestMethod -Uri "${voicePublicUrl}/health" -Headers $voiceHeaders -TimeoutSec 10
        Write-CheckOk "Public Voice Tunnel /health reachable: status=$($tHealth.status)"
    } catch {
        Write-CheckWarn "Public Voice Tunnel /health did not answer yet (DNS propagation may take a few seconds): $voicePublicUrl"
    }
}

if (-not $SkipOcr -and $effectiveBackendUrl -and (-not $SkipBackendHealthCheck)) {
    $backendHealthUrl = $effectiveBackendUrl.TrimEnd("/") + "/health"
    $hbVerified = $false
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            $bHealth = Invoke-RestMethod -Uri $backendHealthUrl -TimeoutSec 12
            $onlineWorkers = @()
            if ($bHealth -and $bHealth.ocr -and $bHealth.ocr.workers) {
                $onlineWorkers = @($bHealth.ocr.workers | Where-Object { $_.online -eq $true })
            }
            if ($onlineWorkers.Count -gt 0 -or ($bHealth -and $bHealth.ocr -and $bHealth.ocr.ready -eq $true)) {
                Write-CheckOk "Backend $backendHealthUrl healthy (ocr_mode=$($bHealth.ocr_mode), ocr.ready=$($bHealth.ocr.ready), online_workers=$($onlineWorkers.Count))"
                $hbVerified = $true
                break
            }
            Write-Host "  Waiting for OCR worker heartbeat on $backendHealthUrl (attempt $attempt/5)..."
        } catch {
            Write-CheckWarn "Backend /health probe attempt $attempt failed: $_"
        }
        Start-Sleep -Seconds 3
    }
    if (-not $hbVerified) {
        Write-CheckWarn "Backend /health reachable check did not confirm an online OCR worker heartbeat yet. Check $OcrRuntimeDir\logs\ocr-worker.stderr.log"
    }
}

Write-Section "ViRead Windows Workers Summary"
if (-not $SkipVoice) {
    Write-Host "  Voice Worker : http://${BindHost}:${VoicePort}/health"
}
if (-not $SkipOcr) {
    Write-Host "  OCR Worker   : http://${BindHost}:${OcrPort}/health (CUDA Python: $OcrVenvPython)"
}
if ($voicePublicUrl) {
    Write-Host "  Voice Tunnel : $voicePublicUrl ($tunnelMode)"
    if ($tunnelMode -eq "quick_tunnel") {
        Write-Host "  NOTE         : Quick Tunnel URL changes on restart. Set Render VIREAD_LOCAL_VOICE_WORKER_URL=$voicePublicUrl or configure VIREAD_CLOUDFLARED_VOICE_TOKEN + VIREAD_CLOUDFLARED_VOICE_URL for a static Named Tunnel." -ForegroundColor Yellow
    }
}
if ($effectiveBackendUrl) {
    Write-Host "  Backend URL  : $effectiveBackendUrl"
}
Write-Host "  Stop all     : .\scripts\windows\Stop-ViReadWorkers.ps1"
exit 0
