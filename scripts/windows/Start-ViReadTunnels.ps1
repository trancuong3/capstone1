# Start 0-VND Cloudflare HTTPS tunnels for ViRead Voice Worker (8010) and staging services (idempotent).
param(
    [string]$CloudflaredExe = "C:\Program Files (x86)\cloudflared\cloudflared.exe",
    [string]$RuntimeDir = "",
    [int]$VoicePort = 8010,
    [int]$BackendPort = 8002,
    [int]$FrontendPort = 3002,
    [string[]]$Services = @("voice", "backend", "frontend"),
    [switch]$VoiceOnly,
    [int]$StartupTimeoutSeconds = 35,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WorkspaceParent = Split-Path -Parent $RepoRoot
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = Join-Path $WorkspaceParent "viread-staging-tunnels"
}

if (-not (Test-Path $CloudflaredExe)) {
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd -and (Test-Path $cmd.Source)) {
        $CloudflaredExe = $cmd.Source
    } else {
        [Console]::Error.WriteLine("cloudflared not found at '$CloudflaredExe' or PATH.")
        exit 2
    }
}

$targetServices = if ($VoiceOnly) { @("voice") } else { $Services }
$logsDir = Join-Path $RuntimeDir "logs"
$stateFile = Join-Path $RuntimeDir "tunnels-state.json"
$urlsFile = Join-Path $RuntimeDir "tunnel-urls.json"
New-Item -ItemType Directory -Force -Path $RuntimeDir, $logsDir | Out-Null

function Test-OwnedTunnelAlive($entry) {
    if (-not $entry -or -not $entry.pid -or ([int]$entry.pid -le 0)) { return $false }
    $proc = Get-Process -Id ([int]$entry.pid) -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.HasExited) { return $false }
    if ($proc.ProcessName -notlike "cloudflared*") { return $false }
    if ($entry.startTime) {
        try {
            $actualIso = $proc.StartTime.ToUniversalTime().ToString("o")
            if ([Math]::Abs(([DateTime]::Parse($actualIso) - [DateTime]::Parse([string]$entry.startTime)).TotalSeconds) -gt 2.0) {
                return $false
            }
        } catch {
            return $false
        }
    }
    return [bool]$entry.publicUrl
}

function Resolve-ServiceSpec([string]$svcName) {
    $norm = ($svcName -replace "[^a-zA-Z0-9_-]", "").ToLowerInvariant()
    switch ($norm) {
        "voice"    { return @{ name = "voice";    port = $VoicePort;    envKey = "VOICE" } }
        "backend"  { return @{ name = "backend";  port = $BackendPort;  envKey = "BACKEND" } }
        "frontend" { return @{ name = "frontend"; port = $FrontendPort; envKey = "FRONTEND" } }
        default {
            if ($svcName -match "^([a-zA-Z0-9_-]+):(\d{2,5})$") {
                return @{ name = $Matches[1].ToLowerInvariant(); port = [int]$Matches[2]; envKey = $Matches[1].ToUpperInvariant() }
            }
            throw "Unknown tunnel service '$svcName'. Use voice, backend, frontend, or name:port."
        }
    }
}

