# Run from any directory; requires Java 17, Android SDK 35 and Gradle 8.11.1.
$ErrorActionPreference = "Stop"
if (-not $env:VIREAD_FRONTEND_URL) {
  throw "Set VIREAD_FRONTEND_URL to a deployed public HTTPS Next.js origin; refusing placeholder APK."
}
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $root
try {
  gradle --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
  if ($LASTEXITCODE -ne 0) { throw "Gradle build failed (exit $LASTEXITCODE)" }
  Write-Host "Debug APK: $root\app\build\outputs\apk\debug\app-debug.apk"
} finally { Pop-Location }
