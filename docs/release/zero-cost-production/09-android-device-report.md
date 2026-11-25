# 09 — Android Device Report

**Date:** 2026-11-25  
**Device:** HONOR X9d (MTN-NX1)  
**Status:** BLOCKED — Device not connected during this session

---

## 1. Android Architecture

ViRead Android app uses **WebView + Native wrapper** architecture:
- Core app logic is in Next.js (web)
- Android app is a thin wrapper loading `https://viread-frontend.vercel.app/`
- Native code handles: camera (OCR image capture), microphone permissions, deep links

### Tech Stack
```
Android (minSdk 24, targetSdk 33)
  └── WebView → https://viread-frontend.vercel.app/
        ├── Sherpa-ONNX WASM STT (runs in WebView's JS engine)
        ├── TTS: MediaPlayer → Supabase Storage MP3 URLs
        └── Camera intent → image upload to OCR queue
```

---

## 2. Expected Test Matrix (Not Executed)

| Test | Expected | Evidence |
|------|----------|----------|
| App install | APK installs on HONOR X9d | ⏳ Not tested |
| WebView loads | https://viread-frontend.vercel.app loads | ⏳ Not tested |
| Login | Email/password auth works | ⏳ Not tested |
| Book catalog | Books render in WebView | ⏳ Not tested |
| TTS (cached) | Audio plays via MediaPlayer | ⏳ Not tested |
| STT (WASM) | Microphone → transcript in WebView | ⏳ Not tested |
| Camera → OCR | Image upload queues OCR job | ⏳ Not tested |
| Offline read | Cached pages available offline | ⏳ Not tested |

---

## 3. How to Run Android Tests

**Prerequisites:**
1. Connect HONOR X9d via USB
2. Enable USB Debugging in developer options
3. Authorize computer on device

**Commands:**
```powershell
# Verify device connected
adb devices -l

# Check if WebView is current (Android System WebView)
adb shell dumpsys package com.google.android.webview | Select-String versionName

# Build debug APK
cd F:\c1\capstone1-master-release\android
.\gradlew assembleDebug

# Install
adb install app\build\outputs\apk\debug\app-debug.apk

# Launch
adb shell am start -n com.viread.app/.MainActivity

# Monitor logs
adb logcat -s ViRead WebView
```

---

## 4. Blocking Issues

| Issue | Impact |
|-------|--------|
| HONOR X9d not connected during session | All Android tests blocked |
| Sherpa-ONNX WASM in Android WebView | May need flag `webview.enableWebAssembly=true` — not verified |
| Microphone permission on Android | Needs `android.permission.RECORD_AUDIO` in manifest |

---

## 5. Recommendation

Before production release:
1. Connect HONOR X9d, run `adb devices` to verify
2. Install debug APK, verify WebView loads app
3. Test microphone permissions (request at first use)
4. Test TTS audio plays (MediaPlayer + cached MP3)
5. Document `adb logcat` output as evidence

This can be completed by the project owner with the HONOR X9d connected.
