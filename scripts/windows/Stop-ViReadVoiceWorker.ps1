# Safely stop the ViRead Local Voice Worker started by Start-ViReadVoiceWorker.ps1.
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime"
)

$ErrorActionPreference = "Stop"

$stateFile = Join-Path $VoiceRuntimeDir "worker-state.json"
if (-not (Test-Path $stateFile)) {
    Write-Host "ViRead Local Voice Worker is not running (no state file at $stateFile)."
    exit 0
}

$state = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json

function Stop-OwnedProcess([string]$label, [int]$pidVal, [string]$expectedStartIso) {
    if ($pidVal -le 0) { return }
    $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
    if (-not $proc) { return }
    try {
        if ($proc.HasExited) { return }
        $actualIso = $proc.StartTime.ToUniversalTime().ToString("o")
        if ($expectedStartIso -and ([Math]::Abs(([DateTime]::Parse($actualIso) - [DateTime]::Parse($expectedStartIso)).TotalSeconds) -gt 2.0)) {
            Write-Warning "$label (PID=$pidVal): StartTime mismatch; refusing to kill unrelated process."
            return
        }
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $pidVal" -ErrorAction SilentlyContinue
        foreach ($c in $children) {
            Stop-Process -Id ([int]$c.ProcessId) -Force -ErrorAction SilentlyContinue
        }
        Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped $label (PID=$pidVal)."
    } catch { }
}

if ($state.listenPid -and ([int]$state.listenPid -ne [int]$state.workerPid)) {
    Stop-OwnedProcess "Voice Worker Listener" ([int]$state.listenPid) ([string]$state.listenStart)
}
Stop-OwnedProcess "Voice Worker" ([int]$state.workerPid) ([string]$state.workerStart)

Remove-Item -Force $stateFile -ErrorAction SilentlyContinue
Write-Host "ViRead Local Voice Worker stopped cleanly."
exit 0
