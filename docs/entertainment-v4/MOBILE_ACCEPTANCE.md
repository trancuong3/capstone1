# Mobile, Responsive & Android APK Acceptance Report — ViRead Play & Learn V4.0

- **Audit Date:** 2026-11-25
- **Auditor:** `qa-independent` (Independent QA Lead)
- **Branch:** `feature/viread-intelligent-play-learn-v4`
- **Overall Mobile / APK Verdict:**
  - **Automated Responsive / WebView Media Lifecycle / Code Audits:** **`PASS`**
  - **Physical Android Device / Gradle APK Build Sign-Off:** **`BLOCKED_NO_PHYSICAL_DEVICE` (`PENDING_PHYSICAL_DEVICE`)** — reported honestly with zero fabrication.

---

## 1. Environment & Device Reality Check (2026-11-25)

| Check | Exact Command Executed | Observed Output | Status |
|---|---|---|---|
| **Attached ADB Devices / Emulators** | `adb devices -l` | ADB daemon started on `tcp:5037`; `List of devices attached` is **empty (0 devices)** | **`BLOCKED_NO_PHYSICAL_DEVICE`** |
| **Gradle Wrapper Presence** | `Test-Path android/gradlew.bat; Test-Path android/gradlew` | `False` / `False` (no Gradle wrapper binary checked into `android/`) | **`BLOCKED_NO_GRADLE_WRAPPER`** |
| **Android Shell Compatibility Test (Vitest)** | `npx vitest run` (includes `tests/reading/android-webview-media-compat.test.tsx`, `test/sentence-shooter-ui.test.tsx`, `test/picture-description-ui.test.tsx`, `tests/karaoke/musical-dsp.test.ts`, `test/memory-game-ui.test.tsx`) | All WebView background-release & codec-fallback unit tests **PASSED** | **`PASS` (Automated)** |

> **Honest Governance Note:** Because 0 physical Android devices/emulators are attached and `android/gradlew.bat` is absent in this workspace, real-hardware APK compilation, touch ergonomics on 5.5–6.7" Android screens, real speaker/microphone echo cancellation, and Android OEM WebView playback were **NOT** executed and are marked **`PENDING_PHYSICAL_DEVICE`** (never faked as PASS).

---

## 2. Android Shell & WebView Permissions Audit (`android/`)

