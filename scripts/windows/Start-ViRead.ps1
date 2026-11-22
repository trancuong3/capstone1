# Start ViRead local Windows host stack:
#   1) FastAPI backend + local OCR (127.0.0.1:<backendPort>)
#   2) Next.js 16 SSR frontend     (127.0.0.1:<frontendPort>)
#   3) Single-origin LAN HTTPS reverse proxy (0.0.0.0:<httpsPort>)
#
# Idempotent: calling twice when already healthy does not spawn duplicate servers.
# Safe failure: rolls back any partial processes started during a failed boot.
param(
    [string]$ConfigPath = "",
    [switch]$SkipFrontendBuild,
    [int]$StartupTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $scriptDir "viread-host.config.json"
}

if (-not (Test-Path $ConfigPath)) {
    [Console]::Error.WriteLine("Missing ViRead host config: $ConfigPath. Copy scripts\windows\viread-host.config.example.json and update lanHost.")
    exit 2
}

$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($req in @("lanHost", "httpsPort", "frontendPort", "backendPort", "runtimeDir", "pythonExe")) {
    if (-not $cfg.$req) {
        [Console]::Error.WriteLine("Invalid config ($ConfigPath): missing required field '$req'.")
        exit 2
    }
}

$lanHost = [string]$cfg.lanHost
$httpsPort = [int]$cfg.httpsPort
$frontendPort = [int]$cfg.frontendPort
$backendPort = [int]$cfg.backendPort
$frontendMode = if ($cfg.frontendMode) { [string]$cfg.frontendMode } else { "production" }
$apiProxyPrefix = if ($cfg.apiProxyPrefix) { [string]$cfg.apiProxyPrefix } else { "/_viread_api" }
$runtimeDir = [string]$cfg.runtimeDir
$pythonExe = [string]$cfg.pythonExe
$backendEnvFile = if ($cfg.backendEnvFile) { [string]$cfg.backendEnvFile } else { Join-Path $repoRoot "backend\.env" }
$frontendEnvFile = if ($cfg.frontendEnvFile) { [string]$cfg.frontendEnvFile } else { Join-Path $repoRoot "frontend\.env.local" }
$ocrCloudEnabled = if ($null -ne $cfg.ocrCloudCorrectionEnabled) { [bool]$cfg.ocrCloudCorrectionEnabled } else { $false }
$ocrWarmupEnabled = if ($null -ne $cfg.ocrWarmupEnabled) { [bool]$cfg.ocrWarmupEnabled } else { $false }
$ocrDevice = if ($cfg.ocrDevice) { ([string]$cfg.ocrDevice).Trim().ToLowerInvariant() } else { "cpu" }
$voiceRuntimeDir = if ($cfg.voiceRuntimeDir) { [string]$cfg.voiceRuntimeDir } else { "F:\c1\tools\voice-runtime" }
$voiceWorkerPort = if ($cfg.voiceWorkerPort) { [int]$cfg.voiceWorkerPort } else { 8010 }
$logRetentionMb = if ($cfg.logRetentionMb) { [int]$cfg.logRetentionMb } else { 20 }
$maxLogBytes = $logRetentionMb * 1MB

if (-not (Test-Path $pythonExe)) { [Console]::Error.WriteLine("Python executable not found: $pythonExe"); exit 3 }
if (-not (Test-Path $backendEnvFile)) { [Console]::Error.WriteLine("Backend env file not found: $backendEnvFile"); exit 3 }
if (-not (Test-Path $frontendEnvFile)) { [Console]::Error.WriteLine("Frontend env file not found: $frontendEnvFile"); exit 3 }

$logsDir = Join-Path $runtimeDir "logs"
$stateFile = Join-Path $runtimeDir "state.json"
New-Item -ItemType Directory -Force -Path $runtimeDir, $logsDir | Out-Null

function Rotate-LogIfNeeded([string]$path) {
    if ((Test-Path $path) -and ((Get-Item $path).Length -gt $maxLogBytes)) {
        $bak = "$path.prev"
        if (Test-Path $bak) { Remove-Item -Force $bak }
        Move-Item -Force $path $bak
    }
}

function Test-PortListening([int]$port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $c
}

