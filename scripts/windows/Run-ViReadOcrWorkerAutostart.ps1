#requires -Version 5.1
<#
.SYNOPSIS
    Standalone, Antigravity-independent supervisor for ViRead 3-model OCR worker on 127.0.0.1:8020.
.DESCRIPTION
    - Enforces single-instance execution via Local\ViReadOcrWorkerAutostart mutex.
    - Supports -RespectStopSentinel for periodic Task Scheduler watchdog runs while clearing pre-session stale sentinels on logon.
    - Dynamically loads VIREAD_OCR_BACKEND_URL (fallback VIREAD_BACKEND_URL) and VIREAD_OCR_WORKER_TOKEN from F:\c1\tools\viread-workers.env (UTF-8 BOM safe).
    - Prioritizes CUDA .venv Python and validates ocr_worker\worker.py presence before selecting repoRoot.
    - Manages .venv child process trees, configurable process priority propagation (default Normal), port 8020 orphan cleanup, and proxy-free 30s health watchdog.
    - Strips DB/Supabase secrets from the child worker environment and never logs secret values.
#>

[CmdletBinding()]
param(
    [string]$EnvFile = "F:\c1\tools\viread-workers.env",
    [string]$RuntimeDir = "F:\c1\tools\ocr-runtime",
    [string]$PythonExe = "",
    [string]$BindHost = "127.0.0.1",
    [int]$BindPort = 8020,
    [int]$CpuThreads = 2,
    [string]$ProcessPriority = "Normal",
    [int]$BootNetworkWaitSeconds = 90,
    [int]$StartupGraceSeconds = 240,
    [int]$HealthProbeIntervalSeconds = 30,
    [int]$HealthProbeTimeoutSeconds = 15,
    [int]$UnhealthyThreshold = 3,
    [int]$UnreachableThreshold = 6,
    [int]$MaxStartingChecks = 10,
    [switch]$RespectStopSentinel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$HasExplicitProcessPriority = $PSBoundParameters.ContainsKey("ProcessPriority")

$LogsDir = Join-Path $RuntimeDir "logs"
$StateFile = Join-Path $RuntimeDir "autostart-state.json"
$StopFile = Join-Path $RuntimeDir "autostart.stop"
$StdoutLog = Join-Path $LogsDir "autostart-ocr-worker.stdout.log"
$StderrLog = Join-Path $LogsDir "autostart-ocr-worker.stderr.log"
$SupervisorLog = Join-Path $LogsDir "autostart-supervisor.log"
$MutexName = "Local\ViReadOcrWorkerAutostart"

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null

function Write-SupervisorLog {
    param(
        [string]$Message,
        [string]$Level = "INFO"
    )
    try {
        if (Test-Path -LiteralPath $SupervisorLog) {
            $item = Get-Item -LiteralPath $SupervisorLog -ErrorAction SilentlyContinue
            if ($null -ne $item -and $item.Length -gt 2097152) {
                $backup = "$SupervisorLog.1"
                Move-Item -LiteralPath $SupervisorLog -Destination $backup -Force -ErrorAction SilentlyContinue
            }
        }
        $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        Add-Content -LiteralPath $SupervisorLog -Value "$ts [$Level] [pid=$PID] $Message" -Encoding UTF8
    } catch {
        # Best-effort logging only
    }
}

function Invoke-RotateLogIfOversized {
    param(
        [string]$LogPath,
        [long]$MaxBytes = 10485760
    )
    try {
        if (Test-Path -LiteralPath $LogPath) {
            $item = Get-Item -LiteralPath $LogPath -ErrorAction SilentlyContinue
            if ($null -ne $item -and $item.Length -gt $MaxBytes) {
                $backup = "$LogPath.1"
                Move-Item -LiteralPath $LogPath -Destination $backup -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {
        # Best-effort log rotation only
    }
}

function Write-StateFile {
    param([hashtable]$State)
    try {
        $State["updatedAt"] = (Get-Date).ToUniversalTime().ToString("o")
        $json = $State | ConvertTo-Json -Depth 4
        $tmpPath = "$StateFile.tmp"
        [System.IO.File]::WriteAllText($tmpPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmpPath -Destination $StateFile -Force
    } catch {
        Write-SupervisorLog "Failed to write state file: $($_.Exception.Message)" "WARN"
    }
}

function Get-CurrentSessionStartUtc {
    try {
        $currentSid = (Get-Process -Id $PID -ErrorAction Stop).SessionId
        if ($currentSid -gt 0) {
            $sihostProcs = @(Get-Process -Name "sihost" -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $currentSid } | Sort-Object StartTime)
            if ($sihostProcs.Count -gt 0) {
                return $sihostProcs[0].StartTime.ToUniversalTime()
            }
        }
    } catch {
        # Fall back to OS boot time below
    }
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        if ($null -ne $os -and $null -ne $os.LastBootUpTime) {
            return ([DateTime]$os.LastBootUpTime).ToUniversalTime()
        }
    } catch {
        # Best effort
    }
    return [DateTime]::MinValue
}

function Test-StopSentinelActiveForCurrentSession {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    try {
        $item = Get-Item -LiteralPath $Path -ErrorAction Stop
        $sessionStartUtc = Get-CurrentSessionStartUtc
        if ($sessionStartUtc -gt [DateTime]::MinValue -and $item.LastWriteTimeUtc -lt $sessionStartUtc) {
            return $false
        }
    } catch {
        return $true
    }
    return $true
}

function Read-DotEnvFile {
    param([string]$Path)
    $result = @{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $result
    }
    foreach ($rawLine in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
        if ($null -eq $rawLine) { continue }
        $line = $rawLine.TrimStart([char]0xFEFF).Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { continue }
        if ($line -match '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $key = $matches[1]
            $val = $matches[2].Trim()
            if (($val.StartsWith('"') -and $val.EndsWith('"') -and $val.Length -ge 2) -or
                ($val.StartsWith("'") -and $val.EndsWith("'") -and $val.Length -ge 2)) {
                $val = $val.Substring(1, $val.Length - 2)
            }
            $result[$key] = $val
        }
    }
    return $result
}

function Resolve-BackendUrlFromEnvMap {
    param([hashtable]$EnvMap)
    if ($null -ne $EnvMap) {
        if ($EnvMap.ContainsKey("VIREAD_OCR_BACKEND_URL") -and -not [string]::IsNullOrWhiteSpace([string]$EnvMap["VIREAD_OCR_BACKEND_URL"])) {
            return ([string]$EnvMap["VIREAD_OCR_BACKEND_URL"]).Trim()
        }
        if ($EnvMap.ContainsKey("VIREAD_BACKEND_URL") -and -not [string]::IsNullOrWhiteSpace([string]$EnvMap["VIREAD_BACKEND_URL"])) {
            return ([string]$EnvMap["VIREAD_BACKEND_URL"]).Trim()
        }
    }
    return ""
}

function Resolve-PythonExe {
    param(
        [hashtable]$EnvMap,
        [string]$ExplicitPython = ""
    )
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPython)) {
        return $ExplicitPython.Trim()
    }
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($null -ne $EnvMap -and $EnvMap.ContainsKey("VIREAD_OCR_PYTHON_EXE")) {
        $envPy = ([string]$EnvMap["VIREAD_OCR_PYTHON_EXE"]).Trim()
        if (-not [string]::IsNullOrWhiteSpace($envPy)) {
            $candidates.Add($envPy)
        }
    }
    $candidates.Add("F:\c1\capstone1\.venv\Scripts\python.exe")
    $candidates.Add("C:\Users\cuong\AppData\Local\Programs\Python\Python312\python.exe")

    foreach ($cand in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace($cand) -and (Test-Path -LiteralPath $cand)) {
            return $cand
        }
    }
    return "F:\c1\capstone1\.venv\Scripts\python.exe"
}