function Stop-TunnelProcessSafe([int]$pidVal) {
    if ($pidVal -le 0) { return }
    try {
        $p = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
        if ($p -and -not $p.HasExited -and $p.ProcessName -like "cloudflared*") {
            Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

$existingState = @{}
if (Test-Path $stateFile) {
    try {
        $parsed = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($parsed -and $parsed.tunnels) {
            foreach ($prop in $parsed.tunnels.PSObject.Properties) {
                $existingState[$prop.Name] = $prop.Value
            }
        }
    } catch { }
}

$finalTunnels = @{}
foreach ($kv in $existingState.GetEnumerator()) {
    if (Test-OwnedTunnelAlive $kv.Value) {
        $finalTunnels[$kv.Key] = $kv.Value
    }
}

$newlyStartedPids = New-Object System.Collections.Generic.List[int]

try {
    foreach ($svcRaw in $targetServices) {
        $spec = Resolve-ServiceSpec $svcRaw
        $svcName = $spec.name
        $localUrl = "http://127.0.0.1:$($spec.port)"

        if ($finalTunnels.ContainsKey($svcName) -and $finalTunnels[$svcName].localUrl -eq $localUrl) {
            if (-not $AsJson) {
                Write-Host "Tunnel '$svcName' already running: $($finalTunnels[$svcName].publicUrl) -> $localUrl (PID=$($finalTunnels[$svcName].pid))"
            }
            continue
        }

        if ($finalTunnels.ContainsKey($svcName)) {
            Stop-TunnelProcessSafe ([int]$finalTunnels[$svcName].pid)
            $finalTunnels.Remove($svcName)
        }

        $stdoutLog = Join-Path $logsDir "cloudflared-$svcName.stdout.log"
        $stderrLog = Join-Path $logsDir "cloudflared-$svcName.stderr.log"
        if (Test-Path $stdoutLog) { Remove-Item -Force $stdoutLog -ErrorAction SilentlyContinue }
        if (Test-Path $stderrLog) { Remove-Item -Force $stderrLog -ErrorAction SilentlyContinue }

        $tokenEnvName = "VIREAD_CLOUDFLARED_$($spec.envKey)_TOKEN"
        $urlEnvName = "VIREAD_CLOUDFLARED_$($spec.envKey)_URL"
        $namedToken = [Environment]::GetEnvironmentVariable($tokenEnvName, "Process")
        $namedUrl = [Environment]::GetEnvironmentVariable($urlEnvName, "Process")

        $savedTunnelToken = [Environment]::GetEnvironmentVariable("TUNNEL_TOKEN", "Process")
        $mode = "quick_tunnel"
        try {
            if ($namedToken -and $namedToken.Trim() -and $namedUrl -and $namedUrl.Trim()) {
                $mode = "named_tunnel"
                [Environment]::SetEnvironmentVariable("TUNNEL_TOKEN", $namedToken.Trim(), "Process")
                $tunnelArgs = @("tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "run")
            } else {
                [Environment]::SetEnvironmentVariable("TUNNEL_TOKEN", $null, "Process")
                $tunnelArgs = @("tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "--url", $localUrl)
            }

            $proc = Start-Process -FilePath $CloudflaredExe -ArgumentList $tunnelArgs `
                -WorkingDirectory $RuntimeDir -WindowStyle Hidden `
                -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
            $newlyStartedPids.Add($proc.Id)
        } finally {
            [Environment]::SetEnvironmentVariable("TUNNEL_TOKEN", $savedTunnelToken, "Process")
        }

        $publicUrl = $null
        if ($mode -eq "named_tunnel") {
            $publicUrl = $namedUrl.Trim().TrimEnd("/")
        }

        $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
        while ((Get-Date) -lt $deadline) {
            if ($proc.HasExited) {
                throw "cloudflared for '$svcName' exited prematurely with code $($proc.ExitCode). Check $stderrLog"
            }
            $combined = ""
            if (Test-Path $stderrLog) {
                $combined += (Get-Content $stderrLog -Raw -ErrorAction SilentlyContinue)
            }
            if (Test-Path $stdoutLog) {
                $combined += "`n" + (Get-Content $stdoutLog -Raw -ErrorAction SilentlyContinue)
            }
            if ($mode -eq "quick_tunnel") {
                if ($combined -match "https://[a-z0-9-]+\.trycloudflare\.com") {
                    $publicUrl = $Matches[0]
                    if ($combined -match "Registered tunnel connection" -or $combined -match "https://[a-z0-9-]+\.trycloudflare\.com") {
                        break
                    }
                }
            } else {
                if ($combined -match "Registered tunnel connection") {
                    break
                }
            }
            Start-Sleep -Milliseconds 400
        }

        if (-not $publicUrl) {
            throw "Timed out waiting for cloudflared public HTTPS URL for '$svcName' ($localUrl). Check $stderrLog"
        }

        # Give edge registration a brief beat so the trycloudflare hostname resolves cleanly
        if ($mode -eq "quick_tunnel") {
            $regDeadline = (Get-Date).AddSeconds(6)
            while ((Get-Date) -lt $regDeadline) {
                $errText = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw -ErrorAction SilentlyContinue } else { "" }
                if ($errText -match "Registered tunnel connection") { break }
                Start-Sleep -Milliseconds 300
            }
        }

        $finalTunnels[$svcName] = [PSCustomObject]@{
            service   = $svcName
            pid       = $proc.Id
            startTime = $proc.StartTime.ToUniversalTime().ToString("o")
            localUrl  = $localUrl
            publicUrl = $publicUrl
            mode      = $mode
            stdoutLog = $stdoutLog
            stderrLog = $stderrLog
            startedAt = (Get-Date).ToUniversalTime().ToString("o")
        }
    }

    $statePayload = @{
        updatedAt      = (Get-Date).ToUniversalTime().ToString("o")
        cloudflaredExe = $CloudflaredExe
        tunnels        = $finalTunnels
    }
    $statePayload | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $stateFile

    $urlsMap = @{}
    foreach ($kv in $finalTunnels.GetEnumerator()) {
        $urlsMap[$kv.Key] = $kv.Value.publicUrl
    }
    $urlsMap | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $urlsFile

    if ($AsJson) {
        @{
            stateFile = $stateFile
            urlsFile  = $urlsFile
            tunnels   = $urlsMap
        } | ConvertTo-Json -Depth 6
    } else {
        Write-Host "=== ViRead Cloudflare Tunnels Ready (0 VND) ==="
        foreach ($kv in ($finalTunnels.GetEnumerator() | Sort-Object Key)) {
            Write-Host "  $($kv.Key): $($kv.Value.publicUrl) -> $($kv.Value.localUrl) (PID=$($kv.Value.pid), mode=$($kv.Value.mode))"
        }
        Write-Host "  URLs saved to: $urlsFile"
    }
    exit 0
} catch {
    foreach ($p in $newlyStartedPids) {
        Stop-TunnelProcessSafe $p
    }
    [Console]::Error.WriteLine("Start-ViReadTunnels failed: $_")
    exit 1
}
