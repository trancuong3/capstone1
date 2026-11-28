# Safely stop ONLY cloudflared tunnel processes created by Start-ViReadTunnels.ps1 (verified by PID + StartTime).
param(
    [string]$RuntimeDir = "",
    [string[]]$Services = @()
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WorkspaceParent = Split-Path -Parent $RepoRoot
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = Join-Path $WorkspaceParent "viread-staging-tunnels"
}

$stateFile = Join-Path $RuntimeDir "tunnels-state.json"
$urlsFile = Join-Path $RuntimeDir "tunnel-urls.json"

if (-not (Test-Path $stateFile)) {
    Write-Host "No active ViRead tunnels state file at $stateFile."
    exit 0
}

$state = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $state -or -not $state.tunnels) {
    Remove-Item -Force $stateFile -ErrorAction SilentlyContinue
    Remove-Item -Force $urlsFile -ErrorAction SilentlyContinue
    exit 0
}

function Stop-OwnedTunnel([string]$svcName, $entry) {
    if (-not $entry -or -not $entry.pid) { return }
    $pidVal = [int]$entry.pid
    if ($pidVal -le 0) { return }
    $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "  Tunnel '$svcName' (PID=$pidVal): already stopped."
        return
    }
    if ($proc.ProcessName -notlike "cloudflared*") {
        Write-Warning "  Tunnel '$svcName' (PID=$pidVal): process is '$($proc.ProcessName)', not cloudflared; refusing to kill!"
        return
    }
    try {
        if ($proc.HasExited) { return }
        $actualIso = $proc.StartTime.ToUniversalTime().ToString("o")
        $expectedIso = [string]$entry.startTime
        if ($expectedIso -and ([Math]::Abs(([DateTime]::Parse($actualIso) - [DateTime]::Parse($expectedIso)).TotalSeconds) -gt 2.0)) {
            Write-Warning "  Tunnel '$svcName' (PID=$pidVal): StartTime mismatch; refusing to kill unrelated process!"
            return
        }
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $pidVal" -ErrorAction SilentlyContinue
        foreach ($c in $children) {
            Stop-Process -Id ([int]$c.ProcessId) -Force -ErrorAction SilentlyContinue
        }
        Stop-Process -Id $pidVal -ErrorAction SilentlyContinue
        try { $proc.WaitForExit(3000) | Out-Null } catch { }
        if (-not $proc.HasExited) {
            Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
        }
        Write-Host "  Stopped tunnel '$svcName' (PID=$pidVal)."
    } catch { }
}

$stopAll = (-not $Services -or $Services.Count -eq 0)
$targetSet = @{}
foreach ($s in $Services) {
    $targetSet[$s.Trim().ToLowerInvariant()] = $true
}

$remaining = @{}
foreach ($prop in $state.tunnels.PSObject.Properties) {
    $svcName = $prop.Name
    $entry = $prop.Value
    if ($stopAll -or $targetSet.ContainsKey($svcName.ToLowerInvariant())) {
        Stop-OwnedTunnel $svcName $entry
    } else {
        $remaining[$svcName] = $entry
    }
}

if ($remaining.Count -eq 0) {
    Remove-Item -Force $stateFile -ErrorAction SilentlyContinue
    Remove-Item -Force $urlsFile -ErrorAction SilentlyContinue
    Write-Host "All ViRead Cloudflare tunnels stopped cleanly."
} else {
    @{
        updatedAt      = (Get-Date).ToUniversalTime().ToString("o")
        cloudflaredExe = $state.cloudflaredExe
        tunnels        = $remaining
    } | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $stateFile

    $urlsMap = @{}
    foreach ($kv in $remaining.GetEnumerator()) {
        $urlsMap[$kv.Key] = $kv.Value.publicUrl
    }
    $urlsMap | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $urlsFile
    Write-Host "Selected ViRead Cloudflare tunnels stopped; remaining: $($remaining.Keys -join ', ')."
}

exit 0
