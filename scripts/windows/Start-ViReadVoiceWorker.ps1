# Start the standalone ViRead Local Voice Worker on 127.0.0.1:8010 (idempotent).
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8010,
    [string]$TtsPrecision = "fp32",
    [int]$StartupTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$workerScript = Join-Path $scriptDir "voice_worker.py"
$pyExe = Join-Path $VoiceRuntimeDir ".venv\Scripts\python.exe"
$logsDir = Join-Path $VoiceRuntimeDir "logs"
$stateFile = Join-Path $VoiceRuntimeDir "worker-state.json"

if (-not (Test-Path $pyExe)) {
    [Console]::Error.WriteLine("Voice runtime Python not found at $pyExe. Run scripts\windows\Download-ViReadVoiceModels.ps1 first.")
    exit 2
}

New-Item -ItemType Directory -Force -Path $VoiceRuntimeDir, $logsDir | Out-Null

function Test-PortListening([int]$p) {
    return Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

# Idempotent check
try {
    $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
    if ($health -and $health.status -eq "ok") {
        Write-Host "ViRead Local Voice Worker is already healthy on http://${BindHost}:${Port}"
        exit 0
    }
} catch { }

$existing = Test-PortListening $Port
if ($existing) {
    [Console]::Error.WriteLine("Port conflict: Voice worker port $Port is already in use by PID $($existing.OwningProcess).")
    exit 4
}

$stdoutLog = Join-Path $logsDir "voice-worker.stdout.log"
$stderrLog = Join-Path $logsDir "voice-worker.stderr.log"

$savedEnv = @{
    "VIREAD_VOICE_RUNTIME_DIR"   = [Environment]::GetEnvironmentVariable("VIREAD_VOICE_RUNTIME_DIR", "Process")
    "VIREAD_VOICE_WORKER_HOST"   = [Environment]::GetEnvironmentVariable("VIREAD_VOICE_WORKER_HOST", "Process")
    "VIREAD_VOICE_WORKER_PORT"   = [Environment]::GetEnvironmentVariable("VIREAD_VOICE_WORKER_PORT", "Process")
    "VIREAD_VOICE_TTS_PRECISION" = [Environment]::GetEnvironmentVariable("VIREAD_VOICE_TTS_PRECISION", "Process")
    "HF_HOME"                    = [Environment]::GetEnvironmentVariable("HF_HOME", "Process")
}

try {
    [Environment]::SetEnvironmentVariable("VIREAD_VOICE_RUNTIME_DIR", $VoiceRuntimeDir, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_VOICE_WORKER_HOST", $BindHost, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_VOICE_WORKER_PORT", "$Port", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_VOICE_TTS_PRECISION", $TtsPrecision, "Process")
    [Environment]::SetEnvironmentVariable("HF_HOME", (Join-Path $VoiceRuntimeDir "hf-cache"), "Process")

    $proc = Start-Process -FilePath $pyExe -ArgumentList @($workerScript) `
        -WorkingDirectory $scriptDir -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
} finally {
    foreach ($kv in $savedEnv.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
    }
}

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) {
        [Console]::Error.WriteLine("Voice worker exited prematurely with code $($proc.ExitCode). Check $stderrLog")
        exit 5
    }
    try {
        $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
        if ($health -and $health.status -eq "ok") {
            $ready = $true
            break
        }
    } catch { }
    Start-Sleep -Milliseconds 600
}

if (-not $ready) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    [Console]::Error.WriteLine("Timed out waiting for Voice Worker readiness on http://${BindHost}:${Port}. Check $stderrLog")
    exit 6
}

$listenConn = Test-PortListening $Port
$listenPid = if ($listenConn) { [int]$listenConn.OwningProcess } else { $proc.Id }
$listenProc = Get-Process -Id $listenPid -ErrorAction SilentlyContinue
$listenStart = if ($listenProc) { $listenProc.StartTime.ToUniversalTime().ToString("o") } else { "" }

@{
    workerPid       = $proc.Id
    workerStart     = $proc.StartTime.ToUniversalTime().ToString("o")
    listenPid       = $listenPid
    listenStart     = $listenStart
    host            = $BindHost
    port            = $Port
    voiceRuntimeDir = $VoiceRuntimeDir
    startedAt       = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content -Encoding UTF8 $stateFile

Write-Host "ViRead Local Voice Worker ready on http://${BindHost}:${Port} (PID=$listenPid)."
exit 0
