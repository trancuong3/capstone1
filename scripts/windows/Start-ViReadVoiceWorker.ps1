# Start the standalone ViRead Local Voice Worker on 127.0.0.1:8010 (idempotent, AboveNormal priority).
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8010,
    [string]$TtsPrecision = "int8",
    [int]$StartupTimeoutSeconds = 90,
    [string]$VoiceWorkerToken = "",
    [ValidateSet("AboveNormal", "High", "Normal")]
    [string]$Priority = "AboveNormal"
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
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

function Set-ProcessTreePriority([int]$rootPid, [string]$priorityClass) {
    if ($rootPid -le 0) { return }
    try {
        $p = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
        if ($p -and -not $p.HasExited) {
            $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]$priorityClass
        }
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $rootPid" -ErrorAction SilentlyContinue
        foreach ($c in $children) {
            Set-ProcessTreePriority ([int]$c.ProcessId) $priorityClass
        }
    } catch { }
}

function Resolve-VoiceWorkerToken([string]$explicitToken) {
    if ($explicitToken -and $explicitToken.Trim()) {
        return $explicitToken.Trim()
    }
    $envToken = [Environment]::GetEnvironmentVariable("VIREAD_VOICE_WORKER_TOKEN", "Process")
    if ($envToken -and $envToken.Trim()) {
        return $envToken.Trim()
    }
    $backendEnv = Join-Path $repoRoot "backend\.env"
    if (Test-Path $backendEnv) {
        foreach ($line in (Get-Content $backendEnv -Encoding UTF8)) {
            $trimmed = $line.Trim()
            if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
            if ($trimmed -match "^VIREAD_VOICE_WORKER_TOKEN\s*=\s*(.*)$") {
                $val = $Matches[1].Trim()
                if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
                    $val = $val.Substring(1, $val.Length - 2)
                }
                if ($val.Trim()) { return $val.Trim() }
            }
        }
    }
    return ""
}

$effectiveToken = Resolve-VoiceWorkerToken $VoiceWorkerToken

# Idempotent check
try {
    $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
    if ($health -and $health.status -eq "ok") {
        $existingConn = Test-PortListening $Port
        if ($existingConn) {
            Set-ProcessTreePriority ([int]$existingConn.OwningProcess) $Priority
        }
        Write-Host "ViRead Local Voice Worker is already healthy on http://${BindHost}:${Port} (priority=$Priority)"
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
    "VIREAD_VOICE_WORKER_TOKEN"  = [Environment]::GetEnvironmentVariable("VIREAD_VOICE_WORKER_TOKEN", "Process")
    "HF_HOME"                    = [Environment]::GetEnvironmentVariable("HF_HOME", "Process")
}

try {
    [Environment]::SetEnvironmentVariable("VIREAD_VOICE_RUNTIME_DIR", $VoiceRuntimeDir, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_VOICE_WORKER_HOST", $BindHost, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_VOICE_WORKER_PORT", "$Port", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_VOICE_TTS_PRECISION", $TtsPrecision, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_VOICE_WORKER_TOKEN", $effectiveToken, "Process")
    [Environment]::SetEnvironmentVariable("HF_HOME", (Join-Path $VoiceRuntimeDir "hf-cache"), "Process")

    $proc = Start-Process -FilePath $pyExe -ArgumentList @($workerScript) `
        -WorkingDirectory $scriptDir -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    Set-ProcessTreePriority $proc.Id $Priority
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
Set-ProcessTreePriority $proc.Id $Priority
Set-ProcessTreePriority $listenPid $Priority
$listenProc = Get-Process -Id $listenPid -ErrorAction SilentlyContinue
$listenStart = if ($listenProc) { $listenProc.StartTime.ToUniversalTime().ToString("o") } else { "" }

@{
    workerPid       = $proc.Id
    workerStart     = $proc.StartTime.ToUniversalTime().ToString("o")
    listenPid       = $listenPid
    listenStart     = $listenStart
    host            = $BindHost
    port            = $Port
    priorityClass   = $Priority
    authRequired    = [bool]$effectiveToken
    voiceRuntimeDir = $VoiceRuntimeDir
    startedAt       = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content -Encoding UTF8 $stateFile

Write-Host "ViRead Local Voice Worker ready on http://${BindHost}:${Port} (PID=$listenPid, priority=$Priority, auth=$([bool]$effectiveToken))."
exit 0
