# ViRead Section 3D — True Offline / Airplane Mode PoC Architecture & Audit

**Audit Date:** 2026-11-25  
**Scope:** `F:\c1\capstone1-rc-zero-cost\android\` and `F:\c1\capstone1-rc-zero-cost\frontend\`

---

## 1. Verified Current-State Gap Audit (No On-Device Inference Today)

Inspection of the current Android shell and frontend media pipeline confirms **zero** on-device AI inference and **zero** offline reading capability in Airplane Mode today:

1. **Pure Server-Backed WebView Shell (`MainActivity.java`, `TrustedNavigation.java`):**
   - `MainActivity.configureWebViewSettings()` configures `setJavaScriptEnabled(true)`, `setDomStorageEnabled(true)`, `setAllowFileAccess(false)`, `setAllowContentAccess(true)` (for `content://` document & camera URIs only), `setMixedContentMode(MIXED_CONTENT_NEVER_ALLOW)`, and registers **zero** `@JavascriptInterface` native bridge objects (`MainActivity.java:67,226-251`).
   - `TrustedNavigation` enforces a single exact HTTPS origin (`https://<host>:443` in production; explicit RFC1918 HTTPS port in debug LAN mode) and blocks `http:`, `file:`, `intent:`, and `javascript:` top-level navigation (`TrustedNavigation.java:20-79,127-133`).
   - On main-frame network errors, 5xx HTTP errors, SSL errors, or `LOAD_TIMEOUT = 25_000L`, `MainActivity.onMainFrameFailure()` immediately sets `webView.setVisibility(View.INVISIBLE)` and shows the native `errorOverlay` card (`MainActivity.java:451-475`). In Airplane Mode, the app cannot open or read any book.
2. **Gradle & Native Dependencies (`android/app/build.gradle`, `AndroidManifest.xml`):**
   - `minSdk 26`, `targetSdk 35`, `compileSdk 35`.
   - `dependencies` contains only `androidx.core:core:1.13.1`, `androidx.browser:browser:1.8.0`, and unit-test libraries (`junit`, `androidx.test:core`, `robolectric`). There is no `onnxruntime-android`, no `sherpa-onnx` AAR, no Room/SQLCipher encrypted store, and no WorkManager background sync.
3. **WebView Speech & Browser WASM Gap (`frontend/lib/reading/local-segment-speech-recognition.ts`, `android-webview-media-compat.test.tsx`):**
   - Android System WebView does **not** expose `window.SpeechRecognition` / `webkitSpeechRecognition` (`android-webview-media-compat.test.tsx:152-157`).
   - `LocalSegmentSpeechRecognition` captures 16 kHz mono PCM via `AudioWorkletNode` (`blob:` module) or `ScriptProcessorNode` and uploads WAV slices to FastAPI `/voice/speech-to-text`, which fails in Airplane Mode.
   - `TtsPlayback` (`tts-playback.ts`) fetches synthesized audio from FastAPI `/voice/text-to-speech`, `/voice/text-to-speech/timed`, and `/voice/text-to-speech/phonics` (with `audio/mpeg` negotiation and automatic `audio/wav` fallback); there is no Service Worker / IndexedDB offline book/audio pack and no WebAssembly STT/TTS worker yet.

---

## 2. Model Feasibility Audit (Measured Local Artifacts)

