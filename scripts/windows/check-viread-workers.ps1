# Unified zero-secret status checker for ViRead Windows workers (Voice :8010 & OCR :8020 + Autostart Supervisor).
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$OcrRuntimeDir = "F:\c1\tools\ocr-runtime",
    [string]$OcrPythonExe = $(if (Test-Path -LiteralPath "F:\c1\capstone1\.venv\Scripts\python.exe") { "F:\c1\capstone1\.venv\Scripts\python.exe" } else { "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" }),
    [string]$BindHost = "127.0.0.1",
    [int]$VoicePort = 8010,
    [int]$OcrPort = 8020,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot

if (-not $PSBoundParameters.ContainsKey("OcrPythonExe")) {
    $workersEnv = "F:\c1\tools\viread-workers.env"
    if (Test-Path -LiteralPath $workersEnv) {
        foreach ($rawLine in [System.IO.File]::ReadAllLines($workersEnv, [System.Text.Encoding]::UTF8)) {
            if ($null -eq $rawLine) { continue }
            $trimmed = $rawLine.TrimStart([char]0xFEFF).Trim()
            if ($trimmed -match '^(?:export\s+)?VIREAD_OCR_PYTHON_EXE\s*=\s*(.*)$') {
                $val = $Matches[1].Trim().Trim('"').Trim("'")
                if ($val -and (Test-Path -LiteralPath $val)) {
                    $OcrPythonExe = $val
                    break
                }
            }
        }
    }
}

$voicePy = Join-Path $VoiceRuntimeDir ".venv\Scripts\python.exe"
$voiceJsonRaw = & (Join-Path $scriptDir "Get-ViReadVoiceWorkerStatus.ps1") -VoiceRuntimeDir $VoiceRuntimeDir -BindHost $BindHost -Port $VoicePort -AsJson
$voiceExit = $LASTEXITCODE
$ocrJsonRaw = & (Join-Path $scriptDir "Get-ViReadOcrWorkerStatus.ps1") -OcrRuntimeDir $OcrRuntimeDir -BindHost $BindHost -Port $OcrPort -AsJson
$ocrExit = $LASTEXITCODE

$voiceReport = $voiceJsonRaw | ConvertFrom-Json
$ocrReport = $ocrJsonRaw | ConvertFrom-Json

$autostartStateFile = Join-Path $OcrRuntimeDir "autostart-state.json"
$autostartStopFile = Join-Path $OcrRuntimeDir "autostart.stop"
$autoState = if (Test-Path -LiteralPath $autostartStateFile) { Get-Content -LiteralPath $autostartStateFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$stopSentinelPresent = Test-Path -LiteralPath $autostartStopFile
$supPid = if ($autoState -and $autoState.PSObject.Properties["supervisorPid"] -and $null -ne $autoState.supervisorPid) { [int]$autoState.supervisorPid } else { $null }
$supRunning = $false
if ($supPid -and $supPid -gt 0) {
    $sp = Get-Process -Id $supPid -ErrorAction SilentlyContinue
    if ($sp -and (-not $sp.HasExited) -and ($sp.ProcessName -in @("powershell", "pwsh"))) {
        $supRunning = $true
    }
}

$ocrAutostart = @{
    state_present         = ($null -ne $autoState)
    stop_sentinel_present = $stopSentinelPresent
    supervisor_pid        = $supPid
    supervisor_running    = $supRunning
    worker_pid            = if ($autoState -and $autoState.PSObject.Properties["workerPid"]) { $autoState.workerPid } else { $null }
    status                = if ($autoState -and $autoState.PSObject.Properties["status"]) { [string]$autoState.status } else { $null }
    repo_root             = if ($autoState -and $autoState.PSObject.Properties["repoRoot"]) { $autoState.repoRoot } else { $null }
    python_exe            = if ($autoState -and $autoState.PSObject.Properties["pythonExe"]) { $autoState.pythonExe } else { $null }
}

$summary = @{
    voice_python_present = (Test-Path -LiteralPath $voicePy)
    ocr_python_exe       = $OcrPythonExe
    ocr_python_present   = (Test-Path -LiteralPath $OcrPythonExe)
    ocr_autostart        = $ocrAutostart
    voice_worker         = $voiceReport
    ocr_worker           = $ocrReport
    all_healthy          = ($voiceExit -eq 0 -and $ocrExit -eq 0)
}

if ($AsJson) {
    $summary | ConvertTo-Json -Depth 8
} else {
    Write-Host "=== ViRead Unified Workers Check ==="
    Write-Host "Voice Python (.venv): $($summary.voice_python_present) | Port ${VoicePort} listening=$($voiceReport.listening)"
    Write-Host "OCR Python (.venv):   $($summary.ocr_python_present) ($OcrPythonExe) | Port ${OcrPort} listening=$($ocrReport.listening) ready=$(if ($ocrReport.health) { $ocrReport.health.ready } else { $false })"
    Write-Host "OCR Autostart:        supervisor_running=$($ocrAutostart.supervisor_running) (pid=$supPid, status=$($ocrAutostart.status), stop_sentinel=$stopSentinelPresent)"
    Write-Host "All Healthy:          $($summary.all_healthy)"
}

if ($summary.all_healthy) { exit 0 }
exit 1