function Resolve-RepoRoot {
    param([hashtable]$EnvMap)
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($null -ne $EnvMap -and $EnvMap.ContainsKey("VIREAD_OCR_REPO_ROOT")) {
        $envRepo = ([string]$EnvMap["VIREAD_OCR_REPO_ROOT"]).Trim()
        if (-not [string]::IsNullOrWhiteSpace($envRepo)) {
            $candidates.Add($envRepo)
        }
    }
    try {
        if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
            $parentOne = Split-Path -Parent $PSScriptRoot
            if (-not [string]::IsNullOrWhiteSpace($parentOne)) {
                $parentTwo = Split-Path -Parent $parentOne
                if (-not [string]::IsNullOrWhiteSpace($parentTwo)) {
                    $candidates.Add($parentTwo)
                }
            }
        }
    } catch {
        # Best effort
    }
    $candidates.Add("F:\c1\capstone1-main-acceptance")
    $candidates.Add("F:\c1\capstone1")
    $candidates.Add("F:\c1\capstone1-hf-ocr-zero-cost")

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $workerScript = Join-Path $candidate "ocr_worker\worker.py"
        if ((Test-Path -LiteralPath $candidate) -and (Test-Path -LiteralPath $workerScript)) {
            return $candidate
        }
    }
    throw "No valid ViRead repository root containing 'ocr_worker\worker.py' found among candidates: $($candidates -join ', ')"
}

function Resolve-ProcessPriority {
    param(
        [hashtable]$EnvMap,
        [string]$DefaultPriority = "Normal",
        [bool]$ExplicitOverride = $false
    )
    $raw = $DefaultPriority
    if (-not $ExplicitOverride -and $null -ne $EnvMap -and $EnvMap.ContainsKey("VIREAD_OCR_PROCESS_PRIORITY")) {
        $envVal = ([string]$EnvMap["VIREAD_OCR_PROCESS_PRIORITY"]).Trim()
        if (-not [string]::IsNullOrWhiteSpace($envVal)) {
            $raw = $envVal
        }
    }
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return "Normal"
    }
    switch ($raw.Trim().ToLowerInvariant()) {
        "idle"         { return "Idle" }
        "belownormal"  { return "BelowNormal" }
        "below_normal" { return "BelowNormal" }
        "below-normal" { return "BelowNormal" }
        "normal"       { return "Normal" }
        "abovenormal"  { return "AboveNormal" }
        "above_normal" { return "AboveNormal" }
        "above-normal" { return "AboveNormal" }
        "high"         { return "High" }
        default {
            Write-SupervisorLog "Invalid process priority '$raw'; falling back to 'Normal'." "WARN"
            return "Normal"
        }
    }
}

function ConvertFrom-HealthProbeObject {
    param([object]$Resp)
    $isReady = ($null -ne $Resp -and $null -ne $Resp.PSObject.Properties["ready"] -and $Resp.ready -eq $true)
    $statusVal = if ($null -ne $Resp -and $null -ne $Resp.PSObject.Properties["status"] -and $null -ne $Resp.status) { [string]$Resp.status } else { "unknown" }
    $workerStatusVal = if ($null -ne $Resp -and $null -ne $Resp.PSObject.Properties["worker_status"] -and $null -ne $Resp.worker_status) { [string]$Resp.worker_status } else { "unknown" }
    $lastErrVal = if ($null -ne $Resp -and $null -ne $Resp.PSObject.Properties["last_error"] -and $null -ne $Resp.last_error) { [string]$Resp.last_error } else { "" }
    return @{
        reachable    = $true
        ready        = $isReady
        status       = $statusVal
        workerStatus = $workerStatusVal
        lastError    = $lastErrVal
    }
}