function Test-ProcessAlive([int]$pidVal) {
    if ($pidVal -le 0) { return $false }
    return $null -ne (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)
}

function Read-DotEnv([string]$path) {
    $map = @{}
    foreach ($line in (Get-Content $path -Encoding UTF8)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
        if ($trimmed -match "^([A-Za-z0-9_]+)\s*=\s*(.*)$") {
            $k = $Matches[1]
            $v = $Matches[2].Trim()
            if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
                $v = $v.Substring(1, $v.Length - 2)
            }
            $map[$k] = $v
        }
    }
    return $map
}

# Check idempotent already-running state
if (Test-Path $stateFile) {
    try {
        $prev = Get-Content $stateFile -Raw | ConvertFrom-Json
        $allUp = (Test-ProcessAlive $prev.backendPid) -and (Test-ProcessAlive $prev.frontendPid) -and (Test-ProcessAlive $prev.proxyPid) `
            -and [bool](Test-PortListening $backendPort) -and [bool](Test-PortListening $frontendPort) -and [bool](Test-PortListening $httpsPort)
        if ($allUp) {
            Write-Host "ViRead host stack is already running (backend=$($prev.backendPid), frontend=$($prev.frontendPid), proxy=$($prev.proxyPid))."
            Write-Host "LAN URL: https://${lanHost}:${httpsPort}"
            exit 0
        }
    } catch { }
}

# Detect port conflicts BEFORE starting anything
foreach ($portInfo in @(
    @{ Name = "Backend"; Port = $backendPort },
    @{ Name = "Frontend"; Port = $frontendPort },
    @{ Name = "HTTPS Proxy"; Port = $httpsPort }
)) {
    $existing = Test-PortListening $portInfo.Port
    if ($existing) {
        [Console]::Error.WriteLine("Port conflict: $($portInfo.Name) port $($portInfo.Port) is already in use by PID $($existing.OwningProcess). Stop the conflicting process or change ports in $ConfigPath.")
        exit 4
    }
}

# Ensure scoped LAN TLS certificate exists for lanHost
$global:LASTEXITCODE = 0
& (Join-Path $scriptDir "New-ViReadLanCert.ps1") -LanHost $lanHost -RuntimeDir $runtimeDir
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("Failed to prepare LAN TLS certificate."); exit 5 }

$caCertPem = Join-Path $runtimeDir "certs\viread-lan-ca.pem"
$leafCertPem = Join-Path $runtimeDir "certs\viread-lan-server.pem"
$leafKeyPem = Join-Path $runtimeDir "certs\private\viread-lan-server.key"
$lanOrigin = if ($httpsPort -eq 443) { "https://$lanHost" } else { "https://${lanHost}:${httpsPort}" }
$lanApiUrl = "$lanOrigin$apiProxyPrefix"

$beEnv = Read-DotEnv $backendEnvFile
$feEnv = Read-DotEnv $frontendEnvFile

# Prepare build/run environment for Frontend (single-origin HTTPS LAN API URL!)
$feBuildDir = Join-Path $repoRoot "frontend\.next-lan"
$feBuildMeta = Join-Path $runtimeDir "frontend-build-meta.json"
$needFeBuild = ($frontendMode -eq "production") -and (-not $SkipFrontendBuild)
if ($needFeBuild -and (Test-Path $feBuildDir) -and (Test-Path $feBuildMeta)) {
    try {
        $bm = Get-Content $feBuildMeta -Raw | ConvertFrom-Json
        if ($bm.apiUrl -eq $lanApiUrl -and $bm.repoRoot -eq $repoRoot) {
            $needFeBuild = $false
        }
    } catch { }
}

if ($needFeBuild) {
    Write-Host "[0/3] Building Next.js production bundle for $lanOrigin (API: $lanApiUrl)..."
    $savedEnv = @{}
    foreach ($kv in $feEnv.GetEnumerator()) {
        $savedEnv[$kv.Key] = [Environment]::GetEnvironmentVariable($kv.Key, "Process")
        [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
    }
    $savedEnv["NEXT_PUBLIC_API_URL"] = [Environment]::GetEnvironmentVariable("NEXT_PUBLIC_API_URL", "Process")
    $savedEnv["NEXT_DIST_DIR"] = [Environment]::GetEnvironmentVariable("NEXT_DIST_DIR", "Process")
    [Environment]::SetEnvironmentVariable("NEXT_PUBLIC_API_URL", $lanApiUrl, "Process")
    [Environment]::SetEnvironmentVariable("NEXT_DIST_DIR", ".next-lan", "Process")
    $tsconfigPath = Join-Path $repoRoot "frontend\tsconfig.json"
    $tsconfigBackup = if (Test-Path $tsconfigPath) { Get-Content $tsconfigPath -Raw -Encoding UTF8 } else { $null }
    Push-Location (Join-Path $repoRoot "frontend")
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Next.js build failed (exit $LASTEXITCODE)" }
        @{ apiUrl = $lanApiUrl; repoRoot = $repoRoot; builtAt = (Get-Date).ToString("o") } |
            ConvertTo-Json | Set-Content -Encoding UTF8 $feBuildMeta
    } finally {
        Pop-Location
        if ($null -ne $tsconfigBackup) {
            [System.IO.File]::WriteAllText($tsconfigPath, $tsconfigBackup, (New-Object System.Text.UTF8Encoding($false)))
        }
        foreach ($kv in $savedEnv.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
        }
    }
}

$startedPids = New-Object System.Collections.Generic.List[int]

function Stop-ProcessTreeSafe([int]$rootPid) {
    try {
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $rootPid" -ErrorAction SilentlyContinue
        foreach ($c in $children) {
            Stop-ProcessTreeSafe ([int]$c.ProcessId)
        }
    } catch { }
    try {
        $proc = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
        if ($proc) { Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue }
    } catch { }
}

function Rollback-Started {
    foreach ($p in $startedPids) {
        Stop-ProcessTreeSafe $p
    }
    if (Test-Path $stateFile) { Remove-Item -Force $stateFile -ErrorAction SilentlyContinue }
}

function Get-ListenProcIdentity([int]$port) {
    $c = Test-PortListening $port
    if (-not $c) { return @{ pid = 0; start = "" } }
    $lp = Get-Process -Id ([int]$c.OwningProcess) -ErrorAction SilentlyContinue
    if (-not $lp) { return @{ pid = [int]$c.OwningProcess; start = "" } }
    return @{ pid = $lp.Id; start = $lp.StartTime.ToUniversalTime().ToString("o") }
}

function Launch-Service([string]$filePath, [string[]]$argsList, [string]$workDir, [hashtable]$envOverrides, [string]$stdoutLog, [string]$stderrLog) {
    Rotate-LogIfNeeded $stdoutLog
    Rotate-LogIfNeeded $stderrLog
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $filePath
    $psi.WorkingDirectory = $workDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false
    # Use cmd /c or PowerShell wrapper? Better: Start-Process with Process env snapshot!
    $saved = @{}
    foreach ($k in $envOverrides.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
        [Environment]::SetEnvironmentVariable($k, [string]$envOverrides[$k], "Process")
    }
    try {
        $p = Start-Process -FilePath $filePath -ArgumentList $argsList -WorkingDirectory $workDir `
            -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
        return $p
    } finally {
        foreach ($k in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($k, $saved[$k], "Process")
        }
    }
}

