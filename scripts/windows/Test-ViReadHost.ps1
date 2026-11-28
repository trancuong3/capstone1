# Verify the running ViRead local Windows host stack OR run self-tests for the host scripts.
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed
#   2 = invalid/missing configuration
param(
    [string]$ConfigPath = "",
    [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$workspaceParent = Split-Path -Parent $repoRoot
$defaultPythonExe = @(
    (Join-Path $repoRoot "backend\.venv\Scripts\python.exe"),
    (Join-Path $repoRoot ".venv\Scripts\python.exe"),
    (Join-Path $workspaceParent ".venv\Scripts\python.exe")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $defaultPythonExe) {
    $defaultPythonExe = Join-Path $repoRoot "backend\.venv\Scripts\python.exe"
}
$startScript = Join-Path $scriptDir "Start-ViRead.ps1"
$stopScript = Join-Path $scriptDir "Stop-ViRead.ps1"
$statusScript = Join-Path $scriptDir "Get-ViReadStatus.ps1"
$verifyFrontendPy = Join-Path $repoRoot "android\scripts\verify_frontend.py"

function Invoke-HostChecks([string]$cfgFile) {
    if (-not (Test-Path $cfgFile)) {
        Write-Error "[FAIL] Config not found: $cfgFile"
        return 2
    }
    $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $lanOrigin = "https://$($cfg.lanHost):$($cfg.httpsPort)"
    $caCertPem = Join-Path ([string]$cfg.runtimeDir) "certs\viread-lan-ca.pem"
    $healthUrl = "$lanOrigin$($cfg.apiProxyPrefix)/health"

    $failed = 0

    Write-Host "[CHECK 1/5] Listening ports (backend=$($cfg.backendPort), frontend=$($cfg.frontendPort), proxy=$($cfg.httpsPort))..."
    foreach ($p in @([int]$cfg.backendPort, [int]$cfg.frontendPort, [int]$cfg.httpsPort)) {
        $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        if (-not $conn) {
            Write-Host "  [FAIL] Port $p is NOT listening."
            $failed++
        } else {
            Write-Host "  [PASS] Port $p listening (PID=$($conn[0].OwningProcess))."
        }
    }

    Write-Host "[CHECK 2/5] Strict HTTPS TLS + Next.js / -> /login + backend /health JSON via verify_frontend.py..."
    $prevEnv = @{
        "VIREAD_FRONTEND_URL"      = $env:VIREAD_FRONTEND_URL
        "VIREAD_LAN_MODE"          = $env:VIREAD_LAN_MODE
        "VIREAD_LAN_CA_CERT"       = $env:VIREAD_LAN_CA_CERT
        "VIREAD_BACKEND_HEALTH_URL" = $env:VIREAD_BACKEND_HEALTH_URL
    }
    try {
        $env:VIREAD_FRONTEND_URL = $lanOrigin
        $env:VIREAD_LAN_MODE = "1"
        $env:VIREAD_LAN_CA_CERT = $caCertPem
        $env:VIREAD_BACKEND_HEALTH_URL = $healthUrl
        & python $verifyFrontendPy
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [FAIL] verify_frontend.py failed (exit $LASTEXITCODE)."
            $failed++
        } else {
            Write-Host "  [PASS] Strict HTTPS TLS + / redirect + /login HTML + backend health verified."
        }
    } finally {
        foreach ($kv in $prevEnv.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
        }
    }

    Write-Host "[CHECK 3/5] Backend health & local OCR readiness..."
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.backendPort)/health" -TimeoutSec 5
        if ($h.status -ne "ok" -or $h.database.status -ne "healthy" -or -not $h.ocr.ready) {
            Write-Host "  [FAIL] Health degraded: status=$($h.status) db=$($h.database.status) ocr_ready=$($h.ocr.ready)"
            $failed++
        } else {
            Write-Host "  [PASS] Backend status=ok, database=healthy, ocr.ready=true."
        }
    } catch {
        Write-Host "  [FAIL] Backend health request threw: $_"
        $failed++
    }

    Write-Host "[CHECK 4/5] Get-ViReadStatus.ps1 exit code..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File $statusScript -ConfigPath $cfgFile | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [FAIL] Get-ViReadStatus.ps1 returned exit $LASTEXITCODE."
        $failed++
    } else {
        Write-Host "  [PASS] Get-ViReadStatus.ps1 returned 0."
    }

    Write-Host "[CHECK 5/5] Idempotent double-start check (calling Start-ViRead.ps1 while running)..."
    $stateBefore = Get-Content (Join-Path ([string]$cfg.runtimeDir) "state.json") -Raw | ConvertFrom-Json
    & powershell -NoProfile -ExecutionPolicy Bypass -File $startScript -ConfigPath $cfgFile -SkipFrontendBuild | Out-Null
    $rc = $LASTEXITCODE
    $stateAfter = Get-Content (Join-Path ([string]$cfg.runtimeDir) "state.json") -Raw | ConvertFrom-Json
    if ($rc -ne 0 -or $stateBefore.backendPid -ne $stateAfter.backendPid -or $stateBefore.proxyPid -ne $stateAfter.proxyPid) {
        Write-Host "  [FAIL] Double-start was not idempotent (rc=$rc)."
        $failed++
    } else {
        Write-Host "  [PASS] Double-start preserved exact PIDs without spawning duplicates."
    }

    if ($failed -gt 0) {
        Write-Host "HOST CHECK FAILED ($failed failures)."
        return 1
    }
    Write-Host "ALL HOST CHECKS PASSED."
    return 0
}