function Invoke-LocalOcrHealthProbe {
    param(
        [string]$TargetHost,
        [int]$TargetPort,
        [int]$TimeoutSec = 15
    )
    $httpResp = $null
    $stream = $null
    $reader = $null
    try {
        $url = "http://${TargetHost}:${TargetPort}/health"
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Method = "GET"
        $req.Proxy = $null
        $req.Timeout = $TimeoutSec * 1000
        $req.ReadWriteTimeout = $TimeoutSec * 1000
        $req.KeepAlive = $false
        $req.Accept = "application/json"

        $httpResp = $req.GetResponse()
        $stream = $httpResp.GetResponseStream()
        if ($null -eq $stream) {
            throw "Empty response stream from $url"
        }
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($body)) {
            throw "Empty response body from $url"
        }
        $resp = $body | ConvertFrom-Json
        return (ConvertFrom-HealthProbeObject -Resp $resp)
    } catch [System.Net.WebException] {
        $errMsg = $_.Exception.Message
        $errResp = $_.Exception.Response
        if ($null -ne $errResp) {
            $errStream = $null
            $errReader = $null
            try {
                $errStream = $errResp.GetResponseStream()
                if ($null -ne $errStream) {
                    $errReader = New-Object System.IO.StreamReader($errStream, [System.Text.Encoding]::UTF8)
                    $errBody = $errReader.ReadToEnd()
                    if (-not [string]::IsNullOrWhiteSpace($errBody)) {
                        $errObj = $errBody | ConvertFrom-Json
                        if ($null -ne $errObj -and (
                                $null -ne $errObj.PSObject.Properties["ready"] -or
                                $null -ne $errObj.PSObject.Properties["status"] -or
                                $null -ne $errObj.PSObject.Properties["worker_status"]
                            )) {
                            return (ConvertFrom-HealthProbeObject -Resp $errObj)
                        }
                    }
                }
            } catch {
                # Fall through to unreachable response below
            } finally {
                if ($null -ne $errReader) { try { $errReader.Dispose() } catch {} }
                if ($null -ne $errStream) { try { $errStream.Dispose() } catch {} }
                try { $errResp.Close() } catch {}
            }
        }
        return @{
            reachable    = $false
            ready        = $false
            status       = "unreachable"
            workerStatus = "unreachable"
            lastError    = $errMsg
        }
    } catch {
        return @{
            reachable    = $false
            ready        = $false
            status       = "unreachable"
            workerStatus = "unreachable"
            lastError    = $_.Exception.Message
        }
    } finally {
        if ($null -ne $reader) { try { $reader.Dispose() } catch {} }
        if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
        if ($null -ne $httpResp) { try { $httpResp.Close() } catch {} }
    }
}

function Test-LocalOcrHealthy {
    param(
        [string]$TargetHost,
        [int]$TargetPort,
        [int]$TimeoutSec = 15
    )
    $probe = Invoke-LocalOcrHealthProbe -TargetHost $TargetHost -TargetPort $TargetPort -TimeoutSec $TimeoutSec
    return [bool]$probe["ready"]
}

function Get-BackendHostFromUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $null }
    try {
        $uri = [System.Uri]$Url
        return $uri.Host
    } catch {
        return $null
    }
}

function Wait-ForNetworkReachable {
    param(
        [string]$TargetHost,
        [int]$MaxWaitSeconds
    )
    if ([string]::IsNullOrWhiteSpace($TargetHost)) {
        return $true
    }
    $deadline = (Get-Date).AddSeconds($MaxWaitSeconds)
    $attempt = 0
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $StopFile) {
            return $false
        }
        $attempt++
        try {
            $addrs = [System.Net.Dns]::GetHostAddresses($TargetHost)
            if ($null -ne $addrs -and $addrs.Length -gt 0) {
                if ($attempt -gt 1) {
                    Write-SupervisorLog "DNS resolved for backend host '$TargetHost' on attempt $attempt."
                }
                return $true
            }
        } catch {
            if ($attempt -eq 1 -or ($attempt % 6) -eq 0) {
                Write-SupervisorLog "Waiting for DNS/network reachability of '$TargetHost' (attempt $attempt)..."
            }
        }
        Start-Sleep -Seconds 3
    }
    Write-SupervisorLog "Network wait window (${MaxWaitSeconds}s) elapsed for '$TargetHost'; proceeding to supervisor loop." "WARN"
    return $false
}

function Sleep-Interruptible {
    param([int]$Seconds)
    for ($i = 0; $i -lt $Seconds; $i++) {
        if (Test-Path -LiteralPath $StopFile) {
            return $false
        }
        Start-Sleep -Seconds 1
    }
    return (-not (Test-Path -LiteralPath $StopFile))
}

function Stop-ProcessTreeSafe {
    param([int]$TargetPid)
    if ($TargetPid -le 0 -or $TargetPid -eq $PID) { return }
    try {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $TargetPid" -ErrorAction SilentlyContinue)
        foreach ($child in $children) {
            Stop-ProcessTreeSafe -TargetPid ([int]$child.ProcessId)
        }
    } catch {
        # Best effort
    }
    try {
        $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        if ($null -ne $proc -and -not $proc.HasExited) {
            Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue
        }
    } catch {
        # Best effort
    }
}