try {
    # 0b. Start Local Voice Worker on 127.0.0.1:<voiceWorkerPort> when provisioned
    $voiceWorkerPy = Join-Path $voiceRuntimeDir ".venv\Scripts\python.exe"
    if (Test-Path $voiceWorkerPy) {
        Write-Host "[0/3] Starting ViRead Local Voice Worker (127.0.0.1:$voiceWorkerPort)..."
        & (Join-Path $scriptDir "Start-ViReadVoiceWorker.ps1") -VoiceRuntimeDir $voiceRuntimeDir -Port $voiceWorkerPort -StartupTimeoutSeconds $StartupTimeoutSeconds
        if ($LASTEXITCODE -ne 0) { throw "Local Voice Worker failed to start on port $voiceWorkerPort." }
    }

    # 1. Start FastAPI backend on 127.0.0.1:<backendPort>
    Write-Host "[1/3] Starting ViRead FastAPI backend (127.0.0.1:$backendPort)..."
    $beOverrides = @{}
    foreach ($kv in $beEnv.GetEnumerator()) { $beOverrides[$kv.Key] = $kv.Value }
    $beOverrides["VIREAD_LOCAL_VOICE_WORKER_URL"] = "http://127.0.0.1:$voiceWorkerPort"
    $existingCors = if ($beOverrides.ContainsKey("CORS_ALLOWED_ORIGINS")) { $beOverrides["CORS_ALLOWED_ORIGINS"] } else { "http://localhost:3000,http://127.0.0.1:3000" }
    $corsSet = @($existingCors.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($corsSet -notcontains $lanOrigin) { $corsSet += $lanOrigin }
    $beOverrides["CORS_ALLOWED_ORIGINS"] = ($corsSet -join ",")
    $beOverrides["OCR_CLOUD_CORRECTION_ENABLED"] = if ($ocrCloudEnabled) { "true" } else { "false" }
    if (-not $ocrCloudEnabled) {
        $beOverrides["GEMINI_API_KEY"] = ""
        $beOverrides["GROQ_API_KEY"] = ""
    }
    $beOverrides["VIREAD_OCR_WARMUP_ENABLED"] = if ($ocrWarmupEnabled) { "true" } else { "false" }
    if ($ocrDevice -eq "cpu") {
        # Deterministic CPU execution avoids 4GB laptop GPU CUDA AcceleratorError/VRAM contention
        # and cuts cold-start latency in half while keeping identical 0.29% Vietnamese CER.
        $beOverrides["CUDA_VISIBLE_DEVICES"] = "-1"
    }
    $beOverrides["VIREAD_LOCAL_TRAINING_ENABLED"] = "false"
    $beOverrides["PYTHONUNBUFFERED"] = "1"

    $beOut = Join-Path $logsDir "backend.out.log"
    $beErr = Join-Path $logsDir "backend.err.log"
    $beProc = Launch-Service $pythonExe @("-m", "uvicorn", "app.sever:app", "--host", "127.0.0.1", "--port", "$backendPort", "--workers", "1") `
        (Join-Path $repoRoot "backend") $beOverrides $beOut $beErr
    $startedPids.Add($beProc.Id)

    # Wait for backend /health
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    $beReady = $false
    while ((Get-Date) -lt $deadline) {
        if ($beProc.HasExited) { throw "Backend exited prematurely with code $($beProc.ExitCode). Check $beErr" }
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$backendPort/health" -TimeoutSec 8
            if ($h.status -in @("ok", "degraded")) { $beReady = $true; break }
        } catch { Start-Sleep -Milliseconds 600 }
    }
    if (-not $beReady) { throw "Backend did not respond on http://127.0.0.1:$backendPort/health within ${StartupTimeoutSeconds}s." }
    Write-Host "      Backend healthy (PID=$($beProc.Id))."

    # 2. Start Next.js frontend on 127.0.0.1:<frontendPort>
    Write-Host "[2/3] Starting ViRead Next.js frontend (127.0.0.1:$frontendPort, mode=$frontendMode)..."
    $feOverrides = @{}
    foreach ($kv in $feEnv.GetEnumerator()) { $feOverrides[$kv.Key] = $kv.Value }
    $feOverrides["NEXT_PUBLIC_API_URL"] = $lanApiUrl
    $feOverrides["PORT"] = "$frontendPort"
    $feOverrides["HOSTNAME"] = "127.0.0.1"
    if ($frontendMode -eq "production") {
        $feOverrides["NEXT_DIST_DIR"] = ".next-lan"
    }
    $nodeExe = (Get-Command node).Source
    $nextBin = Join-Path $repoRoot "frontend\node_modules\next\dist\bin\next"
    $feArgs = if ($frontendMode -eq "production") {
        @($nextBin, "start", "--hostname", "127.0.0.1", "--port", "$frontendPort")
    } else {
        @($nextBin, "dev", "--hostname", "127.0.0.1", "--port", "$frontendPort")
    }
    $feOut = Join-Path $logsDir "frontend.out.log"
    $feErr = Join-Path $logsDir "frontend.err.log"
    $feProc = Launch-Service $nodeExe $feArgs (Join-Path $repoRoot "frontend") $feOverrides $feOut $feErr
    $startedPids.Add($feProc.Id)

    $feReady = $false
    while ((Get-Date) -lt $deadline) {
        if ($feProc.HasExited) { throw "Frontend exited prematurely with code $($feProc.ExitCode). Check $feErr" }
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$frontendPort/login" -UseBasicParsing -TimeoutSec 5
            if ($resp.StatusCode -eq 200) { $feReady = $true; break }
        } catch { Start-Sleep -Milliseconds 600 }
    }
    if (-not $feReady) { throw "Frontend did not respond on http://127.0.0.1:$frontendPort/login within timeout." }
    Write-Host "      Frontend healthy (PID=$($feProc.Id))."

    # 3. Start LAN HTTPS Reverse Proxy on 0.0.0.0:<httpsPort>
    Write-Host "[3/3] Starting LAN HTTPS Reverse Proxy ($lanOrigin)..."
    $proxyOverrides = @{
        "VIREAD_PROXY_HOST"     = "0.0.0.0"
        "VIREAD_PROXY_PORT"     = "$httpsPort"
        "VIREAD_FRONTEND_PORT"  = "$frontendPort"
        "VIREAD_BACKEND_PORT"   = "$backendPort"
        "VIREAD_API_PREFIX"     = $apiProxyPrefix
        "VIREAD_TLS_CERT"       = $leafCertPem
        "VIREAD_TLS_KEY"        = $leafKeyPem
    }
    $proxyOut = Join-Path $logsDir "proxy.out.log"
    $proxyErr = Join-Path $logsDir "proxy.err.log"
    $proxyScript = Join-Path $scriptDir "lan-https-proxy.mjs"
    $proxyProc = Launch-Service $nodeExe @($proxyScript) $scriptDir $proxyOverrides $proxyOut $proxyErr
    $startedPids.Add($proxyProc.Id)

    $proxyReady = $false
    while ((Get-Date) -lt $deadline) {
        if ($proxyProc.HasExited) { throw "HTTPS proxy exited prematurely with code $($proxyProc.ExitCode). Check $proxyErr" }
        if (Test-PortListening $httpsPort) { $proxyReady = $true; break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $proxyReady) { throw "HTTPS proxy did not bind port $httpsPort within timeout." }
    Write-Host "      HTTPS Proxy healthy (PID=$($proxyProc.Id))."

    # Persist owned PIDs + start times (both launcher PIDs and actual listening child PIDs)
    # so Stop-ViRead.ps1 stops Windows venv shims + workers cleanly and NEVER kills unrelated processes.
    $beListen = Get-ListenProcIdentity $backendPort
    $feListen = Get-ListenProcIdentity $frontendPort
    $pxListen = Get-ListenProcIdentity $httpsPort
    $state = @{
        startedAt          = (Get-Date).ToString("o")
        configPath         = (Resolve-Path $ConfigPath).Path
        repoRoot           = $repoRoot
        lanOrigin          = $lanOrigin
        lanApiUrl          = $lanApiUrl
        httpsPort          = $httpsPort
        frontendPort       = $frontendPort
        backendPort        = $backendPort
        caCertPem          = $caCertPem
        backendPid         = $beProc.Id
        backendStart       = $beProc.StartTime.ToUniversalTime().ToString("o")
        backendListenPid   = $beListen.pid
        backendListenStart = $beListen.start
        frontendPid        = $feProc.Id
        frontendStart      = $feProc.StartTime.ToUniversalTime().ToString("o")
        frontendListenPid  = $feListen.pid
        frontendListenStart = $feListen.start
        proxyPid           = $proxyProc.Id
        proxyStart         = $proxyProc.StartTime.ToUniversalTime().ToString("o")
        proxyListenPid     = $pxListen.pid
        proxyListenStart   = $pxListen.start
        logsDir            = $logsDir
    }
    $state | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $stateFile

    Write-Host ""
    Write-Host "ViRead local host is READY!"
    Write-Host "  LAN HTTPS Origin: $lanOrigin"
    Write-Host "  LAN API Proxy:    $lanApiUrl"
    Write-Host "  Test CA Cert:     $caCertPem"
    Write-Host "  Logs:             $logsDir"
    exit 0
} catch {
    [Console]::Error.WriteLine("Start-ViRead failed: $_")
    Write-Host "Rolling back partial ViRead processes..."
    Rollback-Started
    exit 1
}
