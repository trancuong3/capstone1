# Safely stop the ViRead Remote OCR Worker (both standalone ocr-worker-state.json and autostart supervisor/worker).
param(
    [string]$OcrRuntimeDir = "",
    [int]$Port = 8020
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WorkspaceParent = Split-Path -Parent $RepoRoot
if ([string]::IsNullOrWhiteSpace($OcrRuntimeDir)) {
    $OcrRuntimeDir = if ($env:VIREAD_OCR_RUNTIME_DIR) { $env:VIREAD_OCR_RUNTIME_DIR } else { Join-Path $WorkspaceParent "tools\ocr-runtime" }
}

$stateFile = Join-Path $OcrRuntimeDir "ocr-worker-state.json"
$autostartStateFile = Join-Path $OcrRuntimeDir "autostart-state.json"
$autostartStopFile = Join-Path $OcrRuntimeDir "autostart.stop"

function Stop-ProcessTreeSafe([int]$rootPid) {
    if ($rootPid -le 0 -or $rootPid -eq $PID) { return }
    try {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $rootPid" -ErrorAction SilentlyContinue)
        foreach ($c in $children) {
            Stop-ProcessTreeSafe ([int]$c.ProcessId)
        }
    } catch { }
    try {
        $proc = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
        if ($proc -and -not $proc.HasExited) {
            Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

function Stop-OwnedProcess([string]$label, [int]$pidVal, [string]$expectedStartIso, [string[]]$expectedNames = @()) {
    if ($pidVal -le 0 -or $pidVal -eq $PID) { return }
    $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
    if (-not $proc) { return }
    try {
        if ($proc.HasExited) { return }
        if ($expectedNames.Count -gt 0 -and ($expectedNames -notcontains $proc.ProcessName)) {
            return
        }
        $actualIso = $proc.StartTime.ToUniversalTime().ToString("o")
        if ($expectedStartIso -and ([Math]::Abs(([DateTime]::Parse($actualIso) - [DateTime]::Parse($expectedStartIso)).TotalSeconds) -gt 2.0)) {
            Write-Warning "$label (PID=$pidVal): StartTime mismatch; refusing to kill unrelated process."
            return
        }
        Stop-ProcessTreeSafe $pidVal
        Write-Host "Stopped $label (PID=$pidVal)."
    } catch { }
}

$autostartProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and $null -ne $_.CommandLine -and (
        ($_.CommandLine -like "*Run-ViReadOcrWorkerAutostart.ps1*") -or
        ($_.CommandLine -like "*-m ocr_worker.worker*" -and ($_.CommandLine -like "*--port $Port*" -or $_.CommandLine -notlike "*--port *"))
    )
})

$hasAutostartState = Test-Path -LiteralPath $autostartStateFile
$hasStandaloneState = Test-Path -LiteralPath $stateFile

if (-not $hasAutostartState -and -not $hasStandaloneState -and $autostartProcs.Count -eq 0) {
    Write-Host "ViRead Remote OCR Worker is not running (no state files in $OcrRuntimeDir)."
    exit 0
}

# 1. If autostart state or supervisor is present, write autostart.stop sentinel first so supervisor/watchdog does not respawn.
if ($hasAutostartState -or $autostartProcs.Count -gt 0) {
    New-Item -ItemType Directory -Force -Path $OcrRuntimeDir | Out-Null
    $ts = (Get-Date).ToUniversalTime().ToString("o")
    [System.IO.File]::WriteAllText($autostartStopFile, "stoppedAt=$ts`n", (New-Object System.Text.UTF8Encoding($false)))
    Start-Sleep -Milliseconds 800
}

if ($hasAutostartState) {
    try {
        $autoState = Get-Content -LiteralPath $autostartStateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($autoState.PSObject.Properties["listenPid"] -and $null -ne $autoState.listenPid) {
            Stop-OwnedProcess "Autostart OCR Listener" ([int]$autoState.listenPid) "" @("python", "pythonw")
        }
        if ($autoState.PSObject.Properties["workerPid"] -and $null -ne $autoState.workerPid) {
            Stop-OwnedProcess "Autostart OCR Worker" ([int]$autoState.workerPid) "" @("python", "pythonw", "venvlauncher")
        }
        if ($autoState.PSObject.Properties["supervisorPid"] -and $null -ne $autoState.supervisorPid) {
            Stop-OwnedProcess "Autostart OCR Supervisor" ([int]$autoState.supervisorPid) "" @("powershell", "pwsh")
        }
        $autoState.workerPid = $null
        if ($autoState.PSObject.Properties["listenPid"]) { $autoState.listenPid = $null }
        $autoState.status = "stopped"
        $autoState.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        $autoJson = $autoState | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($autostartStateFile, $autoJson, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# 2. Stop standalone state processes if present.
if ($hasStandaloneState) {
    try {
        $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($state.listenPid -and ([int]$state.listenPid -ne [int]$state.workerPid)) {
            Stop-OwnedProcess "OCR Worker Listener" ([int]$state.listenPid) ([string]$state.listenStart)
        }
        Stop-OwnedProcess "OCR Worker" ([int]$state.workerPid) ([string]$state.workerStart)
    } catch { }
    Remove-Item -Force -LiteralPath $stateFile -ErrorAction SilentlyContinue
}

# 3. Ensure any remaining matching supervisor / ocr_worker.worker process trees on $Port are terminated.
$remainingProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and $null -ne $_.CommandLine -and (
        ($_.CommandLine -like "*Run-ViReadOcrWorkerAutostart.ps1*") -or
        ($_.CommandLine -like "*-m ocr_worker.worker*" -and ($_.CommandLine -like "*--port $Port*" -or $_.CommandLine -notlike "*--port *"))
    )
})
foreach ($p in $remainingProcs) {
    Stop-ProcessTreeSafe ([int]$p.ProcessId)
}

Write-Host "ViRead Remote OCR Worker stopped cleanly."
exit 0