Measured on disk in `F:\c1\tools\voice-runtime\`:

| Component | Verified On-Disk Footprint | Phonemizer / Runtime Dependency | Airplane Mode Feasibility (Android / Browser WASM) |
| --- | --- | --- | --- |
| **Sherpa-ONNX Vietnamese STT** (`sherpa-onnx-zipformer-vi-30M-int8-2026-02-09`) | **34,221,252 bytes (~34.22 MB)** (`encoder.int8.onnx` 27.70 MB + `decoder.onnx` 5.17 MB + `joiner.int8.onnx` 1.03 MB + `bpe.model`/`bpe.vocab`/`tokens.txt` 0.32 MB) | Self-contained ONNX + BPE Zipformer transducer; no `espeak-ng` or external G2P required | **VIABLE** — fits inside Android APK / on-demand asset pack or Browser WASM (`sherpa-onnx` WebAssembly / JNI AAR) with low RAM overhead |
| **VieNeu-TTS v3 Turbo + MOSS Codec** (`pnnbao-ump/VieNeu-TTS-v3-Turbo` + `MOSS-Audio-Tokenizer-Nano-ONNX`) | **~738 MB total cache** (`onnx_update` fp32 475.38 MB + `onnx_int8` 165.47 MB + `denoiser.onnx` 42.66 MB + `MOSS` codec 90.56 MB); minimal `onnx_int8` + `MOSS decode` alone is **~210.7 MB** | Depends on Python `vieneu_utils.phonemize_text` (`normalize_to_chunks_v3_with_gaps`) / native G2P phonemizer; **no** Java/Kotlin or Browser WASM phonemizer runtime ships in repo | **NOT VIABLE** for thin APK / Browser WASM live inference today (size >210–738 MB + Python/native phonemizer dependency) |

**Conclusion:** True Offline / Airplane Mode should pair **on-device Sherpa-ONNX 34.22 MB STT** with **pre-downloaded compressed MP3/OGG catalog TTS packs** (and optional Android `android.speech.tts.TextToSpeech` Vietnamese system fallback when installed), **not** on-device VieNeu synthesis.

---

## 3. Scoped PoC Architecture for Section 3D True Offline / Airplane Mode

### A. Security-Hardened Allowlisted Native Bridge (Android Shell -> WebView)
- **Strict Origin Gate:** Register a single capability-scoped bridge (or `WebViewCompat.addWebMessageListener` restricted to `Set.of(navigation.getOrigin())`) ONLY after verifying `navigation.isTrusted(view.getUrl())`. Never expose filesystem paths, SQLite handles, or auth tokens to JS.
- **Explicit Allowlisted Operations:**
  1. `getOfflineCapabilities()` -> `{ sttModelReady, cachedBookIds, pendingSyncCount }`.
  2. `transcribePcm16k(sessionId, pageId, turnId, pcmBase64OrTransferable)` -> runs Sherpa-ONNX JNI (`OfflineRecognizer` / `OnlineRecognizer` with `encoder.int8.onnx` + `decoder.onnx` + `joiner.int8.onnx` + `bpe.model` + `tokens.txt` + book `hotwords` keyterms) off the UI thread and returns `{ text, latencyMs }`.
  3. `getOfflineBookPackage(bookId)` / `queueOfflineReadingEvent(payload)` -> reads/writes strictly scoped per-user encrypted cache.

### B. Encrypted Local Book, Audio & Session Cache
- **Android Native Storage:** AndroidX `Security-Crypto` (`MasterKey` backed by Android Keystore AES-256-GCM) + SQLCipher / encrypted Room DB + encrypted `filesDir/offline_packs/<user_sha256>/<book_id>/` containing:
  - Verified page text + word bboxes (`ReadingPageDTO[]`) + book keyterms.
  - Pre-synthesized compressed TTS clips (`audio/mpeg`, `manifest.json` keyed by `(voice_id, model_version, speed, page_id)`).
  - **Eviction & Logout Hygiene:** Wipe user-scoped offline cache immediately on sign-out or inactive account detection (`active == false`).
- **Browser WASM Path (Alternative for Desktop/Android Chrome PWA):**
  - Serve `sherpa-onnx` WASM (`wasm-unsafe-eval` opt-in in CSP `script-src` only when enabled) inside a dedicated Web Worker, storing the 34.22 MB model and downloaded `audio/mpeg` page bundles in Cache Storage / IndexedDB (requires user opt-in "Tải sách đọc ngoại tuyến").

### C. Idempotent Offline Sync & Deferred Scoring Integrity
- **Local Outbox Queue:** While offline, `reading-screen.tsx` records `ReadingAttempt` / `ComparisonSegment` / `RetryWordEvent` entries locally with a deterministic `client_event_id` (UUIDv4) and `idempotency_key` (`session_id + page_revision_id + turn_seq`).
- **Drain on Reconnect:** Android `WorkManager` (`NetworkType.CONNECTED` constraint) or frontend `online` listener drains queued events in chronological order via idempotent FastAPI endpoints (`POST /reading/sessions/{id}/events` with `Idempotency-Key`), preserving `page_revision_id` fencing so stale/soft-deleted revisions reconcile cleanly without duplicate scoring or lost progress.
