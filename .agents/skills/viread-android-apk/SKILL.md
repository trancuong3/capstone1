---
name: viread-android-apk
description: >-
  Use this skill to prepare, package, and verify a zero-cost (0 VND) Android APK for ViRead without rewriting Next.js into React Native, covering PWA/TWA, Capacitor/Gradle local builds, and Android camera/mic/Vietnamese STT compatibility.
---

# ViRead Zero-Cost (0 VND) Android APK Preparation & Verification

Complement [viread-android-build](../viread-android-build/SKILL.md) with ViRead's concrete `0 VND` APK readiness checklist, WebView vs. Chrome hardware/STT rules, and `adb` verification workflow.

> **Project Protection Rule**: Never rewrite `frontend/` (Next.js 16, 46 routes) into React Native or scaffold new mobile folders unless explicitly requested by the user. Never embed `SUPABASE_SECRET_KEY` or `ELEVENLABS_API_KEY` inside APK assets or `NEXT_PUBLIC_*` variables.

## 1. Zero-Cost Packaging Decision Checklist

1. **TWA via `@bubblewrap/cli` (Recommended Default — `0 VND`, Zero UI Rewrite)**:
   - Wraps the deployed HTTPS Next.js 16 app inside Android's full Chrome engine.
   - Preserves `MediaRecorder`, `getUserMedia` (`/book-scanner`), and `BrowserTranscriptCollector` (`webkitSpeechRecognition` `vi-VN` quota fallback) with zero native plugin glue.
   - Requires `frontend/app/manifest.ts` (or `public/manifest.webmanifest`) + `public/.well-known/assetlinks.json` matching your local signing key's SHA-256 fingerprint.
2. **Capacitor / Isolated Expo Local Prebuild (`0 VND` Local Gradle)**:
   - Use only when an offline shell or custom native bridge is required.
   - **Critical Android WebView Gotcha**: Android System `WebView` does **not** reliably provide `webkitSpeechRecognition`. You must either route utterances to FastAPI `/voice/speech-to-text` or bridge native `android.speech.SpeechRecognizer` (`vi-VN`), and handle `PermissionRequest.RESOURCE_AUDIO_CAPTURE` / `RESOURCE_VIDEO_CAPTURE` in `WebChromeClient.onPermissionRequest`.

## 2. Required Android Runtime Permissions & Responsive Checks

- `AndroidManifest.xml`: `INTERNET`, `RECORD_AUDIO` (live child reading & karaoke), `CAMERA` (book page scanner).
- Trigger microphone and camera requests strictly inside explicit user tap handlers (`useSpeechRecorder`, scanner button) — Android blocks autoplay/mount permission prompts.
- Verify touch targets (`>=44px`) and layout reflow at `390px` mobile width (`viread-figma-parity`) with safe-area insets before packaging.

## 3. Local `0 VND` APK Build & `adb` Verification (No Paid Cloud CI)

```powershell
# 1. Verify free local toolchain (OpenJDK 17 + Android platform-tools)
java -version
adb devices

# 2A. TWA signed APK (Bubblewrap)
npx.cmd @bubblewrap/cli doctor
npx.cmd @bubblewrap/cli build

# 2B. Or local Gradle APK (inside an approved android/ directory — skips paid EAS Build)
.\gradlew.bat assembleDebug

# 3. Install & inspect runtime permissions / audio logs on emulator or USB device
adb install -r app-debug.apk
adb logcat -d | Select-String -Pattern "ViRead|Speech|AudioRecord|cr_Media"
```
