# Manage minimal Private/LAN-only Windows Firewall rule (TCP 8443 ONLY)
# and optional per-user Task Scheduler logon auto-start for ViRead local host.
#
# Never disables Windows Firewall. Never exposes DB, Redis, Ollama, 8000, or 3000.
# Every action is explicitly reversible.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("AddFirewall", "RemoveFirewall", "StatusFirewall", "InstallAutostart", "RemoveAutostart", "StatusAutostart")]
    [string]$Action,
    [int]$HttpsPort = 8443,
    [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

$ruleName = "ViRead-LAN-HTTPS-$HttpsPort"
$taskName = "ViRead-LocalHost-AutoStart"
$scriptDir = $PSScriptRoot
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $scriptDir "viread-host.config.json"
}

function Test-IsAdmin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

switch ($Action) {
    "StatusFirewall" {
        $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        $net = Get-NetConnectionProfile | Select-Object Name, InterfaceAlias, NetworkCategory
        Write-Host "Network profiles:"
        $net | Format-Table -AutoSize
        if ($rule) {
            Write-Host "Firewall rule '$ruleName': PRESENT (Enabled=$($rule.Enabled), Profile=$($rule.Profile))"
        } else {
            Write-Host "Firewall rule '$ruleName': NOT INSTALLED"
        }
    }
    "AddFirewall" {
        if (-not (Test-IsAdmin)) {
            Write-Error "Adding a Windows Firewall rule requires an elevated (Run as Administrator) PowerShell prompt. Re-run this exact command as Administrator."
            exit 5
        }
        $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        if ($existing) { Remove-NetFirewallRule -DisplayName $ruleName }
        # Minimal Private-profile-only inbound rule on TCP HttpsPort ONLY (never Public, never DB/OCR ports)
        New-NetFirewallRule -DisplayName $ruleName `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $HttpsPort `
            -Profile Private `
            -RemoteAddress LocalSubnet `
            -Description "Minimal ViRead LAN HTTPS proxy rule (Private/LocalSubnet only). Reversible via RemoveFirewall." | Out-Null
        Write-Host "Added minimal Private/LocalSubnet firewall rule '$ruleName' for TCP port $HttpsPort."
        Write-Host "IMPORTANT: Ensure your Wi-Fi network profile is set to Private (Settings > Network & Internet > Wi-Fi > Properties > Private)."
    }
    "RemoveFirewall" {
        if (-not (Test-IsAdmin)) {
            Write-Error "Removing a Windows Firewall rule requires an elevated (Run as Administrator) PowerShell prompt."
            exit 5
        }
        $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        if ($existing) {
            Remove-NetFirewallRule -DisplayName $ruleName
            Write-Host "Removed firewall rule '$ruleName'."
        } else {
            Write-Host "Firewall rule '$ruleName' was not present."
        }
    }
    "InstallAutostart" {
        if (-not (Test-Path $ConfigPath)) { throw "Config file not found: $ConfigPath" }
        $startScript = (Resolve-Path (Join-Path $scriptDir "Start-ViRead.ps1")).Path
        $resolvedCfg = (Resolve-Path $ConfigPath).Path
        $actionObj = New-ScheduledTaskAction -Execute "powershell.exe" `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -ConfigPath `"$resolvedCfg`" -SkipFrontendBuild"
        $triggerObj = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settingsObj = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName $taskName -Action $actionObj -Trigger $triggerObj -Settings $settingsObj -Force | Out-Null
        Write-Host "Registered per-user logon task '$taskName'. Remove anytime via -Action RemoveAutostart."
    }
    "RemoveAutostart" {
        $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($t) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-Host "Removed scheduled task '$taskName'."
        } else {
            Write-Host "Scheduled task '$taskName' was not registered."
        }
    }
    "StatusAutostart" {
        $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($t) {
            Write-Host "Scheduled task '$taskName': INSTALLED (State=$($t.State))"
        } else {
            Write-Host "Scheduled task '$taskName': NOT INSTALLED"
        }
    }
}
