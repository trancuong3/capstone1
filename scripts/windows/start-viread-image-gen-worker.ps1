# Start the standalone ViRead Local Image-Gen Sidecar Worker on 127.0.0.1:8090.
# Pins HF_HOME / TMP / TEMP / TORCH_HOME strictly to RuntimeDir (0 bytes written on Drive C:).
param(
    [string]$RuntimeDir = "",
    [string]$PythonExe = "",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8090,
    [int]$StartupTimeoutSeconds = 90,
    [string]$ModelId = "",
    [string]$LcmLora = "",
    [ValidateSet("BelowNormal", "Idle", "Normal")]
    [string]$Priority = "BelowNormal",
    [switch]$Preload
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$workspaceParent = Split-Path -Parent $repoRoot
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = if ($env:VIREAD_IMAGE_GEN_RUNTIME_DIR) { $env:VIREAD_IMAGE_GEN_RUNTIME_DIR } else { Join-Path $workspaceParent "tools\image-gen-runtime" }
}
$workerScript = Join-Path $repoRoot "scripts\local_image_gen_worker.py"
$effectivePython = if ($PythonExe -and $PythonExe.Trim()) {
    $PythonExe.Trim()
} else {
    Join-Path $RuntimeDir ".venv\Scripts\python.exe"
}

$logsDir = Join-Path $RuntimeDir "logs"
$hfCacheDir = Join-Path $RuntimeDir "hf-cache"
$hfHubDir = Join-Path $hfCacheDir "hub"
$torchCacheDir = Join-Path $RuntimeDir "torch-cache"
$tmpDir = Join-Path $RuntimeDir "tmp"
$pipCacheDir = Join-Path $RuntimeDir "pip-cache"
$stateFile = Join-Path $RuntimeDir "image-gen-worker-state.json"

if (-not (Test-Path $workerScript)) {
    [Console]::Error.WriteLine("Image-Gen sidecar script not found at $workerScript.")
    exit 2
}
if (-not (Test-Path $effectivePython)) {
    [Console]::Error.WriteLine("Isolated Image-Gen Python venv not found at $effectivePython.")
    exit 2
}

New-Item -ItemType Directory -Force -Path $RuntimeDir, $logsDir, $hfCacheDir, $hfHubDir, $torchCacheDir, $tmpDir, $pipCacheDir | Out-Null

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

# Idempotent health check
try {
    $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
    if ($health -and $health.ok -eq $true) {
        $existingConn = Test-PortListening $Port
        if ($existingConn) {
            Set-ProcessTreePriority ([int]$existingConn.OwningProcess) $Priority
        }
        Write-Host "ViRead Local Image-Gen Worker is already healthy on http://${BindHost}:${Port} (model=$($health.model_id), device=$($health.device))"
        exit 0
    }
} catch { }

$existing = Test-PortListening $Port
if ($existing) {
    [Console]::Error.WriteLine("Port conflict: Image-Gen worker port $Port is already in use by PID $($existing.OwningProcess).")
    exit 4
}

$stdoutLog = Join-Path $logsDir "image-gen-worker.stdout.log"
$stderrLog = Join-Path $logsDir "image-gen-worker.stderr.log"

$envKeys = @(
    "VIREAD_IMAGE_GEN_RUNTIME_DIR",
    "VIREAD_IMAGE_GEN_HOST",
    "VIREAD_IMAGE_GEN_PORT",
    "VIREAD_IMAGE_GEN_MODEL_ID",
    "VIREAD_IMAGE_GEN_LCM_LORA",
    "HF_HOME",
    "HUGGINGFACE_HUB_CACHE",
    "TRANSFORMERS_CACHE",
    "DIFFUSERS_CACHE",
    "TORCH_HOME",
    "TMP",
    "TEMP",
    "PIP_CACHE_DIR",
    "DATABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "CLOUDFLARE_API_TOKEN"
)
$savedEnv = @{}
foreach ($k in $envKeys) {
    $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
}

