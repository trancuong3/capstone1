# Start the standalone ViRead Remote OCR Worker on 127.0.0.1:8020 (idempotent, BelowNormal priority).
param(
    [string]$OcrRuntimeDir = "F:\c1\tools\ocr-runtime",
    [string]$PythonExe = "C:\Users\cuong\AppData\Local\Programs\Python\Python312\python.exe",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8020,
    [int]$CpuThreads = 2,
    [int]$StartupTimeoutSeconds = 120,
    [string]$BackendUrl = "",
    [string]$OcrWorkerToken = "",
    [ValidateSet("BelowNormal", "Idle", "Normal")]
    [string]$Priority = "BelowNormal",
    [string]$QuietStandby = "",
    [int]$QuietStandbyKeepaliveSeconds = 0,
    [int]$MaxIdlePollSeconds = 20,
    [switch]$AllowDegradedStart
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$logsDir = Join-Path $OcrRuntimeDir "logs"
$stateFile = Join-Path $OcrRuntimeDir "ocr-worker-state.json"

if (-not (Test-Path $PythonExe)) {
    [Console]::Error.WriteLine("OCR Python executable not found at $PythonExe.")
    exit 2
}

New-Item -ItemType Directory -Force -Path $OcrRuntimeDir, $logsDir | Out-Null

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

function Resolve-BackendSetting([string]$explicitVal, [string]$envKey) {
    if ($explicitVal -and $explicitVal.Trim()) {
        return $explicitVal.Trim()
    }
    $envVal = [Environment]::GetEnvironmentVariable($envKey, "Process")
    if ($envVal -and $envVal.Trim()) {
        return $envVal.Trim()
    }
    $backendEnv = Join-Path $repoRoot "backend\.env"
    if (Test-Path $backendEnv) {
        foreach ($line in (Get-Content $backendEnv -Encoding UTF8)) {
            $trimmed = $line.Trim()
            if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
            if ($trimmed -match "^$([regex]::Escape($envKey))\s*=\s*(.*)$") {
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

$effectiveBackendUrl = Resolve-BackendSetting $BackendUrl "VIREAD_OCR_BACKEND_URL"
$effectiveToken = Resolve-BackendSetting $OcrWorkerToken "VIREAD_OCR_WORKER_TOKEN"
$boundedThreads = [Math]::Max(1, [Math]::Min(4, $CpuThreads))
$resolvedQuietStandby = Resolve-BackendSetting $QuietStandby "VIREAD_OCR_QUIET_STANDBY"
if (-not $resolvedQuietStandby) {
    $resolvedQuietStandby = if ($effectiveBackendUrl -match "^https://") { "true" } else { "false" }
}
$resolvedKeepaliveEnv = Resolve-BackendSetting "" "VIREAD_OCR_QUIET_STANDBY_KEEPALIVE_SECONDS"
$effectiveKeepaliveSeconds = if ($PSBoundParameters.ContainsKey("QuietStandbyKeepaliveSeconds")) {
    [Math]::Max(0, $QuietStandbyKeepaliveSeconds)
} elseif ($resolvedKeepaliveEnv) {
    [Math]::Max(0, [int]$resolvedKeepaliveEnv)
} elseif ($resolvedQuietStandby -match "^(1|true|yes|on)$") {
    [Math]::Max(0, $QuietStandbyKeepaliveSeconds)
} else {
    0
}
$effectiveMaxIdlePollSeconds = [Math]::Max(5, [Math]::Min(60, $MaxIdlePollSeconds))

# Idempotent check
try {
    $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
    if ($health -and ($health.status -eq "ok" -or ($AllowDegradedStart -and $health.status -eq "degraded"))) {
        $existingConn = Test-PortListening $Port
        if ($existingConn) {
            Set-ProcessTreePriority ([int]$existingConn.OwningProcess) $Priority
        }
        Write-Host "ViRead Remote OCR Worker is already healthy on http://${BindHost}:${Port} (priority=$Priority, ready=$($health.ready))"
        exit 0
    }
} catch { }

$existing = Test-PortListening $Port
if ($existing) {
    [Console]::Error.WriteLine("Port conflict: OCR worker port $Port is already in use by PID $($existing.OwningProcess).")
    exit 4
}

$stdoutLog = Join-Path $logsDir "ocr-worker.stdout.log"
$stderrLog = Join-Path $logsDir "ocr-worker.stderr.log"

$envKeys = @(
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VIREAD_OCR_CPU_THREADS",
    "VIREAD_OCR_WORKER_HOST",
    "VIREAD_OCR_WORKER_PORT",
    "VIREAD_OCR_BACKEND_URL",
    "VIREAD_OCR_WORKER_TOKEN",
    "VIREAD_OCR_QUIET_STANDBY",
    "VIREAD_OCR_QUIET_STANDBY_KEEPALIVE_SECONDS",
    "VIREAD_OCR_MAX_IDLE_POLL_SECONDS",
    "PYTHONPATH",
    "DATABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_KEY"
)
$savedEnv = @{}
foreach ($k in $envKeys) {
    $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
}

try {
    [Environment]::SetEnvironmentVariable("OMP_NUM_THREADS", "$boundedThreads", "Process")
    [Environment]::SetEnvironmentVariable("OPENBLAS_NUM_THREADS", "$boundedThreads", "Process")
    [Environment]::SetEnvironmentVariable("MKL_NUM_THREADS", "$boundedThreads", "Process")
    [Environment]::SetEnvironmentVariable("NUMEXPR_NUM_THREADS", "$boundedThreads", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_CPU_THREADS", "$boundedThreads", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_WORKER_HOST", $BindHost, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_WORKER_PORT", "$Port", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_BACKEND_URL", $effectiveBackendUrl, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_WORKER_TOKEN", $effectiveToken, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_QUIET_STANDBY", $resolvedQuietStandby, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_QUIET_STANDBY_KEEPALIVE_SECONDS", "$effectiveKeepaliveSeconds", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_MAX_IDLE_POLL_SECONDS", "$effectiveMaxIdlePollSeconds", "Process")
    [Environment]::SetEnvironmentVariable("PYTHONPATH", "$repoRoot;$repoRoot\backend", "Process")

    # Enforce zero DB / Supabase secrets on OCR worker process.
    [Environment]::SetEnvironmentVariable("DATABASE_URL", $null, "Process")
    [Environment]::SetEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY", $null, "Process")
    [Environment]::SetEnvironmentVariable("SUPABASE_SECRET_KEY", $null, "Process")
    [Environment]::SetEnvironmentVariable("SUPABASE_KEY", $null, "Process")

    $proc = Start-Process -FilePath $PythonExe `
        -ArgumentList @("-m", "ocr_worker.worker", "--host", $BindHost, "--port", "$Port") `
        -WorkingDirectory $repoRoot -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    Set-ProcessTreePriority $proc.Id $Priority
} finally {
    foreach ($kv in $savedEnv.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
    }
}

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$ready = $false
$lastHealth = $null
while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) {
        [Console]::Error.WriteLine("OCR worker exited prematurely with code $($proc.ExitCode). Check $stderrLog")
        exit 5
    }
    try {
        $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
        if ($health) {
            $lastHealth = $health
            if ($health.ready -eq $true -or ($AllowDegradedStart -and $health.status)) {
                $ready = $true
                break
            }
        }
    } catch { }
    Start-Sleep -Milliseconds 700
}

if (-not $ready) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    [Console]::Error.WriteLine("Timed out waiting for OCR Worker readiness on http://${BindHost}:${Port}. Check $stderrLog")
    exit 6
}

$listenConn = Test-PortListening $Port
$listenPid = if ($listenConn) { [int]$listenConn.OwningProcess } else { $proc.Id }
Set-ProcessTreePriority $proc.Id $Priority
Set-ProcessTreePriority $listenPid $Priority
$listenProc = Get-Process -Id $listenPid -ErrorAction SilentlyContinue
$listenStart = if ($listenProc) { $listenProc.StartTime.ToUniversalTime().ToString("o") } else { "" }

@{
    workerPid         = $proc.Id
    workerStart       = $proc.StartTime.ToUniversalTime().ToString("o")
    listenPid         = $listenPid
    listenStart       = $listenStart
    host              = $BindHost
    port              = $Port
    priorityClass     = $Priority
    cpuThreads        = $boundedThreads
    backendConfigured = [bool]$effectiveBackendUrl
    tokenConfigured   = [bool]$effectiveToken
    quietStandby      = $resolvedQuietStandby
    keepaliveSeconds  = $effectiveKeepaliveSeconds
    maxIdlePollSeconds = $effectiveMaxIdlePollSeconds
    ocrRuntimeDir     = $OcrRuntimeDir
    startedAt         = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content -Encoding UTF8 $stateFile

Write-Host "ViRead Remote OCR Worker ready on http://${BindHost}:${Port} (PID=$listenPid, priority=$Priority, threads=$boundedThreads, ready=$($lastHealth.ready))."
exit 0
