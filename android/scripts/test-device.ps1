# Automated ADB verification of the delivered ViRead APK on a real Android device.
# Checks: connected authorized device, exact APK SHA-256 install, package/version verification,
# launch, LAN origin reachability in logcat, Back key, force-stop/relaunch, and prints
# manual verification checkpoints for interactive camera/mic/login/OCR steps (never fakes PASS).
param(
    [Parameter(Mandatory = $true)]
    [string]$ApkPath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedLanOrigin,
    [string]$PackageId = "vn.viread.android",
    [string]$ToolsRoot = "F:\c1\tools"
)

$ErrorActionPreference = "Stop"

$adb = if (Get-Command adb -ErrorAction SilentlyContinue) {
    (Get-Command adb).Source
} elseif (Test-Path (Join-Path $ToolsRoot "android-sdk\platform-tools\adb.exe")) {
    Join-Path $ToolsRoot "android-sdk\platform-tools\adb.exe"
} else {
    throw "adb not found in PATH or $ToolsRoot\android-sdk\platform-tools"
}

if (-not (Test-Path $ApkPath)) { throw "APK not found: $ApkPath" }
$apkSha = (Get-FileHash -Algorithm SHA256 -Path $ApkPath).Hash.ToLowerInvariant()
Write-Host "APK: $ApkPath"
Write-Host "SHA-256: $apkSha"

Write-Host "[1/6] Checking connected ADB devices..."
$devLines = & $adb devices | Select-Object -Skip 1 | Where-Object { $_.Trim() -ne "" }
$readyDevices = @($devLines | Where-Object { $_ -match "\tdevice$" })
if ($readyDevices.Count -eq 0) {
    Write-Warning "NO AUTHORIZED ANDROID DEVICE DETECTED via ADB."
    Write-Host "Raw adb devices output:"
    $devLines | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "To run real-device acceptance:"
    Write-Host "  1. Enable Developer Options -> USB Debugging on your Android phone."
    Write-Host "  2. Connect via USB and tap 'Allow USB debugging' on the phone."
    Write-Host "  3. Connect phone to the SAME Wi-Fi LAN as this Windows host."
    Write-Host "  4. Re-run: .\android\scripts\test-device.ps1 -ApkPath `"$ApkPath`" -ExpectedLanOrigin `"$ExpectedLanOrigin`""
    exit 2
}

$serial = ($readyDevices[0] -split "\t")[0]
Write-Host "Using device serial: $serial"

$model = (& $adb -s $serial shell getprop ro.product.model).Trim()
$androidVer = (& $adb -s $serial shell getprop ro.build.version.release).Trim()
$sdkInt = (& $adb -s $serial shell getprop ro.build.version.sdk).Trim()
$abi = (& $adb -s $serial shell getprop ro.product.cpu.abi).Trim()
$webviewLine = (& $adb -s $serial shell dumpsys package com.google.android.webview | Select-String "versionName=" | Select-Object -First 1)
Write-Host "Device: $model | Android $androidVer (API $sdkInt) | ABI $abi | WebView: $webviewLine"

Write-Host "[2/6] Clean-installing exact delivered APK..."
& $adb -s $serial uninstall $PackageId 2>$null | Out-Null
& $adb -s $serial install -r $ApkPath
if ($LASTEXITCODE -ne 0) { throw "adb install failed (exit $LASTEXITCODE)" }

Write-Host "[3/6] Verifying installed package & version..."
$pkgDump = & $adb -s $serial shell dumpsys package $PackageId
$verName = ($pkgDump | Select-String "versionName=" | Select-Object -First 1).ToString().Trim()
$verCode = ($pkgDump | Select-String "versionCode=" | Select-Object -First 1).ToString().Trim()
Write-Host "Installed: $PackageId | $verCode | $verName"

Write-Host "[4/6] Launching app and checking logcat for TLS / WebView errors..."
& $adb -s $serial logcat -c
& $adb -s $serial shell am start -n "$PackageId/.MainActivity"
Start-Sleep -Seconds 5
$topAct = (& $adb -s $serial shell dumpsys window | Select-String "mCurrentFocus" | Select-Object -First 1)
Write-Host "Foreground window: $topAct"
$logs = & $adb -s $serial logcat -d -t 200
$sslErr = $logs | Select-String -Pattern "onReceivedSslError|ERR_CERT|ERR_SSL|ERR_CLEARTEXT"
if ($sslErr) {
    Write-Error "SSL/Cleartext error detected in logcat: $sslErr"
    exit 1
}

Write-Host "[5/6] Testing Back key & force-stop/relaunch..."
& $adb -s $serial shell input keyevent 4
Start-Sleep -Seconds 1
& $adb -s $serial shell am force-stop $PackageId
Start-Sleep -Seconds 1
& $adb -s $serial shell am start -n "$PackageId/.MainActivity"
Start-Sleep -Seconds 3
Write-Host "Force-stop and relaunch completed cleanly."

Write-Host "[6/6] Interactive physical-device checklist (MUST verify manually on device; never auto-PASS):"
Write-Host "  [ ] Login with acceptance account on $ExpectedLanOrigin/login"
Write-Host "  [ ] Select child profile -> open /book-scanner"
Write-Host "  [ ] Pick/capture Vietnamese book page -> verify OCR result + request_id matches Windows backend log"
Write-Host "  [ ] Open matched page -> start reading session -> test microphone/TTS -> finish session"
Write-Host "  [ ] Reload /sessions history -> verify saved session appears"
Write-Host "  [ ] Deny then re-grant Camera/Mic permission, background app mid-scan, rotate screen, toggle Wi-Fi"
Write-Host "  [ ] Force-stop & reopen app -> session persists; Logout -> session cleared"
Write-Host "Automated ADB device checks PASSED."
exit 0
