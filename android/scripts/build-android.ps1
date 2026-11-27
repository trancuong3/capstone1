# Build and verify ViRead Android debug APK (strict public HTTPS default, or opt-in LAN acceptance).
# Uses isolated F:\c1\tools toolchain automatically if JAVA_HOME / ANDROID_HOME / gradle are not set.
param(
    [string]$FrontendUrl = $env:VIREAD_FRONTEND_URL,
    [switch]$LanMode,
    [string]$CaCert = $env:VIREAD_LAN_CA_CERT,
    [string]$BackendHealthUrl = $env:VIREAD_BACKEND_HEALTH_URL,
    [string]$ToolsRoot = "F:\c1\tools"
)

$ErrorActionPreference = "Stop"

if (-not $FrontendUrl) {
    throw "Set VIREAD_FRONTEND_URL (or pass -FrontendUrl) to a live HTTPS Next.js origin; refusing placeholder APK."
}

$env:VIREAD_FRONTEND_URL = $FrontendUrl
if ($LanMode -or ($env:VIREAD_LAN_MODE -in @("1", "true", "yes", "on"))) {
    $env:VIREAD_LAN_MODE = "1"
    if (-not $CaCert) {
        throw "LAN acceptance build requires -CaCert or VIREAD_LAN_CA_CERT pointing to the ViRead LAN Test CA PEM file."
    }
    $env:VIREAD_LAN_CA_CERT = (Resolve-Path $CaCert).Path
    if (-not $BackendHealthUrl) {
        $env:VIREAD_BACKEND_HEALTH_URL = "$($FrontendUrl.TrimEnd('/'))/_viread_api/health"
    } else {
        $env:VIREAD_BACKEND_HEALTH_URL = $BackendHealthUrl
    }
} else {
    $env:VIREAD_LAN_MODE = ""
    $env:VIREAD_LAN_CA_CERT = ""
}

# Wire isolated toolchain if system env vars are absent
if (-not $env:JAVA_HOME -and (Test-Path (Join-Path $ToolsRoot "jdk-17\bin\java.exe"))) {
    $env:JAVA_HOME = Join-Path $ToolsRoot "jdk-17"
}
if (-not $env:ANDROID_HOME -and (Test-Path (Join-Path $ToolsRoot "android-sdk"))) {
    $env:ANDROID_HOME = Join-Path $ToolsRoot "android-sdk"
    $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
}
$gradleCmd = if (Get-Command gradle -ErrorAction SilentlyContinue) {
    "gradle"
} elseif (Test-Path (Join-Path $ToolsRoot "gradle-8.11.1\bin\gradle.bat")) {
    Join-Path $ToolsRoot "gradle-8.11.1\bin\gradle.bat"
} else {
    throw "Gradle 8.11.1 not found in PATH or $ToolsRoot\gradle-8.11.1"
}
$env:GRADLE_USER_HOME = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $ToolsRoot "gradle-home" }

Write-Host "[1/4] Running Python preflight check..."
python (Join-Path $PSScriptRoot "verify_frontend.py")
if ($LASTEXITCODE -ne 0) { throw "HTTPS Next.js frontend verification failed; no APK created." }

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $root
try {
    Write-Host "[2/4] Running Gradle unit tests, lint, and assembleDebug..."
    $gradleArgs = @(
        "--no-daemon",
        "-PvireadUrl=$FrontendUrl"
    )
    if ($env:VIREAD_LAN_MODE -eq "1") {
        $gradleArgs += "-PvireadLanMode=1"
        if ($env:VIREAD_LAN_CA_CERT) {
            $gradleArgs += "-PvireadLanCaCert=$($env:VIREAD_LAN_CA_CERT)"
        }
    } else {
        $gradleArgs += "-PvireadLanMode=0"
    }
    $gradleArgs += @(":app:testDebugUnitTest", ":app:lintDebug", ":app:assembleDebug")
    & $gradleCmd @gradleArgs
    if ($LASTEXITCODE -ne 0) { throw "Gradle build failed (exit $LASTEXITCODE)" }

    $apkPath = Join-Path $root "app\build\outputs\apk\debug\app-debug.apk"
    if (-not (Test-Path $apkPath)) { throw "Expected APK missing at $apkPath" }

    Write-Host "[3/4] Verifying APK signature and computing SHA-256..."
    $apksigner = Join-Path $env:ANDROID_HOME "build-tools\35.0.0\apksigner.bat"
    if (Test-Path $apksigner) {
        & $apksigner verify --verbose --print-certs $apkPath
        if ($LASTEXITCODE -ne 0) { throw "apksigner verification failed (exit $LASTEXITCODE)" }
    }

    Write-Host "[4/4] Running automated APK quality, branding & secret audit..."
    python (Join-Path $PSScriptRoot "verify_apk_quality.py") $apkPath
    if ($LASTEXITCODE -ne 0) { throw "APK quality audit failed (exit $LASTEXITCODE)" }

    $sha = (Get-FileHash -Algorithm SHA256 -Path $apkPath).Hash.ToLowerInvariant()
    $sizeMb = [math]::Round((Get-Item $apkPath).Length / 1MB, 2)
    Write-Host "Debug APK: $apkPath ($sizeMb MB)"
    Write-Host "SHA-256:   $sha"
} finally {
    Pop-Location
}