function Set-ProcessTreePriority {
    param(
        [int]$RootPid,
        [string]$PriorityClass = "Normal"
    )
    if ($RootPid -le 0 -or $RootPid -eq $PID) { return }
    try {
        $proc = Get-Process -Id $RootPid -ErrorAction SilentlyContinue
        if ($null -ne $proc -and -not $proc.HasExited) {
            $proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]$PriorityClass
        }
    } catch {
        # Best effort
    }
    try {
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootPid" -ErrorAction SilentlyContinue)
        foreach ($child in $children) {
            Set-ProcessTreePriority -RootPid ([int]$child.ProcessId) -PriorityClass $PriorityClass
        }
    } catch {
        # Best effort
    }
}

function Clear-UnhealthyOcrPortListener {
    param([int]$Port)
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($conns.Count -eq 0) {
        return $true
    }
    $stoppedAny = $false
    foreach ($conn in $conns) {
        $ownerPid = [int]$conn.OwningProcess
        if ($ownerPid -le 0 -or $ownerPid -eq $PID) { continue }
        try {
            $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
            $cmdLine = if ($null -ne $cim -and $null -ne $cim.CommandLine) { [string]$cim.CommandLine } else { "" }
            if ($cmdLine -match "ocr_worker\.worker") {
                $rootToStop = $ownerPid
                if ($null -ne $cim.ParentProcessId -and ([int]$cim.ParentProcessId) -gt 0 -and ([int]$cim.ParentProcessId) -ne $PID) {
                    $parentPid = [int]$cim.ParentProcessId
                    $parentCim = Get-CimInstance Win32_Process -Filter "ProcessId = $parentPid" -ErrorAction SilentlyContinue
                    if ($null -ne $parentCim) {
                        $parentCmd = if ($null -ne $parentCim.CommandLine) { [string]$parentCim.CommandLine } else { "" }
                        $parentName = if ($null -ne $parentCim.Name) { [string]$parentCim.Name } else { "" }
                        if ($parentCmd -match "ocr_worker\.worker" -or ($parentName -match "^(python|pythonw|venvlauncher)(\.exe)?$" -and $parentCmd -match "ocr_worker")) {
                            $rootToStop = $parentPid
                        }
                    }
                }
                Write-SupervisorLog "Port $Port has unhealthy ocr_worker.worker listener (ownerPid=$ownerPid, rootPid=$rootToStop); stopping process tree." "WARN"
                Stop-ProcessTreeSafe -TargetPid $rootToStop
                if ($rootToStop -ne $ownerPid) {
                    Stop-ProcessTreeSafe -TargetPid $ownerPid
                }
                $stoppedAny = $true
            } else {
                Write-SupervisorLog "Port $Port is occupied by foreign non-OCR process PID=$ownerPid; refusing to kill." "ERROR"
                return $false
            }
        } catch {
            Write-SupervisorLog "Failed inspecting/clearing listener on port ${Port}: $($_.Exception.Message)" "WARN"
        }
    }

    if ($stoppedAny) {
        $waitDeadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $waitDeadline) {
            $stillListening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
            if ($stillListening.Count -eq 0) {
                return $true
            }
            Start-Sleep -Milliseconds 250
        }
    }
    $remaining = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    return ($remaining.Count -eq 0)
}

# Fast-path stop-sentinel check BEFORE mutex acquisition/cleanup when invoked by periodic Task Scheduler watchdog.
if ($RespectStopSentinel -and (Test-Path -LiteralPath $StopFile)) {
    if (Test-StopSentinelActiveForCurrentSession -Path $StopFile) {
        exit 0
    }
}

$mutex = $null
$hasMutex = $false