try {
    # Pin ALL caches & temp paths strictly to Drive F: (0 bytes on Drive C:)
    [Environment]::SetEnvironmentVariable("VIREAD_IMAGE_GEN_RUNTIME_DIR", $RuntimeDir, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_IMAGE_GEN_HOST", $BindHost, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_IMAGE_GEN_PORT", "$Port", "Process")
    [Environment]::SetEnvironmentVariable("HF_HOME", $hfCacheDir, "Process")
    [Environment]::SetEnvironmentVariable("HUGGINGFACE_HUB_CACHE", $hfHubDir, "Process")
    [Environment]::SetEnvironmentVariable("TRANSFORMERS_CACHE", $hfCacheDir, "Process")
    [Environment]::SetEnvironmentVariable("DIFFUSERS_CACHE", $hfCacheDir, "Process")
    [Environment]::SetEnvironmentVariable("TORCH_HOME", $torchCacheDir, "Process")
    [Environment]::SetEnvironmentVariable("TMP", $tmpDir, "Process")
    [Environment]::SetEnvironmentVariable("TEMP", $tmpDir, "Process")
    [Environment]::SetEnvironmentVariable("PIP_CACHE_DIR", $pipCacheDir, "Process")

    if ($ModelId -and $ModelId.Trim()) {
        [Environment]::SetEnvironmentVariable("VIREAD_IMAGE_GEN_MODEL_ID", $ModelId.Trim(), "Process")
    }
    if ($PSBoundParameters.ContainsKey("LcmLora")) {
        [Environment]::SetEnvironmentVariable("VIREAD_IMAGE_GEN_LCM_LORA", $LcmLora.Trim(), "Process")
    }

    # Enforce zero DB / Supabase / Cloud AI secrets on local image-gen sidecar process
    foreach ($secretKey in @(
        "DATABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SECRET_KEY",
        "SUPABASE_KEY",
        "GEMINI_API_KEY",
        "GROQ_API_KEY",
        "CLOUDFLARE_API_TOKEN"
    )) {
        [Environment]::SetEnvironmentVariable($secretKey, $null, "Process")
    }

    $argList = @($workerScript, "--host", $BindHost, "--port", "$Port")
    if ($Preload) {
        $argList += "--preload"
    }

    $proc = Start-Process -FilePath $effectivePython `
        -ArgumentList $argList `
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
        [Console]::Error.WriteLine("Image-Gen worker exited prematurely with code $($proc.ExitCode). Check $stderrLog")
        exit 5
    }
    try {
        $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
        if ($health -and $health.ok -eq $true) {
            $lastHealth = $health
            $ready = $true
            break
        }
    } catch { }
    Start-Sleep -Milliseconds 700
}

if (-not $ready) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    [Console]::Error.WriteLine("Timed out waiting for Image-Gen Worker readiness on http://${BindHost}:${Port}. Check $stderrLog")
    exit 6
}

$listenConn = Test-PortListening $Port
$listenPid = if ($listenConn) { [int]$listenConn.OwningProcess } else { $proc.Id }
Set-ProcessTreePriority $proc.Id $Priority
Set-ProcessTreePriority $listenPid $Priority
$listenProc = Get-Process -Id $listenPid -ErrorAction SilentlyContinue
$listenStart = if ($listenProc) { $listenProc.StartTime.ToUniversalTime().ToString("o") } else { "" }

@{
    workerPid   = $proc.Id
    workerStart = $proc.StartTime.ToUniversalTime().ToString("o")
    listenPid   = $listenPid
    listenStart = $listenStart
    host        = $BindHost
    port        = $Port
    modelId     = $lastHealth.model_id
    device      = $lastHealth.device
    runtimeDir  = $RuntimeDir
    hfHome      = $hfCacheDir
    tmpDir      = $tmpDir
    startedAt   = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content -Encoding UTF8 $stateFile

Write-Host "ViRead Local Image-Gen Worker ready on http://${BindHost}:${Port} (PID=$listenPid, model=$($lastHealth.model_id), device=$($lastHealth.device))."
exit 0
