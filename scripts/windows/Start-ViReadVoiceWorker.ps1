# Start the standalone ViRead Local Voice Worker on 127.0.0.1:8010 (idempotent).
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8010,
    [string]$TtsPrecision = "int8",
    [int]$StartupTimeoutSeconds = 90,
    [switch]$ReplaceIncompatibleWorker = $false
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

function Get-ProcessCommandLine([int]$pidNum) {
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $pidNum" -ErrorAction SilentlyContinue
        if ($cim -and $cim.CommandLine) {
            return [string]$cim.CommandLine
        }
    } catch { }
    return "(unknown command line)"
}

$rawWorkerToken = [Environment]::GetEnvironmentVariable("VIREAD_LOCAL_VOICE_WORKER_TOKEN", "Process")
$workerToken = if ($rawWorkerToken) { $rawWorkerToken.Trim() } else { "" }
$healthHeaders = @{}
if ($workerToken) {
    $healthHeaders["Authorization"] = "Bearer $workerToken"
    $healthHeaders["X-ViRead-Worker-Token"] = $workerToken
}

# Idempotent check (rejects incompatible auth-gated foreign workers when no token is configured)
$incompatibleWorker = $false
try {
    $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -Headers $healthHeaders -TimeoutSec 3
    if ($health -and $health.status -eq "ok") {
        $authRequired = [bool]($health.PSObject.Properties["auth_required"] -and $health.auth_required)
        if ($authRequired -and (-not $workerToken)) {
            $incompatibleWorker = $true
        } else {
            Write-Host "ViRead Local Voice Worker is already healthy on http://${BindHost}:${Port}"
            exit 0
        }
    }
} catch { }

$existing = Test-PortListening $Port
if ($existing) {
    $ownerPid = [int]$existing.OwningProcess
    $ownerCmd = Get-ProcessCommandLine $ownerPid
    if ($incompatibleWorker) {
        [Console]::Error.WriteLine("Incompatible voice worker detected on port $Port (auth_required=true without VIREAD_LOCAL_VOICE_WORKER_TOKEN). Owning PID=${ownerPid}, CommandLine=${ownerCmd}")
        if ($ReplaceIncompatibleWorker) {
            Write-Host "Stopping incompatible worker PID=${ownerPid} (-ReplaceIncompatibleWorker specified)..."
            Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
            $freeDeadline = (Get-Date).AddSeconds(5)
            while ((Get-Date) -lt $freeDeadline) {
                if (-not (Test-PortListening $Port)) { break }
                Start-Sleep -Milliseconds 250
            }
            if (Test-PortListening $Port) {
                [Console]::Error.WriteLine("Port $Port is still occupied after stopping PID=${ownerPid}.")
                exit 4
            }
        } else {
            [Console]::Error.WriteLine("Re-run with -ReplaceIncompatibleWorker to replace it, or stop PID=${ownerPid} / configure VIREAD_LOCAL_VOICE_WORKER_TOKEN.")
            exit 4
        }
    } else {
        [Console]::Error.WriteLine("Port conflict: Voice worker port $Port is already in use by PID=${ownerPid}, CommandLine=${ownerCmd}")
        exit 4
    }
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
