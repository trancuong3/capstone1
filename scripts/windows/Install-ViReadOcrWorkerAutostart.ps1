#requires -Version 5.1
<#
.SYNOPSIS
    Installs/updates the per-user Scheduled Task '\ViRead-OcrWorker-AutoStart' for ViRead OCR worker supervision.
.DESCRIPTION
    Registers '\ViRead-OcrWorker-AutoStart' for the current interactive user with:
      (a) AtLogOn trigger (clears pre-session stale stop sentinel at logon), and
      (b) Once + 10-minute RepetitionInterval (3650 days) watchdog trigger passing --respect-stop so mid-session supervisor deaths are revived within 10 minutes while honoring active autostart.stop sentinels.
    Syncs runtime scripts into F:\c1\tools\ocr-runtime when invoked from the repository.
#>

[CmdletBinding()]
param(
    [string]$RuntimeDir = "F:\c1\tools\ocr-runtime",
    [string]$TaskName = "ViRead-OcrWorker-AutoStart",
    [int]$WatchdogIntervalMinutes = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $RuntimeDir "logs") -Force | Out-Null

$runtimeFiles = @(
    "Run-ViReadOcrWorkerAutostart.ps1",
    "Install-ViReadOcrWorkerAutostart.ps1",
    "Stop-ViReadOcrWorkerAutostart.ps1",
    "Uninstall-ViReadOcrWorkerAutostart.ps1",
    "Launch-ViReadOcrWorkerHidden.vbs"
)

if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $srcResolved = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd('\')
    $dstResolved = (Resolve-Path -LiteralPath $RuntimeDir).Path.TrimEnd('\')
    if ($srcResolved -ine $dstResolved) {
        foreach ($fileName in $runtimeFiles) {
            $srcFile = Join-Path $srcResolved $fileName
            $dstFile = Join-Path $dstResolved $fileName
            if (Test-Path -LiteralPath $srcFile) {
                Copy-Item -LiteralPath $srcFile -Destination $dstFile -Force
            }
        }
    }
}

$LauncherVbs = Join-Path $RuntimeDir "Launch-ViReadOcrWorkerHidden.vbs"
$SupervisorPs1 = Join-Path $RuntimeDir "Run-ViReadOcrWorkerAutostart.ps1"
$StopFile = Join-Path $RuntimeDir "autostart.stop"

if (-not (Test-Path -LiteralPath $LauncherVbs)) {
    throw "Required hidden launcher not found: $LauncherVbs"
}
if (-not (Test-Path -LiteralPath $SupervisorPs1)) {
    throw "Required autostart supervisor script not found: $SupervisorPs1"
}

# Clear any pre-existing stop sentinel during installation so Start-ScheduledTask launches cleanly.
if (Test-Path -LiteralPath $StopFile) {
    Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
}

$currentUser = $env:USERNAME
$intervalMinutes = [Math]::Max(1, $WatchdogIntervalMinutes)

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$watchdogTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes $intervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$action = New-ScheduledTaskAction `
    -Execute "wscript.exe" `
    -Argument "//B //NoLogo `"$LauncherVbs`" --respect-stop" `
    -WorkingDirectory $RuntimeDir

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -TaskPath "\" `
    -Action $action `
    -Trigger @($logonTrigger, $watchdogTrigger) `
    -Settings $settings `
    -Principal $principal `
    -Description "ViRead 3-model CUDA OCR worker supervisor on 127.0.0.1:8020 (AtLogOn + ${intervalMinutes}m watchdog respecting autostart.stop)." `
    -Force | Out-Null

Write-Output "Registered Scheduled Task '\$TaskName' for interactive user '$currentUser' (AtLogOn + ${intervalMinutes}m watchdog, MultipleInstances=IgnoreNew, ExecutionTimeLimit=0)."