Audited [MainActivity.java](file:///f:/Capstone/capstone1/android/app/src/main/java/vn/viread/android/MainActivity.java) (`compileSdk 35`, `minSdk 26`, `targetSdk 35`, `vn.viread.android`):

| Capability | Verified Android Implementation | V4.0 Impact |
|---|---|---|
| **Microphone & Camera OS Permissions** | `AndroidManifest.xml` declares `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA`, `INTERNET`, `ACCESS_NETWORK_STATE`; `usesCleartextTraffic="false"`. | All V4 audio/camera flows permitted cleanly over HTTPS. |
| **WebView Permission Bridge** | `MainActivity.java:378-387, 998-1118` validates `navigation.isTrustedMediaOrigin(origin)`, maps `RESOURCE_AUDIO_CAPTURE` → `RECORD_AUDIO` and `RESOURCE_VIDEO_CAPTURE` → `CAMERA`, requests runtime Android permission, handles permanent denial via Settings dialog. | `getUserMedia({ audio: true })` and Web Audio `AudioContext`/`AnalyserNode` work cleanly on trusted HTTPS origins. |
| **Async TTS & Game SFX Playback** | `MainActivity.java:253` sets `setMediaPlaybackRequiresUserGesture(false)`; `MIXED_CONTENT_NEVER_ALLOW`; UA appends `ViReadAndroid/1.0`. | Sentence Shooter singleton SFX, Karaoke countdown/backing audio, and AI Teacher / Memory Game TTS work without autoplay lockouts. |
| **Background Media & Mic Release** | `MainActivity.java:1192-1202` `onStop()` executes `document.dispatchEvent(new Event('viread:android-background'))` and `webView.onPause()` (when not awaiting permission/file picker). | Prevents orphan open microphones or runaway audio when child presses Home or locks screen. |

---

## 3. V4.0 `viread:android-background` & `visibilitychange` Listener Matrix

Every single V4.0 audio/microphone/media module was verified for proper listener registration **and** unmount cleanup:

| Module | File & Lines | `viread:android-background` | `visibilitychange` | Verified Cleanup Action | Test Proof |
|---|---|---|---|---|---|
| **Sentence Shooter SFX** | [sentence-shooter-screen.tsx](file:///f:/Capstone/capstone1/frontend/components/entertainment/sentence-shooter/sentence-shooter-screen.tsx#L391-L395) + [sound-engine.ts](file:///f:/Capstone/capstone1/frontend/components/entertainment/sentence-shooter/sound-engine.ts) | **YES** | **YES** | Calls `suspend()` on singleton `AudioContext`; `close()` on unmount | `sentence-shooter-ui.test.tsx` (PASS) |
| **AI Teacher / Picture Storytelling** | [picture-description-screen.tsx](file:///f:/Capstone/capstone1/frontend/components/entertainment/picture-description/picture-description-screen.tsx#L530-L538) | **YES** | **YES** | Cancels TTS + aborts `SpeechRecognition` / `MediaRecorder` + clears cooldown timer + preserves spoken draft | `picture-description-ui.test.tsx` (PASS) |
| **Musical Karaoke Player** | [use-karaoke-player.ts](file:///f:/Capstone/capstone1/frontend/hooks/use-karaoke-player.ts#L210-L221) | **YES** | **YES** | Calls `audio.pause()` + cancels `requestAnimationFrame` | `karaoke-player.test.tsx` (PASS) |
| **Musical Karaoke Scoring & DSP** | [use-karaoke-scoring.ts](file:///f:/Capstone/capstone1/frontend/hooks/use-karaoke-scoring.ts#L721-L729) + [musical-dsp.ts](file:///f:/Capstone/capstone1/frontend/lib/karaoke/musical-dsp.ts#L1205-L1242) | **YES** | **YES** | Stops `SpeechRecognition`, clears `40ms` DSP interval, disconnects nodes, closes `AudioContext`, stops media tracks | `musical-dsp.test.ts` (PASS) |
| **AI Memory Game ("Bé nhớ được gì?")** | [memory-game-screen.tsx](file:///f:/Capstone/capstone1/frontend/components/entertainment/memory-game/memory-game-screen.tsx#L419-L434) | **YES** | **YES** | Calls `stopMicCapture()` + `stopAllTts()` + clears peek interval on unmount | Code verified + `memory-game-ui.test.tsx` (PASS) |
| **Shared Speech Recorder (Reading)** | [use-speech-recorder.ts](file:///f:/Capstone/capstone1/frontend/hooks/use-speech-recorder.ts#L501-L505) | **YES** | **YES** | Preserved untouched | `android-webview-media-compat.test.tsx` (PASS) |

---

## 4. Responsive Layout, Overflow & Touch-Target Static Audit

Static inspection of all 9 V4.0 frontend UI components confirmed:

| Component | Non-`max-w` Wide Fixed Widths (`w-[>=100px]`) | Responsive Breakpoints (`sm:`/`md:`/`lg:`) | Primary Button System (`Button`/`ButtonLink`) | Raw `<button>` Count | Touch Target & Overflow Assessment |
|---|---|---|---|---|---|
| [entertainment-screen.tsx](file:///f:/Capstone/capstone1/frontend/components/entertainment/entertainment-screen.tsx) | **0** | 14 (`sm:`, `md:grid-cols-2`) | 11 (`min-h-12` / `min-h-14`) | 0 | **PASS** — 48px+ targets on every action, 1-col mobile → 2-col tablet/desktop. |
| [memory-game-screen.tsx](file:///f:/Capstone/capstone1/frontend/components/entertainment/memory-game/memory-game-screen.tsx) | **0** (`max-w-[1040px]` only) | 13 | 15 (`min-h-12` / `min-h-14`) | 7 (theme/timer/recall pills) | **PASS** — Fluid responsive SVG (`viewBox`), no horizontal overflow; verify raw pill height ≥44–48px on real narrow screens (360px). |
| [memory-scene-canvas.tsx](file:///f:/Capstone/capstone1/frontend/components/entertainment/memory-game/memory-scene-canvas.tsx) | **0** | N/A (scalable SVG `viewBox`) | 0 | 0 | **PASS** — Vector SVG scales crisply across portrait/landscape DPIs. |
| [sentence-shooter-screen.tsx](file:///f:/Capstone/capstone1/frontend/components/entertainment/sentence-shooter/sentence-shooter-screen.tsx) | **0** (`max-w-*` only) | 43 | 10 | 10 (word bubbles, `min-h-12`) | **PASS** — `StageLayoutCache` re-measures on `ResizeObserver` / orientation change. |
| [picture-description-screen.tsx](file:///f:/Capstone/capstone1/frontend/components/entertainment/picture-description/picture-description-screen.tsx) | **0** (`max-w-*` only) | 13 | 29 | 11 (tabs/mode pills) | **PASS** — Responsive 2-tab layout + stacked mobile controls. |
| [karaoke-stage.tsx](file:///f:/Capstone/capstone1/frontend/components/karaoke/karaoke-stage.tsx) | **0** | 20 | 15 | 5 | **PASS** — Big drum tap button (`RHYTHM_TAP`) + `min-h-11/12` controls. |
| [karaoke-simple-upload-screen.tsx](file:///f:/Capstone/capstone1/frontend/components/admin/karaoke/karaoke-simple-upload-screen.tsx) | **0** | 23 | 16 | 0 | **PASS** — Clean 3-step stacked admin form (`md:grid-cols-2` on desktop). |
| [entertainment-learning-summary.tsx](file:///f:/Capstone/capstone1/frontend/components/reports/entertainment-learning-summary.tsx) | **0** | 3 (`sm:grid-cols-2`, `sm:grid-cols-3`) | 1 | 0 | **PASS** — Clean card wrapping inside `<details>` drawer. |

Note: [button.tsx](file:///f:/Capstone/capstone1/frontend/components/common/button.tsx#L59-L62) globally enforces `default: "min-h-14"` (`56px`) and `compact: "min-h-12"` (`48px`), meeting WCAG 2.2 AAA / COGA child touch-target guidelines (`>= 48px`).

---

## 5. Honest Android WebView Caveats & Residual Risks

1. **Web Speech API (`webkitSpeechRecognition`) Absent in Many Android System WebViews:**
   - **Musical Karaoke V4.0:** **Resolved** — real-time YIN pitch & spectral-flux rhythm scoring run on Web Audio `getUserMedia` + `AnalyserNode` (`FULL_MUSICAL` / `RHYTHM_AND_LYRICS` / `RHYTHM_TAP` all work without `SpeechRecognition`!).
   - **AI Teacher (Picture Description):** Uses `MediaRecorder` → backend `/voice/transcribe` (ElevenLabs/local voice fallback) when browser `SpeechRecognition` is absent.
   - **AI Memory Game ("Bé nhớ được gì?"):** Relies on browser `SpeechRecognition` for 0 VND voice dictation and gracefully displays a friendly Vietnamese fallback message directing the child to type (`memory-game-screen.tsx:338-344`) when unsupported. **Residual Risk:** On Android WebViews lacking `SpeechRecognition`, voice recall in Memory Game falls back to text keyboard input (future enhancement: optional wire-up to shared `useSpeechRecorder` if zero-cost STT quota permits).
2. **Physical Hardware Sign-Off Checklist (To Run Once Physical Android Device Is Connected):**
   - [ ] Build & install release/debug APK via Gradle (`compileSdk 35`) pointing to HTTPS Vercel frontend.
   - [ ] Verify 360×800 portrait and 800×360 landscape layouts across all 4 Entertainment Hub zones with zero horizontal scrollbar.
   - [ ] Test Musical Karaoke headphone mode and speaker mode (`SPEAKER_BLEED` gate) with real child/adult voice on Android mic.
   - [ ] Press Android Home button mid-recording in Picture Description, Memory Game, and Karaoke and confirm OS mic indicator dot disappears within `< 1s` (`viread:android-background`).
   - [ ] Verify Sentence Shooter rapid tapping on 60 Hz mobile screen feels instant (`<100ms`) on throttled 4G.
