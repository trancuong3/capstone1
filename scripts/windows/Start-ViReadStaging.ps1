# Start isolated ViRead local QA staging stack:
#   0) Verify / seed isolated local Postgres `viread_qa_local` (127.0.0.1:5432)
#   1) Local Voice Worker on 127.0.0.1:8010
#   2) FastAPI backend (`app.sever:app`) on 127.0.0.1:8000 with DATABASE_URL overridden ONLY in process env
#   3) Next.js frontend on 127.0.0.1:3001 (`NEXT_DIST_DIR=.next-staging`)
#   4) Single-origin LAN HTTPS reverse proxy on https://<LanHost>:8443 (auto-regenerates cert if SAN lacks LanHost)
#
# NEVER modifies `backend/.env` or writes to the family Supabase PostgreSQL DB.
param(
    [string]$LanHost = "",
    [int]$HttpsPort = 8443,
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 3001,
    [int]$VoiceWorkerPort = 8010,
    [string]$PgHost = "127.0.0.1",
    [int]$PgPort = 5432,
    [string]$PgUser = "postgres",
    [string]$PgPassword = "viread_local_test",
    [string]$PgDatabase = "viread_qa_local",
    [string]$RuntimeDir = "F:\c1\viread-host-runtime",
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [switch]$SkipSeed,
    [switch]$SkipFrontendBuild,
    [switch]$FrontendDevMode,
    [switch]$Stop,
    [int]$StartupTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$pythonExe = Join-Path $repoRoot ".venv\Scripts\python.exe"
$backendEnvFile = Join-Path $repoRoot "backend\.env"
$frontendEnvFile = Join-Path $repoRoot "frontend\.env.local"
$localStorageDir = Join-Path $RuntimeDir "local-storage"
$logsDir = Join-Path $RuntimeDir "staging-logs"
$stateFile = Join-Path $RuntimeDir "staging-state.json"

function Stop-ProcessTreeSafe([int]$rootPid) {
    if ($rootPid -le 0) { return }
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

if ($Stop) {
    if (Test-Path $stateFile) {
        $st = Get-Content $stateFile -Raw | ConvertFrom-Json
        foreach ($pidField in @("proxyListenPid", "proxyPid", "frontendListenPid", "frontendPid", "backendListenPid", "backendPid", "wslKeepalivePid")) {
            if ($st.PSObject.Properties[$pidField] -and $st.$pidField) {
                Stop-ProcessTreeSafe ([int]$st.$pidField)
            }
        }
        Remove-Item -Force $stateFile -ErrorAction SilentlyContinue
        Write-Host "Stopped ViRead staging stack from $stateFile."
    } else {
        Write-Host "No active staging-state.json found."
    }
    exit 0
}

if (-not $LanHost) {
    try {
        $lanCand = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object {
                $_.IPAddress -notlike "127.*" -and
                $_.IPAddress -notlike "169.254.*" -and
                $_.InterfaceAlias -notlike "*vEthernet*" -and
                $_.InterfaceAlias -notlike "*WSL*" -and
                $_.InterfaceAlias -notlike "*VMware*" -and
                $_.InterfaceAlias -notlike "*VirtualBox*" -and
                ($_.IPAddress -like "192.168.*" -or $_.IPAddress -like "10.*" -or $_.IPAddress -like "172.*") -and
                $_.PrefixOrigin -ne "WellKnown"
            } | Sort-Object { if ($_.InterfaceAlias -like "*Wi-Fi*") { 0 } else { 1 } } | Select-Object -First 1
        if ($lanCand -and $lanCand.IPAddress) { $LanHost = [string]$lanCand.IPAddress }
    } catch { }
    if (-not $LanHost) { $LanHost = "192.168.1.2" }
}

if (-not (Test-Path $pythonExe)) { throw "Python venv not found: $pythonExe" }
if (-not (Test-Path $backendEnvFile)) { throw "Backend env file not found: $backendEnvFile" }
if (-not (Test-Path $frontendEnvFile)) { throw "Frontend env file not found: $frontendEnvFile" }

New-Item -ItemType Directory -Force -Path $RuntimeDir, $logsDir, $localStorageDir | Out-Null

function Test-PortListening([int]$port) {
    return Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
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

function Test-CertHasSanHost([string]$certPath, [string]$hostValue) {
    if (-not (Test-Path $certPath)) { return $false }
    $opensslCmd = Get-Command openssl -ErrorAction SilentlyContinue
    if (-not $opensslCmd) {
        foreach ($cand in @("C:\Program Files\Git\usr\bin\openssl.exe", "D:\Git\usr\bin\openssl.exe")) {
            if (Test-Path $cand) { $opensslCmd = @{ Source = $cand }; break }
        }
    }
    if (-not $opensslCmd) { return $false }
    $out = & $opensslCmd.Source x509 -in $certPath -noout -ext subjectAltName 2>$null
    return [bool](($out -join "`n") -match [regex]::Escape($hostValue))
}

function Launch-Service([string]$filePath, [string[]]$argsList, [string]$workDir, [hashtable]$envOverrides, [string]$stdoutLog, [string]$stderrLog) {
    $saved = @{}
    foreach ($k in $envOverrides.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
        [Environment]::SetEnvironmentVariable($k, [string]$envOverrides[$k], "Process")
    }
    try {
        return Start-Process -FilePath $filePath -ArgumentList $argsList -WorkingDirectory $workDir `
            -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    } finally {
        foreach ($k in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($k, $saved[$k], "Process")
        }
    }
}

# 0. Ensure WSL2 Postgres stays awake (if local Postgres is hosted in WSL2) & seed viread_qa_local
$wslKeepaliveProc = $null
if ($PgHost -in @("127.0.0.1", "localhost", "::1")) {
    $pgPortOwner = Get-NetTCPConnection -LocalPort $PgPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $hasNativePg = $false
    if ($pgPortOwner) {
        $ownerProc = Get-Process -Id $pgPortOwner.OwningProcess -ErrorAction SilentlyContinue
        if ($ownerProc -and $ownerProc.ProcessName -eq "postgres") { $hasNativePg = $true }
    }
    if (-not $hasNativePg) {
        $wslExe = (Get-Command wsl -ErrorAction SilentlyContinue)
        if ($wslExe) {
            $existingKeepalive = Get-CimInstance Win32_Process -Filter "Name = 'wsl.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match 'sleep\s+infinity' } | Select-Object -First 1
            if (-not $existingKeepalive) {
                Write-Host "[0/4] Starting WSL2 PostgreSQL keepalive..."
                $wslKeepaliveProc = Start-Process -FilePath $wslExe.Source -ArgumentList @("-d", "Ubuntu", "--", "sleep", "infinity") -WindowStyle Hidden -PassThru
            }
            Write-Host "[0/4] Ensuring WSL2 PostgreSQL service is running..."
            & $wslExe.Source -d Ubuntu -u root -- service postgresql start | Out-Null
            $pgDeadline = (Get-Date).AddSeconds(15)
            $pgTcpOk = $false
            while ((Get-Date) -lt $pgDeadline) {
                try {
                    $c = New-Object System.Net.Sockets.TcpClient
                    $ar = $c.BeginConnect($PgHost, $PgPort, $null, $null)
                    if ($ar.AsyncWaitHandle.WaitOne(800, $false)) { $c.EndConnect($ar); $pgTcpOk = $true }
                    $c.Close()
                    if ($pgTcpOk) { break }
                } catch { }
                Start-Sleep -Milliseconds 400
            }
            if (-not $pgTcpOk) {
                if ($wslKeepaliveProc) { Stop-ProcessTreeSafe $wslKeepaliveProc.Id }
                throw "PostgreSQL did not become reachable at ${PgHost}:${PgPort} within 15s."
            }
        }
    }
}

if (-not $SkipSeed) {
    Write-Host "[0/4] Seeding isolated local Postgres DB '$PgDatabase' on ${PgHost}:${PgPort}..."
    & $pythonExe (Join-Path $scriptDir "Setup-ViReadLocalStaging.py") `
        --pg-host $PgHost --pg-port $PgPort --pg-user $PgUser --pg-password $PgPassword --db-name $PgDatabase
    if ($LASTEXITCODE -ne 0) {
        if ($wslKeepaliveProc) { Stop-ProcessTreeSafe $wslKeepaliveProc.Id }
        throw "Setup-ViReadLocalStaging.py failed (exit $LASTEXITCODE)."
    }
}

# Check port conflicts before starting staging services
foreach ($pi in @(
    @{ Name = "Backend"; Port = $BackendPort },
    @{ Name = "Frontend"; Port = $FrontendPort },
    @{ Name = "HTTPS Proxy"; Port = $HttpsPort }
)) {
    $busy = Test-PortListening $pi.Port
    if ($busy) {
        throw "Port conflict: $($pi.Name) port $($pi.Port) is already in use by PID $($busy.OwningProcess). Run with -Stop or stop conflicting process."
    }
}

# Ensure LAN cert includes LanHost in SAN
$leafCertPem = Join-Path $RuntimeDir "certs\viread-lan-server.pem"
$leafKeyPem = Join-Path $RuntimeDir "certs\private\viread-lan-server.key"
$caCertPem = Join-Path $RuntimeDir "certs\viread-lan-ca.pem"
if (-not (Test-CertHasSanHost $leafCertPem $LanHost)) {
    Write-Host "Regenerating LAN TLS certificate with SAN=$LanHost..."
    & (Join-Path $scriptDir "New-ViReadLanCert.ps1") -LanHost $LanHost -RuntimeDir $RuntimeDir -ForceRegenerateLeaf
} else {
    & (Join-Path $scriptDir "New-ViReadLanCert.ps1") -LanHost $LanHost -RuntimeDir $RuntimeDir
}
if ($LASTEXITCODE -ne 0) { throw "Failed to prepare LAN TLS certificate." }

$lanOrigin = if ($HttpsPort -eq 443) { "https://$LanHost" } else { "https://${LanHost}:${HttpsPort}" }
$lanApiUrl = "$lanOrigin/_viread_api"
$localOrigin = "http://127.0.0.1:$FrontendPort"
$beEnv = Read-DotEnv $backendEnvFile
$feEnv = Read-DotEnv $frontendEnvFile

$startedPids = New-Object System.Collections.Generic.List[int]

try {
    # 1. Start Local Voice Worker (8010)
    Write-Host "[1/4] Starting Local Voice Worker on 127.0.0.1:$VoiceWorkerPort..."
    & (Join-Path $scriptDir "Start-ViReadVoiceWorker.ps1") -VoiceRuntimeDir $VoiceRuntimeDir -Port $VoiceWorkerPort -StartupTimeoutSeconds $StartupTimeoutSeconds
    if ($LASTEXITCODE -ne 0) { throw "Voice worker failed to start on port $VoiceWorkerPort." }

    # 2. Start Backend (`app.sever:app`) on 127.0.0.1:8000 with isolated local Postgres env override
    Write-Host "[2/4] Starting Backend (`app.sever:app`) on 127.0.0.1:$BackendPort -> DB=$PgDatabase..."
    $beOverrides = @{}
    foreach ($kv in $beEnv.GetEnumerator()) { $beOverrides[$kv.Key] = $kv.Value }
    $beOverrides["DATABASE_URL"] = "postgresql+asyncpg://${PgUser}:${PgPassword}@${PgHost}:${PgPort}/${PgDatabase}"
    $beOverrides["DATABASE_POOLER_MODE"] = "local"
    $beOverrides["DATABASE_SSL_REQUIRED"] = "false"
    $beOverrides["APP_ENVIRONMENT"] = "development"
    $beOverrides["VIREAD_LOCAL_STORAGE_DIR"] = $localStorageDir
    $beOverrides["BACKEND_PUBLIC_URL"] = $lanApiUrl
    $beOverrides["VIREAD_LOCAL_VOICE_WORKER_URL"] = "http://127.0.0.1:$VoiceWorkerPort"
    $beOverrides["CORS_ALLOWED_ORIGINS"] = "$lanOrigin,$localOrigin,http://localhost:$FrontendPort"
    $beOverrides["OCR_CLOUD_CORRECTION_ENABLED"] = "false"
    $beOverrides["VIREAD_OCR_WARMUP_ENABLED"] = "false"
    $beOverrides["VIREAD_LOCAL_TRAINING_ENABLED"] = "false"
    $beOverrides["CUDA_VISIBLE_DEVICES"] = "-1"
    $beOverrides["PYTHONUNBUFFERED"] = "1"

    $beProc = Launch-Service $pythonExe @("-m", "uvicorn", "app.sever:app", "--host", "127.0.0.1", "--port", "$BackendPort", "--workers", "1") `
        (Join-Path $repoRoot "backend") $beOverrides (Join-Path $logsDir "backend.out.log") (Join-Path $logsDir "backend.err.log")
    $startedPids.Add($beProc.Id)

    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    $beReady = $false
    while ((Get-Date) -lt $deadline) {
        if ($beProc.HasExited) { throw "Backend exited prematurely ($($beProc.ExitCode)). Check $logsDir\backend.err.log" }
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:${BackendPort}/health" -TimeoutSec 5
            if ($h.status -in @("ok", "degraded") -and $h.database -and $h.database.status -eq "healthy") { $beReady = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $beReady) { throw "Backend did not become healthy within ${StartupTimeoutSeconds}s." }

    # 3. Build & start Frontend Next.js on 127.0.0.1:3001 (`NEXT_DIST_DIR=.next-staging`)
    $feDir = Join-Path $repoRoot "frontend"
    $nodeExe = (Get-Command node).Source
    $nextBin = Join-Path $feDir "node_modules\next\dist\bin\next"
    if (-not $FrontendDevMode -and -not $SkipFrontendBuild) {
        Write-Host "[3/4] Building Next.js staging bundle (NEXT_DIST_DIR=.next-staging, API=$lanApiUrl)..."
        $savedFe = @{}
        foreach ($kv in $feEnv.GetEnumerator()) {
            $savedFe[$kv.Key] = [Environment]::GetEnvironmentVariable($kv.Key, "Process")
            [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
        }
        foreach ($k in @("NEXT_PUBLIC_API_URL", "NEXT_DIST_DIR", "TURBOPACK_ROOT")) {
            $savedFe[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
        }
        [Environment]::SetEnvironmentVariable("NEXT_PUBLIC_API_URL", $lanApiUrl, "Process")
        [Environment]::SetEnvironmentVariable("NEXT_DIST_DIR", ".next-staging", "Process")
        [Environment]::SetEnvironmentVariable("TURBOPACK_ROOT", (Split-Path -Parent $repoRoot), "Process")
        $tsconfigPath = Join-Path $feDir "tsconfig.json"
        $tsconfigBackup = if (Test-Path $tsconfigPath) { [System.IO.File]::ReadAllText($tsconfigPath, [System.Text.Encoding]::UTF8) } else { $null }
        Push-Location $feDir
        try {
            npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw "Next.js staging build failed ($LASTEXITCODE)." }
        } finally {
            Pop-Location
            if ($null -ne $tsconfigBackup) {
                [System.IO.File]::WriteAllText($tsconfigPath, $tsconfigBackup, (New-Object System.Text.UTF8Encoding($false)))
            }
            foreach ($kv in $savedFe.GetEnumerator()) {
                [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
            }
        }
    }

    Write-Host "[3/4] Starting Next.js frontend on 127.0.0.1:$FrontendPort (NEXT_DIST_DIR=.next-staging)..."
    $feOverrides = @{}
    foreach ($kv in $feEnv.GetEnumerator()) { $feOverrides[$kv.Key] = $kv.Value }
    $feOverrides["NEXT_PUBLIC_API_URL"] = $lanApiUrl
    $feOverrides["NEXT_DIST_DIR"] = ".next-staging"
    $feOverrides["PORT"] = "$FrontendPort"
    $feOverrides["HOSTNAME"] = "127.0.0.1"
    $feArgs = if ($FrontendDevMode) {
        @($nextBin, "dev", "--hostname", "127.0.0.1", "--port", "$FrontendPort")
    } else {
        @($nextBin, "start", "--hostname", "127.0.0.1", "--port", "$FrontendPort")
    }
    $feProc = Launch-Service $nodeExe $feArgs $feDir $feOverrides (Join-Path $logsDir "frontend.out.log") (Join-Path $logsDir "frontend.err.log")
    $startedPids.Add($feProc.Id)

    $feReady = $false
    while ((Get-Date) -lt $deadline) {
        if ($feProc.HasExited) { throw "Frontend exited prematurely ($($feProc.ExitCode)). Check $logsDir\frontend.err.log" }
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:${FrontendPort}/login" -UseBasicParsing -TimeoutSec 5
            if ($resp.StatusCode -eq 200) { $feReady = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $feReady) { throw "Frontend did not become ready within ${StartupTimeoutSeconds}s." }

    # 4. Start LAN HTTPS Reverse Proxy on https://<LanHost>:<HttpsPort>
    Write-Host "[4/4] Starting LAN HTTPS Proxy on $lanOrigin..."
    $proxyOverrides = @{
        "VIREAD_PROXY_HOST"    = "0.0.0.0"
        "VIREAD_PROXY_PORT"    = "$HttpsPort"
        "VIREAD_FRONTEND_PORT" = "$FrontendPort"
        "VIREAD_BACKEND_PORT"  = "$BackendPort"
        "VIREAD_API_PREFIX"    = "/_viread_api"
        "VIREAD_TLS_CERT"      = $leafCertPem
        "VIREAD_TLS_KEY"       = $leafKeyPem
    }
    $proxyProc = Launch-Service $nodeExe @((Join-Path $scriptDir "lan-https-proxy.mjs")) $scriptDir $proxyOverrides `
        (Join-Path $logsDir "proxy.out.log") (Join-Path $logsDir "proxy.err.log")
    $startedPids.Add($proxyProc.Id)

    $proxyReady = $false
    while ((Get-Date) -lt $deadline) {
        if ($proxyProc.HasExited) { throw "HTTPS proxy exited prematurely ($($proxyProc.ExitCode)). Check $logsDir\proxy.err.log" }
        if (Test-PortListening $HttpsPort) { $proxyReady = $true; break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $proxyReady) { throw "HTTPS proxy did not bind port $HttpsPort." }

    $beConn = Test-PortListening $BackendPort
    $feConn = Test-PortListening $FrontendPort
    $pxConn = Test-PortListening $HttpsPort
    @{
        startedAt         = (Get-Date).ToString("o")
        lanOrigin         = $lanOrigin
        lanApiUrl         = $lanApiUrl
        database          = $PgDatabase
        backendPort       = $BackendPort
        frontendPort      = $FrontendPort
        httpsPort         = $HttpsPort
        voiceWorkerPort   = $VoiceWorkerPort
        caCertPem         = $caCertPem
        backendPid        = $beProc.Id
        backendListenPid  = if ($beConn) { [int]$beConn.OwningProcess } else { $beProc.Id }
        frontendPid       = $feProc.Id
        frontendListenPid = if ($feConn) { [int]$feConn.OwningProcess } else { $feProc.Id }
        proxyPid          = $proxyProc.Id
        proxyListenPid    = if ($pxConn) { [int]$pxConn.OwningProcess } else { $proxyProc.Id }
        wslKeepalivePid   = if ($wslKeepaliveProc) { $wslKeepaliveProc.Id } else { 0 }
    } | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $stateFile

    Write-Host "ViRead QA Staging READY: $lanOrigin (DB=$PgDatabase, API=$lanApiUrl, CA=$caCertPem)"
} catch {
    [Console]::Error.WriteLine("Start-ViReadStaging failed: $_")
    foreach ($p in $startedPids) { Stop-ProcessTreeSafe $p }
    if ($wslKeepaliveProc) { Stop-ProcessTreeSafe $wslKeepaliveProc.Id }
    if (Test-Path $stateFile) { Remove-Item -Force $stateFile -ErrorAction SilentlyContinue }
    exit 1
}
