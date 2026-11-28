#requires -Version 5.1
<#
.SYNOPSIS
    Stops the ViRead OCR worker autostart and removes both Task Scheduler and Startup folder registrations.
#>

[CmdletBinding()]
param(
    [string]$RuntimeDir = "",
    [string]$TaskName = "ViRead-OcrWorker-AutoStart"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$ScriptDir = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $PSScriptRoot } else { (Get-Location).Path }
$CandidateTwoUp = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
if (Test-Path -LiteralPath (Join-Path $CandidateTwoUp "scripts\windows")) {
    $RepoRoot = $CandidateTwoUp
    $WorkspaceParent = Split-Path -Parent $RepoRoot
} else {
    $WorkspaceParent = $CandidateTwoUp
    $RepoRoot = Join-Path $WorkspaceParent "capstone1"
}
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = if ($env:VIREAD_OCR_RUNTIME_DIR) { $env:VIREAD_OCR_RUNTIME_DIR } else { Join-Path $WorkspaceParent "tools\ocr-runtime" }
}

$StopScript = Join-Path $RuntimeDir "Stop-ViReadOcrWorkerAutostart.ps1"
if (-not (Test-Path -LiteralPath $StopScript) -and -not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $StopScript = Join-Path $PSScriptRoot "Stop-ViReadOcrWorkerAutostart.ps1"
}
if (Test-Path -LiteralPath $StopScript) {
    & $StopScript -RuntimeDir $RuntimeDir
}

$removedTask = $false
try {
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $existingTask) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        $removedTask = $true
        Write-Output "Removed Scheduled Task: $TaskName"
    } else {
        Write-Output "Scheduled Task not present: $TaskName"
    }
} catch {
    Write-Warning "Failed to unregister Scheduled Task '$TaskName': $($_.Exception.Message)"
}

$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$startupCandidates = @(
    (Join-Path $startupDir "ViRead-OcrWorker-AutoStart.vbs"),
    (Join-Path $startupDir "ViRead-OcrWorker-AutoStart.lnk")
)

$removedStartup = @()
foreach ($candidate in $startupCandidates) {
    if (Test-Path -LiteralPath $candidate) {
        Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
        $removedStartup += $candidate
        Write-Output "Removed Startup entry: $candidate"
    }
}

if ($removedStartup.Count -eq 0) {
    Write-Output "No Startup folder entries found in: $startupDir"
}

Write-Output "Uninstall complete (removedTask=$removedTask, removedStartupCount=$($removedStartup.Count)). Runtime scripts in '$RuntimeDir' were preserved."
