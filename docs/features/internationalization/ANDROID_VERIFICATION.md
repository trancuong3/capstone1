# ViRead Android WebView & Native Resource Verification

## Architecture Summary

- **Native String Resources (`android/app/src/main/res/`)**:
  - Default `values/strings.xml` holds Vietnamese (`vi`), guaranteeing Vietnamese default even on non-Vietnamese OS locales.
  - 29 additional locale resource directories cover all 30 registered languages: `values-ar`, `values-b+fil`, `values-b+zh+Hans`, `values-b+zh+Hant`, `values-bn`, `values-de`, `values-el`, `values-en`, `values-es`, `values-fr`, `values-hi`, `values-in`, `values-it`, `values-iw`, `values-ja`, `values-km`, `values-ko`, `values-lo`, `values-ms`, `values-my`, `values-ne`, `values-nl`, `values-pl`, `values-pt`, `values-ru`, `values-sv`, `values-th`, `values-tr`, `values-uk`.
- **Pre-Render Locale Context (`android/app/src/main/java/vn/viread/android/MainActivity.java`)**:
  - `attachBaseContext` reads the persisted locale from `SharedPreferences` (`viread_locale_prefs` / `viread_ui_locale`, defaulting to `"vi"`), preventing automatic switch to English on non-Vietnamese Android devices.
  - Synchronizes native locale state bidirectionally with the WebView `viread_locale` cookie (`CookieManager.flush()`) so WebView UI, HTML `lang`/`dir`, and native dialogs/toasts stay consistent across cold launches without restarting the app.
- **Robolectric Locale Lock (`android/app/src/test/resources/robolectric.properties`)**: Configured with `qualifiers=vi` matching production default behavior.

## Automated Android Verification Results

### 1. Android Build & Packaging Script Unit Tests

Command:

```powershell
python -B -m unittest discover -s android/scripts -p "test_*.py" -v
```

Result: **18 / 18 tests PASSED in `0.061s`** (`test_verify_apk_quality.py` and `test_verify_frontend.py`).

### 2. Gradle Compile, JVM/Robolectric Unit Tests & Lint

Command (matching `.github/workflows/android-apk.yml` validation job):

```powershell
$env:VIREAD_FRONTEND_URL='https://example.org'
gradle --no-daemon :app:testDebugUnitTest :app:compileDebugJavaWithJavac :app:lintDebug
```

Observed results:

- **Outcome**: `BUILD SUCCESSFUL in 1m 37s` (`38 actionable tasks: 16 executed, 22 up-to-date`)
- **Java Compilation**: `:app:compileDebugJavaWithJavac` passed with zero errors.
- **Lint**: `:app:lintDebug` (`abortOnError true`) passed with **0 errors** (`17` non-blocking warnings reported in `lint-results-debug.xml`).
- **Unit Tests (`:app:testDebugUnitTest`)**: **46 / 46 PASSED (`0` failed, `0` skipped)** across all 9 test suites:
  - `AppBrandingAndManifestTest`: 3 / 3 passed
  - `ErrorAndOfflineRecoveryTest`: 3 / 3 passed
  - `FileChooserAndCameraCaptureTest`: 2 / 2 passed
  - `LifecyclePermissionAndBackNavTest`: 3 / 3 passed
  - `LocalePersistenceAndResourcesTest`: 3 / 3 passed
  - `OAuthLoopbackBridgeTest`: 4 / 4 passed
  - `ServerEndpointConfigTest`: 4 / 4 passed
  - `TrustedNavigationTest`: 14 / 14 passed
  - `ViReadNativeSpeechBridgeTest`: 10 / 10 passed

## Physical Device Inspection Telemetry (Honor X9d)

Read-only and non-destructive inspection performed via ADB on connected physical device (`ATSYVB6205006984`, user data untouched):

- **Model**: `MTN-NX1` (Honor X9d), **Android 16** (SDK `36`), **ABI**: `arm64-v8a`, **OS Locale (`persist.sys.locale`)**: `vi-VN`
- **System WebView (`com.google.android.webview`)**: `157.0.8103.50`
- **Installed Package State (`vn.viread.android`)**: `versionCode=2`, `minSdk=26`, `targetSdk=35`, `versionName=0.2.0`; `CAMERA` and `RECORD_AUDIO` permissions granted (`USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED`).
- **Non-Destructive Foreground & Crash Check**:
  - `am start -n vn.viread.android/.MainActivity` -> focused `ActivityRecord{... vn.viread.android/.MainActivity}`
  - Dispatched Android Back key (`input keyevent 4`) cleanly
  - Checked `adb logcat -d -t 200`: **`CRASH_LINES=0`** (no `FATAL EXCEPTION` / `AndroidRuntime: FATAL`)

## APK Packaging Prerequisite Disclosure (`:app:assembleDebug`)

> [!IMPORTANT]
> **Full signed APK packaging requires a live HTTPS frontend origin.**
> `android/app/build.gradle` strictly enforces `:app:verifyLiveFrontend` before `:app:assembleDebug` or `:app:assembleRelease`. During local verification, `https://viread.vercel.app` returned `HTTP 404` and the workstation Wi-Fi IPv4 (`192.168.1.2`) differed from the pre-existing local dev LAN certificate (`192.168.1.4`), so we did **not** bypass `:app:verifyLiveFrontend` or regenerate certificates to package a new local APK on device. All native Java/resource changes are verified by Gradle `:app:testDebugUnitTest :app:compileDebugJavaWithJavac :app:lintDebug` (`46/46` tests, 0 lint errors) and `android/scripts` (`18/18` tests), and a full APK builds automatically when `VIREAD_FRONTEND_URL` points to an active HTTPS deployment.