function Invoke-PsScriptExitCode([string]$scriptPath, [string[]]$argsList) {
    $allArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath) + $argsList
    $p = Start-Process -FilePath "powershell.exe" -ArgumentList $allArgs -WindowStyle Hidden -Wait -PassThru
    return [int]$p.ExitCode
}

function Invoke-ScriptSelfTests {
    Write-Host "=== Running Windows Host Script Self-Tests ==="
    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("viread-host-selftest-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
    $failures = 0

    try {
        # Test 1: Missing config returns exit code 2
        Write-Host "[TEST 1] Missing config file..."
        $rc1 = Invoke-PsScriptExitCode $startScript @("-ConfigPath", (Join-Path $tmpRoot "missing.json"))
        if ($rc1 -ne 2) {
            Write-Host "  [FAIL] Expected exit 2 for missing config, got $rc1"
            $failures++
        } else {
            Write-Host "  [PASS] Missing config returned exit 2."
        }

        # Test 2: Busy port detection (occupy a high ephemeral TCP port and verify Start-ViRead refuses with exit 4)
        Write-Host "[TEST 2] Busy port conflict detection..."
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $busyPort = ($listener.LocalEndpoint).Port
        try {
            $busyCfg = Join-Path $tmpRoot "busy.json"
            @{
                lanHost = "192.168.1.4"
                httpsPort = $busyPort
                frontendPort = 39871
                backendPort = 39872
                frontendMode = "production"
                apiProxyPrefix = "/_viread_api"
                runtimeDir = (Join-Path $tmpRoot "rt-busy")
                pythonExe = $defaultPythonExe
                backendEnvFile = (Join-Path $repoRoot "backend\.env")
                frontendEnvFile = (Join-Path $repoRoot "frontend\.env.local")
            } | ConvertTo-Json | Set-Content -Encoding UTF8 $busyCfg

            $rc2 = Invoke-PsScriptExitCode $startScript @("-ConfigPath", $busyCfg, "-SkipFrontendBuild")
            if ($rc2 -ne 4) {
                Write-Host "  [FAIL] Expected exit 4 on busy port $busyPort, got $rc2"
                $failures++
            } else {
                Write-Host "  [PASS] Busy port $busyPort detected cleanly (exit 4)."
            }
        } finally {
            $listener.Stop()
        }

        # Test 3: Partial startup rollback (valid python + env, invalid backend/frontend startup -> rolls back cleanly)
        Write-Host "[TEST 3] Partial startup failure rolls back cleanly..."
        $badEnv = Join-Path $tmpRoot "bad-backend.env"
        "DATABASE_URL=invalid-url`nSUPABASE_URL=https://x.invalid`nSUPABASE_KEY=x" | Set-Content -Encoding UTF8 $badEnv
        $goodFeEnv = Join-Path $tmpRoot "fe.env"
        "NEXT_PUBLIC_SUPABASE_URL=https://x.invalid`nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=x`nNEXT_PUBLIC_API_URL=https://192.168.1.4:39883/_viread_api" | Set-Content -Encoding UTF8 $goodFeEnv
        $rtPartial = Join-Path $tmpRoot "rt-partial"
        $partialCfg = Join-Path $tmpRoot "partial.json"
        @{
            lanHost = "192.168.1.4"
            httpsPort = 39883
            frontendPort = 39881
            backendPort = 39882
            frontendMode = "production"
            apiProxyPrefix = "/_viread_api"
            runtimeDir = $rtPartial
            pythonExe = $defaultPythonExe
            backendEnvFile = $badEnv
            frontendEnvFile = $goodFeEnv
        } | ConvertTo-Json | Set-Content -Encoding UTF8 $partialCfg

        $rcPartial = Invoke-PsScriptExitCode $startScript @("-ConfigPath", $partialCfg, "-SkipFrontendBuild", "-StartupTimeoutSeconds", "15")
        $stateExists = Test-Path (Join-Path $rtPartial "state.json")
        if ($rcPartial -eq 0 -or $stateExists) {
            Write-Host "  [FAIL] Partial start should fail (rc=$rcPartial) and leave no state.json (exists=$stateExists)."
            $failures++
        } else {
            Write-Host "  [PASS] Partial failure returned rc=$rcPartial and rolled back state cleanly."
        }

        # Test 4: Stop-ViRead refuses to kill an unrelated process whose StartTime does NOT match state.json
        Write-Host "[TEST 4] Stop-ViRead never kills unrelated non-ViRead process..."
        $unrelated = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 30") -WindowStyle Hidden -PassThru
        try {
            $rtSafe = Join-Path $tmpRoot "rt-safe"
            New-Item -ItemType Directory -Force -Path $rtSafe | Out-Null
            @{
                backendPid    = $unrelated.Id
                backendStart  = (Get-Date).AddHours(-1).ToUniversalTime().ToString("o")
                frontendPid   = 0
                frontendStart = ""
                proxyPid      = 0
                proxyStart    = ""
            } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $rtSafe "state.json")

            $null = Invoke-PsScriptExitCode $stopScript @("-RuntimeDir", $rtSafe)
            Start-Sleep -Milliseconds 300
            $stillAlive = $null -ne (Get-Process -Id $unrelated.Id -ErrorAction SilentlyContinue)
            if (-not $stillAlive) {
                Write-Host "  [FAIL] Stop-ViRead killed an unrelated process!"
                $failures++
            } else {
                Write-Host "  [PASS] Stop-ViRead refused to kill unrelated PID=$($unrelated.Id)."
            }
        } finally {
            Stop-Process -Id $unrelated.Id -Force -ErrorAction SilentlyContinue
        }
    } finally {
        Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
    }

    if ($failures -gt 0) {
        Write-Host "SELF-TESTS FAILED ($failures failures)."
        return 1
    }
    Write-Host "ALL SCRIPT SELF-TESTS PASSED (4/4)."
    return 0
}

if ($SelfTest) {
    exit (Invoke-ScriptSelfTests)
}

if (-not $ConfigPath) {
    $ConfigPath = Join-Path $scriptDir "viread-host.config.json"
}
exit (Invoke-HostChecks $ConfigPath)
