# Report status of the standalone ViRead Local Voice Worker (never prints secrets).
param(
    [string]$VoiceRuntimeDir = "",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8010,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WorkspaceParent = Split-Path -Parent $RepoRoot
if ([string]::IsNullOrWhiteSpace($VoiceRuntimeDir)) {
    $VoiceRuntimeDir = if ($env:VIREAD_VOICE_RUNTIME_DIR) {
        $env:VIREAD_VOICE_RUNTIME_DIR
    } elseif ($env:VIREAD_VOICE_RUNTIME_ROOT) {
        $env:VIREAD_VOICE_RUNTIME_ROOT
    } else {
        Join-Path $WorkspaceParent "tools\voice-runtime"
    }
}

$stateFile = Join-Path $VoiceRuntimeDir "worker-state.json"
$state = if (Test-Path $stateFile) { Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$listening = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)

$health = $null
try {
    $health = Invoke-RestMethod -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 3
} catch { }

$report = @{
    endpoint       = "http://${BindHost}:${Port}"
    listening      = $listening
    statePresent   = ($null -ne $state)
    health         = $health
    logsDir        = Join-Path $VoiceRuntimeDir "logs"
}

if ($AsJson) {
    $report | ConvertTo-Json -Depth 6
} else {
    Write-Host "=== ViRead Local Voice Worker Status ==="
    Write-Host "Endpoint:  $($report.endpoint) (listening=$listening)"
    if ($health) {
        Write-Host "Status:    $($health.status) | STT=$($health.stt.model_version) (ready=$($health.stt.ready)) | TTS=$($health.tts.model_version) (ready=$($health.tts.ready), voices=$($health.tts.voices_count))"
    } else {
        Write-Host "Status:    UNREACHABLE"
    }
    Write-Host "Logs:      $($report.logsDir)"
}

if ($listening -and $health -and $health.status -eq "ok") {
    exit 0
}
exit 1
