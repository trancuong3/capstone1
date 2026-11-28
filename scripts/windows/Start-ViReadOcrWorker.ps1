# Start the standalone ViRead Remote OCR Worker on 127.0.0.1:8020 (idempotent, BelowNormal priority).
param(
    [string]$OcrRuntimeDir = "F:\c1\tools\ocr-runtime",
    [string]$PythonExe = $(if (Test-Path -LiteralPath "F:\c1\capstone1\.venv\Scripts\python.exe") { "F:\c1\capstone1\.venv\Scripts\python.exe" } else { "C:\Users\cuong\AppData\Local\Programs\Python\Python312\python.exe" }),
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8020,
    [int]$CpuThreads = 2,
    [int]$StartupTimeoutSeconds = 240,
    [string]$BackendUrl = "",
    [string]$OcrWorkerToken = "",
    [ValidateSet("BelowNormal", "Idle", "Normal")]
    [string]$Priority = "BelowNormal",
    [string]$QuietStandby = "",
    [int]$QuietStandbyKeepaliveSeconds = 0,
    [int]$MaxIdlePollSeconds = 15,
    [switch]$AllowDegradedStart
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$logsDir = Join-Path $OcrRuntimeDir "logs"
$stateFile = Join-Path $OcrRuntimeDir "ocr-worker-state.json"

function Resolve-BackendSetting([string]$explicitVal, [string]$envKey, [string]$fallbackEnvKey = "") {
    if ($explicitVal -and $explicitVal.Trim()) {
        return $explicitVal.Trim()
    }
    foreach ($candidateKey in @($envKey, $fallbackEnvKey)) {
        if (-not $candidateKey) { continue }
        $envVal = [Environment]::GetEnvironmentVariable($candidateKey, "Process")
        if ($envVal -and $envVal.Trim()) {
            return $envVal.Trim()
        }
    }
    $envFiles = @(
        (Join-Path $repoRoot "backend\.env"),
        "F:\c1\tools\viread-workers.env",
        "F:\c1\capstone1\backend\.env"
    ) | Select-Object -Unique
    foreach ($candidateKey in @($envKey, $fallbackEnvKey)) {
        if (-not $candidateKey) { continue }
        foreach ($envFile in $envFiles) {
            if (-not (Test-Path -LiteralPath $envFile)) { continue }
            foreach ($rawLine in [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)) {
                if ($null -eq $rawLine) { continue }
                $trimmed = $rawLine.TrimStart([char]0xFEFF).Trim()
                if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
                if ($trimmed -match "^(?:export\s+)?$([regex]::Escape($candidateKey))\s*=\s*(.*)$") {
                    $val = $Matches[1].Trim()
                    if (($val.StartsWith('"') -and $val.EndsWith('"') -and $val.Length -ge 2) -or
                        ($val.StartsWith("'") -and $val.EndsWith("'") -and $val.Length -ge 2)) {
                        $val = $val.Substring(1, $val.Length - 2)
                    }
                    if ($val.Trim()) { return $val.Trim() }
                }
            }
        }
    }
    return ""
}

if (-not $PSBoundParameters.ContainsKey("PythonExe")) {
    $configuredPython = Resolve-BackendSetting "" "VIREAD_OCR_PYTHON_EXE"
    if ($configuredPython -and (Test-Path -LiteralPath $configuredPython)) {
        $PythonExe = $configuredPython
    }
}

if (-not (Test-Path -LiteralPath $PythonExe)) {
    [Console]::Error.WriteLine("OCR Python executable not found at $PythonExe.")
    exit 2
}

New-Item -ItemType Directory -Force -Path $OcrRuntimeDir, $logsDir | Out-Null

function Test-PortListening([int]$p) {
    return Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Stop-ProcessTreeSafe([int]$rootPid) {
    if ($rootPid -le 0 -or $rootPid -eq $PID) { return }
    try {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $rootPid" -ErrorAction SilentlyContinue)
        foreach ($c in $children) {
            Stop-ProcessTreeSafe ([int]$c.ProcessId)
        }
    } catch { }
    try {
        $p = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
        if ($p -and -not $p.HasExited) {
            Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

function Set-ProcessTreePriority([int]$rootPid, [string]$priorityClass) {
    if ($rootPid -le 0 -or $rootPid -eq $PID) { return }
    try {
        $p = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
        if ($p -and -not $p.HasExited) {
            $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]$priorityClass
        }
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $rootPid" -ErrorAction SilentlyContinue)
        foreach ($c in $children) {
            Set-ProcessTreePriority ([int]$c.ProcessId) $priorityClass
        }
    } catch { }
}

function Clear-UnhealthyOcrPort([int]$p) {
    $conns = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
    if ($conns.Count -eq 0) { return $true }
    $killedOcr = $false
    foreach ($conn in $conns) {
        $ownerPid = [int]$conn.OwningProcess
        if ($ownerPid -le 0 -or $ownerPid -eq $PID) { continue }
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
        $cmdLine = if ($cim -and $cim.CommandLine) { [string]$cim.CommandLine } else { "" }
        if ($cmdLine -match "ocr_worker\.worker") {
            $rootPid = $ownerPid
            if ($cim.ParentProcessId -and ([int]$cim.ParentProcessId) -gt 0 -and ([int]$cim.ParentProcessId) -ne $PID) {
                $parentPid = [int]$cim.ParentProcessId
                $parentCim = Get-CimInstance Win32_Process -Filter "ProcessId = $parentPid" -ErrorAction SilentlyContinue
                if ($parentCim -and $parentCim.CommandLine -and ([string]$parentCim.CommandLine -match "ocr_worker\.worker")) {
                    $rootPid = $parentPid
                }
            }
            Write-Host "Stopping unhealthy/degraded ViRead OCR worker on port $p (ownerPid=$ownerPid, rootPid=$rootPid) for clean replacement..."
            Stop-ProcessTreeSafe $rootPid
            if ($rootPid -ne $ownerPid) {
                Stop-ProcessTreeSafe $ownerPid
            }
            $killedOcr = $true
        } else {
            return $false
        }
    }
    if ($killedOcr) {
        $freeDeadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $freeDeadline) {
            if (-not (Test-PortListening $p)) { return $true }
            Start-Sleep -Milliseconds 250
        }
    }
    return (-not [bool](Test-PortListening $p))
}

$effectiveBackendUrl = Resolve-BackendSetting $BackendUrl "VIREAD_OCR_BACKEND_URL" "VIREAD_BACKEND_URL"
$effectiveToken = Resolve-BackendSetting $OcrWorkerToken "VIREAD_OCR_WORKER_TOKEN"
$boundedThreads = [Math]::Max(1, [Math]::Min(4, $CpuThreads))
$isLoopbackHost = ($BindHost -in @("127.0.0.1", "localhost", "::1"))
$resolvedQuietStandby = Resolve-BackendSetting $QuietStandby "VIREAD_OCR_QUIET_STANDBY"
if (-not $resolvedQuietStandby) {
    if ($isLoopbackHost) {
        $resolvedQuietStandby = "false"
    } elseif ($effectiveBackendUrl -match "^https://") {
        $resolvedQuietStandby = "true"
    } else {
        $resolvedQuietStandby = "false"
    }
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
$resolvedHeartbeatEnv = Resolve-BackendSetting "" "VIREAD_OCR_HEARTBEAT_SECONDS"
$effectiveHeartbeatSeconds = if ($resolvedHeartbeatEnv) { [Math]::Max(5, [int]$resolvedHeartbeatEnv) } else { 25 }

# Idempotent check
try {
    $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
    if ($health -and ($health.ready -eq $true -or ($AllowDegradedStart -and $health.status -eq "degraded"))) {
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
    if (-not (Clear-UnhealthyOcrPort $Port)) {
        $stillBusy = Test-PortListening $Port
        $conflictPid = if ($stillBusy) { $stillBusy.OwningProcess } else { $existing.OwningProcess }
        [Console]::Error.WriteLine("Port conflict: OCR worker port $Port is already in use by PID $conflictPid.")
        exit 4
    }
}

$stdoutLog = Join-Path $logsDir "ocr-worker.stdout.log"
$stderrLog = Join-Path $logsDir "ocr-worker.stderr.log"

$envKeys = @(
    "LMDB_FORCE_CPYTHON",
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VIREAD_OCR_CPU_THREADS",
    "VIREAD_OCR_WORKER_HOST",
    "VIREAD_OCR_WORKER_PORT",
    "VIREAD_BACKEND_URL",
    "VIREAD_OCR_BACKEND_URL",
    "VIREAD_OCR_WORKER_TOKEN",
    "VIREAD_OCR_QUIET_STANDBY",
    "VIREAD_OCR_QUIET_STANDBY_KEEPALIVE_SECONDS",
    "VIREAD_OCR_MAX_IDLE_POLL_SECONDS",
    "VIREAD_OCR_HEARTBEAT_SECONDS",
    "PYTHONUNBUFFERED",
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
    [Environment]::SetEnvironmentVariable("LMDB_FORCE_CPYTHON", "1", "Process")
    [Environment]::SetEnvironmentVariable("OMP_NUM_THREADS", "$boundedThreads", "Process")
    [Environment]::SetEnvironmentVariable("OPENBLAS_NUM_THREADS", "$boundedThreads", "Process")
    [Environment]::SetEnvironmentVariable("MKL_NUM_THREADS", "$boundedThreads", "Process")
    [Environment]::SetEnvironmentVariable("NUMEXPR_NUM_THREADS", "$boundedThreads", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_CPU_THREADS", "$boundedThreads", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_WORKER_HOST", $BindHost, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_WORKER_PORT", "$Port", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_BACKEND_URL", $effectiveBackendUrl, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_BACKEND_URL", $effectiveBackendUrl, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_WORKER_TOKEN", $effectiveToken, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_QUIET_STANDBY", $resolvedQuietStandby, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_QUIET_STANDBY_KEEPALIVE_SECONDS", "$effectiveKeepaliveSeconds", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_MAX_IDLE_POLL_SECONDS", "$effectiveMaxIdlePollSeconds", "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_OCR_HEARTBEAT_SECONDS", "$effectiveHeartbeatSeconds", "Process")
    [Environment]::SetEnvironmentVariable("PYTHONUNBUFFERED", "1", "Process")
    [Environment]::SetEnvironmentVariable("PYTHONPATH", "$repoRoot;$repoRoot\backend", "Process")

    $tesseractDir = "C:\Program Files\Tesseract-OCR"
    if ((Test-Path -LiteralPath $tesseractDir) -and ($env:Path -notlike "*$tesseractDir*")) {
        $env:Path = "$env:Path;$tesseractDir"
    }

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
        Stop-ProcessTreeSafe $proc.Id
        [void](Clear-UnhealthyOcrPort $Port)
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
    Stop-ProcessTreeSafe $proc.Id
    [void](Clear-UnhealthyOcrPort $Port)
    [Console]::Error.WriteLine("Timed out waiting for OCR Worker readiness on http://${BindHost}:${Port} after ${StartupTimeoutSeconds}s. Check $stderrLog")
    exit 6
}

$listenConn = Test-PortListening $Port
$listenPid = if ($listenConn) { [int]$listenConn.OwningProcess } else { $proc.Id }
Set-ProcessTreePriority $proc.Id $Priority
Set-ProcessTreePriority $listenPid $Priority
$listenProc = Get-Process -Id $listenPid -ErrorAction SilentlyContinue
$listenStart = if ($listenProc) { $listenProc.StartTime.ToUniversalTime().ToString("o") } else { "" }

@{
    workerPid          = $proc.Id
    workerStart        = $proc.StartTime.ToUniversalTime().ToString("o")
    listenPid          = $listenPid
    listenStart        = $listenStart
    host               = $BindHost
    port               = $Port
    pythonExe          = $PythonExe
    repoRoot           = $repoRoot
    priorityClass      = $Priority
    cpuThreads         = $boundedThreads
    backendConfigured  = [bool]$effectiveBackendUrl
    tokenConfigured    = [bool]$effectiveToken
    quietStandby       = $resolvedQuietStandby
    keepaliveSeconds   = $effectiveKeepaliveSeconds
    maxIdlePollSeconds = $effectiveMaxIdlePollSeconds
    ocrRuntimeDir      = $OcrRuntimeDir
    startedAt          = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content -Encoding UTF8 $stateFile

Write-Host "ViRead Remote OCR Worker ready on http://${BindHost}:${Port} (PID=$listenPid, priority=$Priority, threads=$boundedThreads, ready=$($lastHealth.ready))."
exit 0
