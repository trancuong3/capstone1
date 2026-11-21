# Safely stop ONLY the processes created by Start-ViRead.ps1 (verified by PID + StartTime).
param(
    [string]$ConfigPath = "",
    [string]$RuntimeDir = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
if (-not $RuntimeDir) {
    if (-not $ConfigPath) { $ConfigPath = Join-Path $scriptDir "viread-host.config.json" }
    if (Test-Path $ConfigPath) {
        $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $RuntimeDir = [string]$cfg.runtimeDir
    } else {
        $RuntimeDir = "F:\c1\viread-host-runtime"
    }
}

$stateFile = Join-Path $RuntimeDir "state.json"
if (-not (Test-Path $stateFile)) {
    Write-Host "ViRead host is not running (no state file at $stateFile)."
    exit 0
}

$state = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json

function Stop-ChildTree([int]$parentPid) {
    try {
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentPid" -ErrorAction SilentlyContinue
        foreach ($c in $children) {
            Stop-ChildTree ([int]$c.ProcessId)
            $cp = Get-Process -Id ([int]$c.ProcessId) -ErrorAction SilentlyContinue
            if ($cp) {
                Write-Host "    Stopping child PID=$($cp.Id) ($($cp.ProcessName))..."
                Stop-Process -Id $cp.Id -Force -ErrorAction SilentlyContinue
            }
        }
    } catch { }
}

function Stop-OwnedProcess([string]$label, [int]$pidVal, [string]$expectedStartIso) {
    if ($pidVal -le 0) { return }
    $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "  $label (PID=$pidVal): already stopped."
        return
    }
    # Verify process identity using exact StartTime so reused PIDs are NEVER killed!
    $actualIso = $proc.StartTime.ToUniversalTime().ToString("o")
    if ($expectedStartIso -and ([Math]::Abs(([DateTime]::Parse($actualIso) - [DateTime]::Parse($expectedStartIso)).TotalSeconds) -gt 2.0)) {
        Write-Warning "  $label (PID=$pidVal): StartTime mismatch ($actualIso != $expectedStartIso); refusing to kill unrelated process!"
        return
    }
    Write-Host "  Stopping $label (PID=$pidVal, name=$($proc.ProcessName))..."
    # Only after identity is verified, also stop its direct ViRead child workers (e.g. Windows venv python.exe shim -> uvicorn)
    Stop-ChildTree $pidVal
    Stop-Process -Id $pidVal -ErrorAction SilentlyContinue
    try { $proc.WaitForExit(5000) | Out-Null } catch { }
    if (-not $proc.HasExited) {
        Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  Stopped $label (PID=$pidVal)."
}

# Stop in reverse order: proxy -> frontend -> backend (including recorded listening child PIDs if distinct)
Stop-OwnedProcess "HTTPS Proxy" ([int]$state.proxyPid) ([string]$state.proxyStart)
if ($state.proxyListenPid -and ([int]$state.proxyListenPid -ne [int]$state.proxyPid)) {
    Stop-OwnedProcess "HTTPS Proxy Listener" ([int]$state.proxyListenPid) ([string]$state.proxyListenStart)
}
Stop-OwnedProcess "Frontend" ([int]$state.frontendPid) ([string]$state.frontendStart)
if ($state.frontendListenPid -and ([int]$state.frontendListenPid -ne [int]$state.frontendPid)) {
    Stop-OwnedProcess "Frontend Listener" ([int]$state.frontendListenPid) ([string]$state.frontendListenStart)
}
Stop-OwnedProcess "Backend" ([int]$state.backendPid) ([string]$state.backendStart)
if ($state.backendListenPid -and ([int]$state.backendListenPid -ne [int]$state.backendPid)) {
    Stop-OwnedProcess "Backend Listener" ([int]$state.backendListenPid) ([string]$state.backendListenStart)
}

Remove-Item -Force $stateFile -ErrorAction SilentlyContinue
Write-Host "ViRead local host stopped cleanly."
exit 0
