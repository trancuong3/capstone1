---
name: viread-android-build
description: >-
  Use this skill when evaluating web-to-Android migration options for ViRead, planning zero-cost Android APK packaging (TWA, Capacitor, or Expo/React Native), handling Android camera/microphone/STT permissions, or preparing local Gradle APK build steps.
---

# ViRead Android APK Strategy & Zero-Cost Build Guide

> **Guardrail**: Do **not** scaffold mobile directories, modify existing web code, or install Android Studio / SDK packages automatically unless the user explicitly approves an implementation phase.

## 1. Web-to-Android Architecture Tradeoffs for ViRead

ViRead relies on **HTTPS camera (`getUserMedia`)**, **microphone recording (`MediaRecorder`)**, and **`BrowserTranscriptCollector` (`webkitSpeechRecognition`)** fallback alongside Next.js 16 SSR/App Router (`46` routes). Choose the packaging strategy that matches project goals:

| Strategy | Effort | Cost | Speech / Mic / Camera Behavior | Best When |
| :--- | :--- | :--- | :--- | :--- |
| **A. PWA + Trusted Web Activity (TWA / Bubblewrap)** | Lowest (1–2 days) | `0 VND` | Runs inside real **Android Chrome** engine; `MediaRecorder`, `getUserMedia`, and Web Speech API work natively over HTTPS + Digital Asset Links. | Shipping a production-faithful APK of the deployed Next.js web app with zero UI rewrite. |
| **B. Capacitor Android Wrapper (`@capacitor/android`)** | Medium | `0 VND` | Android System `WebView` supports `getUserMedia`/`MediaRecorder` (with manifest permissions) **but lacks reliable `webkitSpeechRecognition`** — requires `@capacitor-community/speech-recognition` or backend STT. | Wrapping web UI into a standalone APK while bridging native Android speech/camera APIs. |
| **C. Incremental Expo / React Native (`expo-web-to-native` + `expo-dom`)** | High | `0 VND` (local build) | Native UI (`expo-router`, `expo-native-ui`) + shared TypeScript logic (`lib/reading/*`, `lib/api/*`) + native audio/speech modules; complex web views can mount incrementally via `expo-dom`. | Building a dedicated offline-capable native mobile experience. |

## 2. Mandatory Android Permissions (All Paths)

Any Android manifest (`AndroidManifest.xml`) for ViRead must declare and request at runtime on explicit user gesture:
- `android.permission.INTERNET`
- `android.permission.RECORD_AUDIO` (live child reading & karaoke)
- `android.permission.CAMERA` (book scanner `/book-scanner`)

Keep backend secrets (`SUPABASE_SECRET_KEY`, ElevenLabs API key) strictly on the FastAPI server — **never** embed server keys inside APK assets or client env vars (APKs are trivially decompiled).

## 3. Zero-Cost Direct APK Build Workflows

### Path A — TWA APK via Bubblewrap (No Android Studio GUI needed)
1. Ensure deployed ViRead web app serves `manifest.webmanifest` + `/.well-known/assetlinks.json`.
2. Initialize & build signed APK locally with OpenJDK 17 + Android Command-Line Tools:
   ```powershell
   npx.cmd @bubblewrap/cli init --manifest https://<your-viread-domain>/manifest.webmanifest
   npx.cmd @bubblewrap/cli build
   ```
   Output: `app-release-signed.apk` (installable directly via `adb install`).

### Path B / C — Local Gradle APK (Capacitor or Expo Prebuild, $0 Cloud Cost)
Avoid paid EAS Cloud Build limits by generating native Android project files and compiling locally with Gradle:
```powershell
# For Expo project (in isolated mobile directory when approved):
npx.cmd expo prebuild --platform android
Set-Location android
.\gradlew.bat assembleDebug
# Debug APK: android\app\build\outputs\apk\debug\app-debug.apk
```
For release APK signing (free local keystore):
```powershell
keytool -genkeypair -v -storetype PKCS12 -keystore viread-release.keystore -alias viread -keyalg RSA -keysize 2048 -validity 10000
.\gradlew.bat assembleRelease
```

## 4. Related Installed Skills

When the user approves mobile implementation, load the matching specialist skill:
- `expo-web-to-native`, `expo-dom`, `expo-router`, `expo-native-ui`, `expo-data-fetching`, `expo-design-system`, `vercel-react-native-skills`, or `android-cli` / `android-device-hub`.