try {
    $mutex = New-Object System.Threading.Mutex($false, $MutexName)
    try {
        $hasMutex = $mutex.WaitOne(0, $false)
    } catch [System.Threading.AbandonedMutexException] {
        $hasMutex = $true
        Write-SupervisorLog "Acquired abandoned mutex '$MutexName'; continuing." "WARN"
    }

    if (-not $hasMutex) {
        exit 0
    }

    if (Test-Path -LiteralPath $StopFile) {
        if ($RespectStopSentinel -and (Test-StopSentinelActiveForCurrentSession -Path $StopFile)) {
            Write-SupervisorLog "Active stop sentinel '$StopFile' present (-RespectStopSentinel); exiting cleanly."
            exit 0
        }
        Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
        Write-SupervisorLog "Removed stale stop sentinel '$StopFile' at startup."
    }

    $supervisorStartedAt = (Get-Date).ToUniversalTime().ToString("o")

    # Avoid colliding if an external healthy OCR worker is already serving 127.0.0.1:8020.
    if (Test-LocalOcrHealthy -TargetHost $BindHost -TargetPort $BindPort) {
        Write-SupervisorLog "http://${BindHost}:${BindPort}/health is already healthy; skipping duplicate start."
        exit 0
    }

    $initialEnv = Read-DotEnvFile -Path $EnvFile
    $initialPythonExe = Resolve-PythonExe -EnvMap $initialEnv -ExplicitPython $PythonExe
    $initialPriority = Resolve-ProcessPriority -EnvMap $initialEnv -DefaultPriority $ProcessPriority -ExplicitOverride $HasExplicitProcessPriority
    $initialRepoRoot = $null
    try {
        $initialRepoRoot = Resolve-RepoRoot -EnvMap $initialEnv
    } catch {
        $initialRepoRoot = $null
    }
    $initialBackendUrl = Resolve-BackendUrlFromEnvMap -EnvMap $initialEnv
    $initialBackendHost = Get-BackendHostFromUrl -Url $initialBackendUrl

    Write-SupervisorLog "Supervisor started (host=$BindHost port=$BindPort cpuThreads=$CpuThreads priority=$initialPriority healthTimeout=${HealthProbeTimeoutSeconds}s degradedThreshold=$UnhealthyThreshold unreachableThreshold=$UnreachableThreshold maxStartingChecks=$MaxStartingChecks python='$initialPythonExe' repoRoot='$initialRepoRoot')."

    $state = @{
        supervisorPid       = $PID
        workerPid           = $null
        listenPid           = $null
        host                = $BindHost
        port                = $BindPort
        priorityClass       = $initialPriority
        cpuThreads          = $CpuThreads
        quietStandby        = $false
        repoRoot            = $initialRepoRoot
        pythonExe           = $initialPythonExe
        backendHost         = $initialBackendHost
        backendConfigured   = (-not [string]::IsNullOrWhiteSpace($initialBackendUrl))
        tokenConfigured     = ($initialEnv.ContainsKey("VIREAD_OCR_WORKER_TOKEN") -and -not [string]::IsNullOrWhiteSpace([string]$initialEnv["VIREAD_OCR_WORKER_TOKEN"]))
        status              = "waiting_network"
        restartCount        = 0
        lastExitCode        = $null
        supervisorStartedAt = $supervisorStartedAt
        workerStartedAt     = $null
        stdoutLog           = $StdoutLog
        stderrLog           = $StderrLog
        supervisorLog       = $SupervisorLog
    }
    Write-StateFile -State $state

    if (-not [string]::IsNullOrWhiteSpace($initialBackendHost)) {
        [void](Wait-ForNetworkReachable -TargetHost $initialBackendHost -MaxWaitSeconds $BootNetworkWaitSeconds)
    }

    $backoffSeconds = 5
    $restartCount = 0

    while (-not (Test-Path -LiteralPath $StopFile)) {
        # Dynamically reload env file on each launch/restart.
        $envMap = Read-DotEnvFile -Path $EnvFile
        $effectivePythonExe = Resolve-PythonExe -EnvMap $envMap -ExplicitPython $PythonExe
        $state["pythonExe"] = $effectivePythonExe

        if (-not (Test-Path -LiteralPath $effectivePythonExe)) {
            Write-SupervisorLog "Python executable missing at '$effectivePythonExe'; backing off ${backoffSeconds}s." "ERROR"
            $state["status"] = "backoff"
            Write-StateFile -State $state
            if (-not (Sleep-Interruptible -Seconds $backoffSeconds)) { break }
            $backoffSeconds = [Math]::Min(30, $backoffSeconds * 2)
            continue
        }

        $repoRoot = $null
        try {
            $repoRoot = Resolve-RepoRoot -EnvMap $envMap
        } catch {
            Write-SupervisorLog "Repository root resolution failed: $($_.Exception.Message). Backing off ${backoffSeconds}s." "ERROR"
            $state["status"] = "backoff"
            Write-StateFile -State $state
            if (-not (Sleep-Interruptible -Seconds $backoffSeconds)) { break }
            $backoffSeconds = [Math]::Min(30, $backoffSeconds * 2)
            continue
        }
        $backendDir = Join-Path $repoRoot "backend"
        $pythonPathValue = "$repoRoot;$backendDir"

        $backendUrl = Resolve-BackendUrlFromEnvMap -EnvMap $envMap
        $workerToken = if ($envMap.ContainsKey("VIREAD_OCR_WORKER_TOKEN")) { ([string]$envMap["VIREAD_OCR_WORKER_TOKEN"]).Trim() } else { "" }
        $backendHost = Get-BackendHostFromUrl -Url $backendUrl
        $quietStandbyRaw = if ($envMap.ContainsKey("VIREAD_OCR_QUIET_STANDBY") -and -not [string]::IsNullOrWhiteSpace([string]$envMap["VIREAD_OCR_QUIET_STANDBY"])) {
            ([string]$envMap["VIREAD_OCR_QUIET_STANDBY"]).Trim().ToLowerInvariant()
        } else {
            "false"
        }
        $maxIdlePollVal = if ($envMap.ContainsKey("VIREAD_OCR_MAX_IDLE_POLL_SECONDS") -and -not [string]::IsNullOrWhiteSpace([string]$envMap["VIREAD_OCR_MAX_IDLE_POLL_SECONDS"])) {
            ([string]$envMap["VIREAD_OCR_MAX_IDLE_POLL_SECONDS"]).Trim()
        } else {
            "15"
        }
        $heartbeatVal = if ($envMap.ContainsKey("VIREAD_OCR_HEARTBEAT_SECONDS") -and -not [string]::IsNullOrWhiteSpace([string]$envMap["VIREAD_OCR_HEARTBEAT_SECONDS"])) {
            ([string]$envMap["VIREAD_OCR_HEARTBEAT_SECONDS"]).Trim()
        } else {
            "15"
        }
        $effectivePriority = Resolve-ProcessPriority -EnvMap $envMap -DefaultPriority $ProcessPriority -ExplicitOverride $HasExplicitProcessPriority

        if ([string]::IsNullOrWhiteSpace($backendUrl) -or [string]::IsNullOrWhiteSpace($workerToken)) {
            Write-SupervisorLog "Missing VIREAD_OCR_BACKEND_URL/VIREAD_BACKEND_URL or VIREAD_OCR_WORKER_TOKEN in '$EnvFile' (backendConfigured=$(-not [string]::IsNullOrWhiteSpace($backendUrl)), tokenConfigured=$(-not [string]::IsNullOrWhiteSpace($workerToken))). Retrying in ${backoffSeconds}s." "ERROR"
            $state["repoRoot"] = $repoRoot
            $state["status"] = "backoff"
            $state["backendConfigured"] = (-not [string]::IsNullOrWhiteSpace($backendUrl))
            $state["tokenConfigured"] = (-not [string]::IsNullOrWhiteSpace($workerToken))
            Write-StateFile -State $state
            if (-not (Sleep-Interruptible -Seconds $backoffSeconds)) { break }
            $backoffSeconds = [Math]::Min(30, $backoffSeconds * 2)
            continue
        }

        # Double-check port health before spawning; if occupied by an unhealthy ocr_worker.worker, clean up its process tree.
        if (Test-LocalOcrHealthy -TargetHost $BindHost -TargetPort $BindPort) {
            Write-SupervisorLog "http://${BindHost}:${BindPort}/health became healthy externally; waiting before re-checking."
            if (-not (Sleep-Interruptible -Seconds 15)) { break }
            continue
        }

        if (-not (Clear-UnhealthyOcrPortListener -Port $BindPort)) {
            Write-SupervisorLog "Port $BindPort is unavailable; backing off ${backoffSeconds}s." "ERROR"
            $state["status"] = "backoff"
            Write-StateFile -State $state
            if (-not (Sleep-Interruptible -Seconds $backoffSeconds)) { break }
            $backoffSeconds = [Math]::Min(30, $backoffSeconds * 2)
            continue
        }

        # Strip forbidden DB/Supabase secrets from the process environment inherited by the worker.
        foreach ($forbiddenVar in @("DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_KEY")) {
            Remove-Item -Path "Env:$forbiddenVar" -ErrorAction SilentlyContinue
        }

        # Apply required worker environment variables.
        # Pin OMP_NUM_THREADS and OPENBLAS_NUM_THREADS to 1 for PaddlePaddle CPU OpenBLAS safety
        # while keeping VIREAD_OCR_CPU_THREADS=$CpuThreads for PyTorch.
        $env:LMDB_FORCE_CPYTHON = "1"
        $env:OMP_NUM_THREADS = "1"
        $env:OPENBLAS_NUM_THREADS = "1"
        $env:MKL_NUM_THREADS = "$CpuThreads"
        $env:NUMEXPR_NUM_THREADS = "$CpuThreads"
        $env:VIREAD_OCR_CPU_THREADS = "$CpuThreads"
        $env:VIREAD_OCR_PROCESS_PRIORITY = $effectivePriority
        $env:VIREAD_OCR_WORKER_HOST = $BindHost
        $env:VIREAD_OCR_WORKER_PORT = "$BindPort"
        $env:VIREAD_OCR_QUIET_STANDBY = $quietStandbyRaw
        $env:VIREAD_OCR_MAX_IDLE_POLL_SECONDS = $maxIdlePollVal
        $env:VIREAD_OCR_HEARTBEAT_SECONDS = $heartbeatVal
        $env:VIREAD_BACKEND_URL = $backendUrl
        $env:VIREAD_OCR_BACKEND_URL = $backendUrl
        $env:VIREAD_OCR_WORKER_TOKEN = $workerToken
        $env:PYTHONPATH = $pythonPathValue
        $env:PYTHONUNBUFFERED = "1"

        # Ensure Tesseract directory is on PATH if installed in standard location.
        $tesseractDir = "C:\Program Files\Tesseract-OCR"
        if ((Test-Path -LiteralPath $tesseractDir) -and ($env:Path -notlike "*$tesseractDir*")) {
            $env:Path = "$env:Path;$tesseractDir"
        }

        $launchStart = Get-Date
        $proc = $null
        try {
            Invoke-RotateLogIfOversized -LogPath $StdoutLog -MaxBytes 10485760
            Invoke-RotateLogIfOversized -LogPath $StderrLog -MaxBytes 10485760
            $argList = @("-m", "ocr_worker.worker", "--host", $BindHost, "--port", "$BindPort")
            Write-SupervisorLog "Starting OCR worker (repoRoot='$repoRoot', python='$effectivePythonExe', backendHost='$backendHost', priority=$effectivePriority, heartbeatSeconds=$heartbeatVal, quietStandby=$quietStandbyRaw, restartCount=$restartCount)."
            $proc = Start-Process `
                -FilePath $effectivePythonExe `
                -ArgumentList $argList `
                -WorkingDirectory $repoRoot `
                -WindowStyle Hidden `
                -RedirectStandardOutput $StdoutLog `
                -RedirectStandardError $StderrLog `
                -PassThru

            Set-ProcessTreePriority -RootPid $proc.Id -PriorityClass $effectivePriority

            $state["workerPid"] = $proc.Id
            $state["listenPid"] = $null
            $state["priorityClass"] = $effectivePriority
            $state["repoRoot"] = $repoRoot
            $state["pythonExe"] = $effectivePythonExe
            $state["quietStandby"] = ($quietStandbyRaw -in @("1", "true", "yes", "on"))
            $state["backendHost"] = $backendHost
            $state["backendConfigured"] = $true
            $state["tokenConfigured"] = $true
            $state["status"] = "running"
            $state["restartCount"] = $restartCount
            $state["workerStartedAt"] = $launchStart.ToUniversalTime().ToString("o")
            Write-StateFile -State $state

            Write-SupervisorLog "OCR worker launched with PID=$($proc.Id) (PriorityClass=$effectivePriority)."

            $priorityAppliedAfter5s = $false
            $priorityAppliedOnceBound = $false
            $consecutiveDegradedChecks = 0
            $consecutiveUnreachableChecks = 0
            $consecutiveStartingChecks = 0
            $lastStartingCpuSeconds = -1.0
            $maxStartingAbsoluteSeconds = 1500.0
            $nextHealthProbeAt = $launchStart.AddSeconds($StartupGraceSeconds)

            while (-not $proc.HasExited) {
                if (Test-Path -LiteralPath $StopFile) {
                    Write-SupervisorLog "Stop sentinel detected; stopping worker process tree PID=$($proc.Id)."
                    Stop-ProcessTreeSafe -TargetPid $proc.Id
                    [void](Clear-UnhealthyOcrPortListener -Port $BindPort)
                    break
                }

                $now = Get-Date
                $elapsedSec = ($now - $launchStart).TotalSeconds

                if ((-not $priorityAppliedAfter5s) -and $elapsedSec -ge 5.0) {
                    Set-ProcessTreePriority -RootPid $proc.Id -PriorityClass $effectivePriority
                    $priorityAppliedAfter5s = $true
                }

                if ((-not $priorityAppliedOnceBound) -and ([int]$elapsedSec % 3 -eq 0)) {
                    $listenConns = @(Get-NetTCPConnection -LocalPort $BindPort -State Listen -ErrorAction SilentlyContinue)
                    if ($listenConns.Count -gt 0) {
                        $listenPidVal = [int]$listenConns[0].OwningProcess
                        Set-ProcessTreePriority -RootPid $proc.Id -PriorityClass $effectivePriority
                        Set-ProcessTreePriority -RootPid $listenPidVal -PriorityClass $effectivePriority
                        $state["listenPid"] = $listenPidVal
                        Write-StateFile -State $state
                        $priorityAppliedOnceBound = $true
                    }
                }

                if ($now -ge $nextHealthProbeAt) {
                    $probe = Invoke-LocalOcrHealthProbe -TargetHost $BindHost -TargetPort $BindPort -TimeoutSec $HealthProbeTimeoutSeconds
                    $nextHealthProbeAt = (Get-Date).AddSeconds($HealthProbeIntervalSeconds)
                    $pReachable = [bool]$probe["reachable"]
                    $pReady = [bool]$probe["ready"]
                    $pStatus = [string]$probe["status"]
                    $pWorkerStatus = [string]$probe["workerStatus"]
                    $pLastError = [string]$probe["lastError"]

                    if ($pReady) {
                        if ($consecutiveDegradedChecks -gt 0 -or $consecutiveUnreachableChecks -gt 0 -or $consecutiveStartingChecks -gt 0) {
                            Write-SupervisorLog "OCR worker PID=$($proc.Id) recovered health (ready=true, prevDegraded=$consecutiveDegradedChecks, prevUnreachable=$consecutiveUnreachableChecks, prevStarting=$consecutiveStartingChecks)."
                        }
                        $consecutiveDegradedChecks = 0
                        $consecutiveUnreachableChecks = 0
                        $consecutiveStartingChecks = 0
                        if (-not $priorityAppliedOnceBound) {
                            Set-ProcessTreePriority -RootPid $proc.Id -PriorityClass $effectivePriority
                            $priorityAppliedOnceBound = $true
                        }
                    } elseif ($pReachable -and $pWorkerStatus -eq "STARTING") {
                        $consecutiveUnreachableChecks = 0
                        $treeCpuSeconds = 0.0
                        try {
                            $treePids = New-Object System.Collections.Generic.HashSet[int]
                            [void]$treePids.Add([int]$proc.Id)
                            if ($null -ne $state["listenPid"] -and [int]$state["listenPid"] -gt 0) {
                                [void]$treePids.Add([int]$state["listenPid"])
                            }
                            $childProcs = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($proc.Id)" -ErrorAction SilentlyContinue)
                            foreach ($cp in $childProcs) { [void]$treePids.Add([int]$cp.ProcessId) }
                            foreach ($tp in $treePids) {
                                $pObj = Get-Process -Id $tp -ErrorAction SilentlyContinue
                                if ($null -ne $pObj -and $null -ne $pObj.CPU) {
                                    $treeCpuSeconds += [double]$pObj.CPU
                                }
                            }
                        } catch {
                            $treeCpuSeconds = -1.0
                        }
                        $cpuAdvanced = ($lastStartingCpuSeconds -ge 0.0 -and $treeCpuSeconds -ge 0.0 -and ($treeCpuSeconds - $lastStartingCpuSeconds) -ge 0.25)
                        if ($treeCpuSeconds -ge 0.0) {
                            $lastStartingCpuSeconds = $treeCpuSeconds
                        }
                        if ($cpuAdvanced -and $elapsedSec -lt $maxStartingAbsoluteSeconds) {
                            $consecutiveStartingChecks = 0
                            Write-SupervisorLog "Health watchdog probe for PID=$($proc.Id): worker is actively loading models under load (cpu=$([Math]::Round($treeCpuSeconds, 1))s, elapsed=$([Math]::Round($elapsedSec, 0))s); skipping restart." "INFO"
                        } else {
                            $consecutiveStartingChecks++
                            if ($consecutiveStartingChecks -ge $MaxStartingChecks -or $elapsedSec -ge $maxStartingAbsoluteSeconds) {
                                Write-SupervisorLog "Health watchdog triggered (reason=starting_timeout) after $consecutiveStartingChecks/$MaxStartingChecks stalled STARTING checks (cpu=$([Math]::Round($treeCpuSeconds, 1))s, elapsed=$([Math]::Round($elapsedSec, 0))s) for PID=$($proc.Id): status='$pStatus', worker_status='$pWorkerStatus', last_error='$pLastError'. Terminating deadlocked worker process tree for restart." "ERROR"
                                Stop-ProcessTreeSafe -TargetPid $proc.Id
                                [void](Clear-UnhealthyOcrPortListener -Port $BindPort)
                                break
                            } else {
                                Write-SupervisorLog "Health watchdog probe for PID=$($proc.Id): worker is warming up ($consecutiveStartingChecks/$MaxStartingChecks stalled checks, cpu=$([Math]::Round($treeCpuSeconds, 1))s, status='$pStatus', worker_status='$pWorkerStatus'); skipping degraded increment (degraded=$consecutiveDegradedChecks/$UnhealthyThreshold, unreachable=0/$UnreachableThreshold)." "INFO"
                            }
                        }
                    } elseif ($pReachable) {
                        $consecutiveUnreachableChecks = 0
                        $consecutiveStartingChecks = 0
                        $consecutiveDegradedChecks++
                        if ($consecutiveDegradedChecks -ge $UnhealthyThreshold) {
                            Write-SupervisorLog "Health watchdog triggered (reason=degraded) after $consecutiveDegradedChecks/$UnhealthyThreshold consecutive degraded checks (${HealthProbeIntervalSeconds}s interval, ${HealthProbeTimeoutSeconds}s timeout) for PID=$($proc.Id): status='$pStatus', worker_status='$pWorkerStatus', last_error='$pLastError'. Terminating worker process tree for restart." "ERROR"
                            Stop-ProcessTreeSafe -TargetPid $proc.Id
                            [void](Clear-UnhealthyOcrPortListener -Port $BindPort)
                            break
                        } else {
                            Write-SupervisorLog "Health watchdog check (reason=degraded) $consecutiveDegradedChecks/$UnhealthyThreshold for PID=$($proc.Id): status='$pStatus', worker_status='$pWorkerStatus', last_error='$pLastError'." "WARN"
                        }
                    } else {
                        $consecutiveUnreachableChecks++
                        if ($consecutiveUnreachableChecks -ge $UnreachableThreshold) {
                            Write-SupervisorLog "Health watchdog triggered (reason=unreachable) after $consecutiveUnreachableChecks/$UnreachableThreshold consecutive unreachable checks (${HealthProbeIntervalSeconds}s interval, ${HealthProbeTimeoutSeconds}s timeout) for PID=$($proc.Id): status='$pStatus', worker_status='$pWorkerStatus', last_error='$pLastError'. Terminating worker process tree for restart." "ERROR"
                            Stop-ProcessTreeSafe -TargetPid $proc.Id
                            [void](Clear-UnhealthyOcrPortListener -Port $BindPort)
                            break
                        } else {
                            Write-SupervisorLog "Health watchdog check (reason=unreachable) $consecutiveUnreachableChecks/$UnreachableThreshold for PID=$($proc.Id): status='$pStatus', worker_status='$pWorkerStatus', last_error='$pLastError'." "WARN"
                        }
                    }
                }

                Start-Sleep -Seconds 1
            }

            if (Test-Path -LiteralPath $StopFile) {
                break
            }

            # Ensure no orphaned child python process remains on port 8020 when .venv launcher exits.
            Stop-ProcessTreeSafe -TargetPid $proc.Id
            [void](Clear-UnhealthyOcrPortListener -Port $BindPort)

            $exitCode = $null
            try { $exitCode = $proc.ExitCode } catch { $exitCode = $null }
            $uptimeSeconds = ((Get-Date) - $launchStart).TotalSeconds
            Write-SupervisorLog "OCR worker PID=$($proc.Id) exited (exitCode=$exitCode, uptime=$([Math]::Round($uptimeSeconds, 1))s)." "WARN"

            $restartCount++
            if ($uptimeSeconds -ge 60.0) {
                $backoffSeconds = 5
            }

            $state["workerPid"] = $null
            $state["listenPid"] = $null
            $state["status"] = "backoff"
            $state["restartCount"] = $restartCount
            $state["lastExitCode"] = $exitCode
            Write-StateFile -State $state

            Write-SupervisorLog "Restarting OCR worker after ${backoffSeconds}s backoff."
            if (-not (Sleep-Interruptible -Seconds $backoffSeconds)) { break }
            $backoffSeconds = [Math]::Min(30, $backoffSeconds * 2)
        } catch {
            Write-SupervisorLog "Error launching or monitoring OCR worker: $($_.Exception.Message)" "ERROR"
            if ($null -ne $proc -and -not $proc.HasExited) {
                Stop-ProcessTreeSafe -TargetPid $proc.Id
            }
            [void](Clear-UnhealthyOcrPortListener -Port $BindPort)
            $restartCount++
            $state["workerPid"] = $null
            $state["listenPid"] = $null
            $state["status"] = "backoff"
            $state["restartCount"] = $restartCount
            Write-StateFile -State $state
            if (-not (Sleep-Interruptible -Seconds $backoffSeconds)) { break }
            $backoffSeconds = [Math]::Min(30, $backoffSeconds * 2)
        } finally {
            # Clear sensitive variables from memory between iterations.
            $workerToken = ""
            Remove-Item -Path "Env:VIREAD_OCR_WORKER_TOKEN" -ErrorAction SilentlyContinue
        }
    }

    $state["workerPid"] = $null
    $state["listenPid"] = $null
    $state["status"] = "stopped"
    Write-StateFile -State $state
    Write-SupervisorLog "Supervisor stopping cleanly."
} finally {
    if ($hasMutex -and $null -ne $mutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    if ($null -ne $mutex) {
        try { $mutex.Dispose() } catch {}
    }
}
