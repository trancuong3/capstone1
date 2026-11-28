#requires -Version 5.1
<#
.SYNOPSIS
    Cleanly stops the ViRead OCR worker autostart supervisor and Python OCR worker process trees on 127.0.0.1:8020.
#>

[CmdletBinding()]
param(
    [string]$RuntimeDir = "F:\c1\tools\ocr-runtime",
    [int]$BindPort = 8020
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "SilentlyContinue"

$StateFile = Join-Path $RuntimeDir "autostart-state.json"
$StandaloneStateFile = Join-Path $RuntimeDir "ocr-worker-state.json"
$StopFile = Join-Path $RuntimeDir "autostart.stop"

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

# 1. Create stop sentinel so the supervisor and 10m Task Scheduler watchdog will not respawn the worker.
$ts = (Get-Date).ToUniversalTime().ToString("o")
[System.IO.File]::WriteAllText($StopFile, "stoppedAt=$ts`n", (New-Object System.Text.UTF8Encoding($false)))

$stoppedPids = New-Object System.Collections.Generic.HashSet[int]

function Stop-ProcessTreeSafe {
    param([int]$TargetPid)
    if ($TargetPid -le 0 -or $TargetPid -eq $PID) { return }
    try {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $TargetPid" -ErrorAction SilentlyContinue)
        foreach ($child in $children) {
            Stop-ProcessTreeSafe -TargetPid ([int]$child.ProcessId)
        }
    } catch {}
    try {
        $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        if ($null -ne $proc -and -not $proc.HasExited) {
            Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue
            [void]$stoppedPids.Add($TargetPid)
        }
    } catch {}
}

function Stop-IfMatching {
    param(
        [int]$TargetPid,
        [string[]]$ExpectedProcessNames
    )
    if ($TargetPid -le 0 -or $TargetPid -eq $PID) { return }
    $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return }
    if ($ExpectedProcessNames -contains $proc.ProcessName) {
        Stop-ProcessTreeSafe -TargetPid $TargetPid
    }
}

# 2. Give supervisor a brief moment to notice the sentinel if running.
Start-Sleep -Milliseconds 1200

# 3. Stop PIDs recorded in autostart-state.json (verifying process names first).
if (Test-Path -LiteralPath $StateFile) {
    try {
        $state = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $state.PSObject.Properties["listenPid"] -and $null -ne $state.listenPid) {
            Stop-IfMatching -TargetPid ([int]$state.listenPid) -ExpectedProcessNames @("python", "pythonw")
        }
        if ($null -ne $state.PSObject.Properties["workerPid"] -and $null -ne $state.workerPid) {
            Stop-IfMatching -TargetPid ([int]$state.workerPid) -ExpectedProcessNames @("python", "pythonw", "venvlauncher")
        }
        if ($null -ne $state.PSObject.Properties["supervisorPid"] -and $null -ne $state.supervisorPid) {
            Stop-IfMatching -TargetPid ([int]$state.supervisorPid) -ExpectedProcessNames @("powershell", "pwsh")
        }
    } catch {
        # Continue with WMI scan below
    }
}

# 4. Stop any remaining supervisor or ocr_worker processes matching command line.
$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and $null -ne $_.CommandLine -and (
        ($_.CommandLine -like "*Run-ViReadOcrWorkerAutostart.ps1*") -or
        ($_.CommandLine -like "*-m ocr_worker.worker*" -and ($_.CommandLine -like "*--port $BindPort*" -or $_.CommandLine -notlike "*--port *"))
    )
})
foreach ($p in $procs) {
    Stop-ProcessTreeSafe -TargetPid ([int]$p.ProcessId)
}

# 5. Wait up to 5 seconds for port listener to release completely.
$portDeadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $portDeadline) {
    $conns = @(Get-NetTCPConnection -LocalPort $BindPort -State Listen -ErrorAction SilentlyContinue)
    if ($conns.Count -eq 0) { break }
    foreach ($c in $conns) {
        $ownerPid = [int]$c.OwningProcess
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
        if ($null -ne $cim -and $null -ne $cim.CommandLine -and $cim.CommandLine -like "*ocr_worker.worker*") {
            Stop-ProcessTreeSafe -TargetPid $ownerPid
        }
    }
    Start-Sleep -Milliseconds 250
}

# 6. Update state files if present.
if (Test-Path -LiteralPath $StateFile) {
    try {
        $stateObj = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $stateObj.workerPid = $null
        if ($null -ne $stateObj.PSObject.Properties["listenPid"]) {
            $stateObj.listenPid = $null
        }
        $stateObj.status = "stopped"
        $stateObj.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        $json = $stateObj | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($StateFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        # Best effort
    }
}
if (Test-Path -LiteralPath $StandaloneStateFile) {
    Remove-Item -LiteralPath $StandaloneStateFile -Force -ErrorAction SilentlyContinue
}

Write-Output "ViRead OCR worker autostart stopped. Sentinel='$StopFile'. StoppedPIDs=$(@($stoppedPids) -join ',')"
