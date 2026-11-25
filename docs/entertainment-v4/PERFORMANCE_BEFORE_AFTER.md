# Frontend, Game, Karaoke & Android Performance — BEFORE & AFTER Audit (ViRead Play & Learn V4.0)

- **Audit Date:** 2026-11-25
- **Branch / Baseline SHA:** `feature/viread-intelligent-play-learn-v4` @ `29e2da36`
- **Audited Subsystems:**
  - `frontend/components/entertainment/` (`entertainment-screen.tsx`, `sentence-shooter/*`, `picture-description/*`)
  - `frontend/components/karaoke/` & `frontend/hooks/use-karaoke-*.ts` & `frontend/lib/karaoke/*`
  - `frontend/components/reports/` (parent reports integration surface)
  - `android/` (`MainActivity.java`, `AndroidManifest.xml`, `app/build.gradle`) + `adb devices -l`

---

## 1. BEFORE — Baseline Frontend Vitest Suite

Executed from `frontend/` with **Vitest v5.0.0** at `2026-11-25 19:20:06 +07:00`:

```powershell
npx vitest run test/picture-description-ui.test.tsx test/sentence-shooter-ui.test.tsx test/karaoke-*.test.* tests/karaoke/*.test.*
```

- **Result:** **22 / 22 test files PASSED**, **335 / 335 tests PASSED**, **0 failed**, **0 skipped**.
- **Total Duration:** **12.83s** (environment 57%, tests 15%, setup 13%, transform 9%, import 5%, worker 1%; 22 isolated workers spawned).

| Test File | Tests | Status | Duration |
| --- | ---: | --- | ---: |
| `test/picture-description-ui.test.tsx` | 7 | PASS | 5,208 ms |
| `test/karaoke-stage.test.tsx` | 19 | PASS | 4,007 ms |
| `test/karaoke-admin.test.tsx` | 17 | PASS | 3,187 ms |
| `test/sentence-shooter-ui.test.tsx` | 5 | PASS | 3,155 ms |
| `test/karaoke-wizard.test.tsx` | 26 | PASS | 2,739 ms |
| `test/karaoke-parent.test.tsx` | 16 | PASS | 1,717 ms |
| `test/karaoke-syllables.test.tsx` | 11 | PASS | 1,396 ms |
| `test/karaoke-player.test.tsx` | 14 | PASS | 585 ms |
| `test/karaoke-processing-status.test.tsx` | 8 | PASS | 573 ms |
| `test/karaoke-library-processing.test.tsx` | 1 | PASS | 220 ms |
| `tests/karaoke/karaoke-microphone.test.ts` | 30 | PASS | 202 ms |
| `test/karaoke-processing-services.test.ts` | 30 | PASS | 137 ms |
| `test/karaoke-autosave.test.tsx` | 17 | PASS | 132 ms |
| `test/karaoke-processing.test.tsx` | 14 | PASS | 106 ms |
| `test/karaoke-services.test.ts` | 22 | PASS | 103 ms |
| `tests/karaoke/live-singing-score.test.ts` | 10 | PASS | 50 ms |
| `test/karaoke-lyrics.test.ts` | 31 | PASS | 44 ms |
| `tests/karaoke/singing-score.test.ts` | 17 | PASS | 29 ms |
| `tests/karaoke/microphone-signal.test.ts` | 4 | PASS | 28 ms |
| `tests/karaoke/scoring-v2.test.ts` | 14 | PASS | 26 ms |
| `test/karaoke-repeat-lyrics.test.ts` | 16 | PASS | 23 ms |
| `tests/karaoke/omission-capture.test.ts` | 6 | PASS | 17 ms |
| **TOTAL (22 files)** | **335** | **ALL PASS** | **12.83 s** |

*Observed non-fatal test stderr noise:* `HTMLMediaElement.play()` jsdom stub warnings; React DOM boolean prop warnings on Next `<Image>` test mocks (`fill={true}` in `sentence-shooter-ui.test.tsx`, `unoptimized={true}` in `karaoke-parent.test.tsx`).

---

## 2. BEFORE — Sentence Shooter Latency & Responsiveness Audit

**Files:**
- `frontend/components/entertainment/sentence-shooter/sentence-shooter-screen.tsx` (1,277 lines)
- `frontend/components/entertainment/sentence-shooter/toy-cannon.tsx` (65 lines)
- `frontend/lib/api/sentence-shooter-service.ts` (225 lines)
- `frontend/app/globals.css` (L651–697)

### 2.1 Exact Tap-to-Feedback Code Path Trace

1. **Tap handler (`sentence-shooter-screen.tsx:939`):** `onClick={() => selectToken(token)}`.
2. **`selectToken(token)` (L255–286):**
   - Guards against `actionLockRef.current || isBusy || isPaused || mode !== "playing" || placedTokenIds.has(token.id)` (L256–264).
   - Locks board synchronously via `actionLockRef.current = true` (L265); sets `selectedTokenId`, `firingTokenId`, clears `hintTargetId`, `error`, `feedback` (L266–270).
   - **Forced Synchronous Layout #1 (L275–276):** Calls `target.getBoundingClientRect()` and `cannon.getBoundingClientRect()` to compute `cannonAngle`.
   - Calls `void fireToken(token)` (L285).
3. **`fireToken(token)` (L386–473):**
   - Sets `isBusy = true` (L410) — **disables EVERY word token button (`disabled={placed || isBusy || isPaused}`, L934) and Hint button (L973)** for the full HTTP round-trip!
   - Calls `animateShot(token.id)` (L412):
     - **Forced Synchronous Layout #2 in the same tick (L293–295):** Re-reads `arena.getBoundingClientRect()`, `cannon.getBoundingClientRect()`, and `target.getBoundingClientRect()` despite `selectToken` having just measured `cannon` and `target`.
     - Spawns single-star CSS projectile (`sentence-shot-flight`, `280ms`, `globals.css:687-689`), cleared on `onAnimationEnd` (L1016).
   - Optional Web Audio cue: `if (soundEnabled) playSound("shot")` (L413). Note: **`soundEnabled` defaults to `false` (L164)**, and `playSound()` (L82–126) allocates and closes a **brand-new `AudioContext`** on every single sound event instead of reusing one context.
   - **PRIMARY LATENCY BOTTLENECK — Synchronous Network Wait (`await shooterService.shoot(...)`, L416–424):**
     - `POST /games/sentence-shooter/sessions/{id}/shots` with `20,000ms` timeout (`sentence-shooter-service.ts:129, 176-184`).
     - **Zero optimistic placement / zero local immediate feedback:** While waiting, the UI displays `"Đang kiểm tra từ bé chọn…"` (L968), dims the button (`opacity-70`, L929), and **freezes the entire board** (`isBusy === true`, `actionLockRef.current === true`).
     - Correct token placement (`setPlacedTokens`, L430), wrong-token wobble (`setWobbleTokenId`, L455, `260ms`), and correct/wrong audio cues (L433, L456) **ALL wait for the HTTP response**.
     - On mobile/production networks (150–600ms+ RTT, or 1–3s under DB/cold-start load), the `280ms` projectile finishes and vanishes before any result appears, creating a visible dead pause and dropping any rapid follow-up taps from the child.
4. **Server Reconciliation & Retry (L395–406, L425–471):**
   - Generates/reuses idempotent `request_id` in `pendingRetryRef` when retrying the same `(roundId, tokenId)` after network error, and uses `sessionEpochRef` + `inFlightAbortRef` to discard stale responses on exit/restart.
   - **Unlock occurs ONLY in `finally` (L467–471)** after HTTP resolution/failure.
5. **Round Prefetch & Result Fetch (L445–453, L516–541, L360–384):**
   - **Already optimized:** Final shot of a non-final round returns `response.next_round`, stored in `prefetchedNextRound` (L451); `continueToNextRound()` swaps immediately in **0 ms** (L519–541), falling back to `POST /next-round` (L549) only if absent.
   - **Already non-blocking on completion:** On `session_completed`, transitions to `mode="result"` immediately (L448) while `GET /result` resolves asynchronously (L360–384), rendering `"—"` placeholders until loaded (L707–709).
   - **Hint bottleneck (L475–514):** `requestHint()` also locks `actionLockRef` + `isBusy` across a full `POST /hints` network round-trip.

### 2.2 Sentence Shooter BEFORE Bottleneck Summary

| Metric / Aspect | BEFORE State | Root Cause |
| --- | --- | --- |
| Tap → cannon aim & projectile start | ~16–32 ms (2× synchronous `getBoundingClientRect` reflows) | Duplicate layout reads in `selectToken` (L275–276) & `animateShot` (L293–295) |
| Tap → token placed / wobble / sound verdict | **Full HTTP RTT** (50–600 ms+ typical; up to 20s timeout) | No optimistic client placement/validation; verdict gated strictly on `await shooterService.shoot` (L416–457) |
| Rapid consecutive taps by child | **Dropped / blocked** for entire HTTP RTT | `actionLockRef.current = true` (L265) + `disabled={isBusy}` on all buttons (L934) |
| Round transition (`continueToNextRound`) | **0 ms** when prefetched (1 RTT fallback) | `response.next_round` already prefetched (L451) |
| Audio feedback | Off by default (`false`, L164); new `AudioContext` per SFX (L88) | Allocation overhead + silent default |

---

## 3. BEFORE — Karaoke Scoring Algorithm, Audio Clock & Re-Render Audit

**Files:**
- `frontend/hooks/use-karaoke-player.ts` (292 lines)
- `frontend/hooks/use-karaoke-scoring.ts` (610 lines)
- `frontend/lib/karaoke/live-singing-score.ts` (518 lines)
- `frontend/lib/karaoke/singing-score.ts` (107 lines)
- `frontend/lib/karaoke/microphone-signal.ts` (108 lines)
- `frontend/lib/karaoke/recognition-capture.ts` (213 lines)
- `frontend/lib/karaoke/recognition-provider.ts` (47 lines)
- `frontend/components/karaoke/karaoke-player.tsx` (104 lines)
- `frontend/components/karaoke/karaoke-stage.tsx` (887 lines)
- `frontend/components/karaoke/syllable-lyrics.tsx` (153 lines)
- `frontend/components/karaoke/syllable-lyrics.module.css` (70 lines)
- `frontend/components/karaoke/karaoke-score-card.tsx` (186 lines)

### 3.1 What Karaoke Scoring Actually Measures Today

| Dimension | Measured Today? | Exact Implementation & Limitation |
| --- | --- | --- |
| **Word / Lyric Correctness** | **YES (only dimension)** | Browser `SpeechRecognition` / `webkitSpeechRecognition` (`vi-VN`, `continuous=true`, `interimResults=true`, `recognition-provider.ts:20-46`). Aligned to lyric tokens via exact-match DP LCS `uniqueAnchors` (`live-singing-score.ts:99-143`). Outputs `matched`, `different`, `omitted`, or `unknown`. Final score (`karaoke-score-card.tsx:35-39, 62`) is `100 * matchedWords / evaluatedWords` ("Điểm đúng lời"). |
| **Pitch / Melody / Intonation** | **NO (0%)** | Zero F0 / pitch / contour / autocorrelation / YIN analysis anywhere in `frontend/lib/karaoke/`. |
| **Rhythm / Beat / Onset Timing** | **NO (0%)** | Zero beat tracking, tempo alignment, or syllable onset deviation scoring. Capture timestamps are only coarse 3–7s line-boundary ASR slices (`use-karaoke-scoring.ts:330-352`) with `finalLagMs = 750ms` (`live-singing-score.ts:51`) used purely to locate text tokens. |
| **Voice / Silence (Omission)** | **Conservative RMS heuristic only** | `SingingSignalClassifier` (`microphone-signal.ts:6-44`) computes time-domain RMS & peak on `AnalyserNode` (`fftSize=2048`) every `50ms` (`setInterval`, L82–102) on the authorized `MediaStreamTrack`. Marks a word `omitted` ONLY if `quietMs >= duration * 0.98` AND zero `uncertainAudio` AND ASR slice drains cleanly (`live-singing-score.ts:435-459`). |
| **Backing Track Playback During Scored Mode** | **MUTED by default!** | `KaraokeStage.selectMode(true)` calls `player.setMuted(true)` (`karaoke-stage.tsx:253`). Child must check **"Mình đang đeo tai nghe · Bật nhạc đệm"** (L467–485) to hear music while being scored; on speakers, the child sings in silence to prevent ASR bleed. |
| **Measured ASR Accuracy Baseline** | **Low coverage / high raw WER** | Documented in `docs/karaoke-live-scoring/V2-IMPLEMENTATION.md:171-184`: Chrome on public Vietnamese ELLA songs gave **30.0%–107.69% raw WER**, assessing only **0/23 to 14/30 words** (`0%–47%`); Edge returned **0 words** (`insufficient`); child-voice accuracy remains unverified. |

### 3.2 Audio Clock & React Re-Render Performance Hotspots

1. **60fps Full-Tree Re-Render Cascade (`use-karaoke-player.ts:46-67` → `karaoke-player.tsx:56-71` → `karaoke-stage.tsx:31-887`):**
   - `useKaraokePlayer` schedules `requestAnimationFrame(tick)` calling `setCurrentMs(Math.round(audio.currentTime * 1000))` on **every animation frame (~60 Hz)**.
   - `PlayerSession` passes a fresh object literal `source={{ ...source, lyrics }}` (`karaoke-player.tsx:65`) and `player` into the unmemoized 887-line `KaraokeStage` on every frame.
   - **Per-frame work triggered 60×/second in `KaraokeStage`:**
     - 3 scans of `lines`: `activeLyricIndex` (L71), `lines.find` (L73), `lines.findLastIndex` (L77).
     - Full-song flatten + 4 `.filter()` loops over all words (`liveWords`, `liveMatched`, `liveWrong`, `liveOmitted`, `pendingWords`, L391–400).
     - Re-reconciles the entire `<details>` line-selector list (`lines.map(...)`, L791–804) every frame even when collapsed.
     - **`useEffect` on `player.currentMs` (L199–226):** Calls `observePlayback(previous, current)` on every commit → loops over ALL `this.words` in `LiveSingingAttempt` (`live-singing-score.ts:386-407`) → whenever any word's phase changes (`upcoming → listening → processing`), allocates a brand-new deep `result()` copy of every line/word and triggers a `useSyncExternalStore` update, causing a **second synchronous React render** in the same frame!
2. **Per-Frame Allocations in `SyllableLyrics` (`syllable-lyrics.tsx:25-150`):**
   - Reconstructs `stateById` and `phaseById` `Map`s on every 60fps tick (L25–31).
   - Re-runs `splitSingingText()` + Unicode regex `/[\p{L}\p{N}]/u` for every syllable on every tick (L37–38, L98–99).
   - Animates fill via inline CSS variable `--karaoke-fill` driving `clip-path: inset(...)` (`syllable-lyrics.module.css:12`) — compositor-friendly compared to `width`, but still incurs 60fps React reconciliation overhead across the whole stage.
3. **Recurring `AudioContext` + `setInterval` Churn During Scored Singing (`use-karaoke-scoring.ts:330-405`, `microphone-signal.ts:54-103`):**
   - `scheduleSlice` runs a `100ms` `setInterval` (L335–351) and stops/restarts `SpeechRecognition` every **3–7 seconds** at line boundaries.
   - Every slice restart calls `stopSignal()` (closing `AudioContext`) and `monitorSingingTrack()` (creating a **new `AudioContext` + `MediaStreamAudioSourceNode` + `AnalyserNode`** and a `50ms` `setInterval` calling `getFloatTimeDomainData(2048)` on the main thread).
4. **Admin `SyllableTimingEditor` Unconditional 60fps Idle Loop (`syllable-timing-editor.tsx:67-76`):**
   - Runs a separate `requestAnimationFrame` calling `setTime(getCurrentMs())` continuously at 60fps **even when audio is paused**, re-rendering the entire syllable timing editor while idle.

---

## 4. BEFORE — Picture Description, Entertainment Hub & Parent Reports Audit

### 4.1 Entertainment Hub (`frontend/components/entertainment/entertainment-screen.tsx`, 92 lines)
- Currently exposes **3 activities**: `Xạ thủ ghép câu` (`/entertainment/sentence-shooter`), `Kể chuyện qua tranh` (`/entertainment/picture-description`), and `Hát vui cùng bé` (`/karaoke`).
- **Missing:** No 4th game slot (AI Memory Game) yet.

### 4.2 Picture Description (`frontend/components/entertainment/picture-description/picture-description-screen.tsx`, 2,266 lines)
- Single monolithic client component (2,266 lines).
- **Redundant Catalog Refetches:** Creating/evaluating any session increments `catalogRefreshKey` (L515, L555, L622, L812), re-fetching both `getCatalog` and `listSessions` in the background while the child is still in the practice/result view.
- **Voice UX Latency & Zero Live Transcript in Production:** `startVoiceRecording` (L654–657) explicitly restricts browser `SpeechRecognition` to `isInjectedTestSpeechRecognition(rawCtor)` only — in production, real children see **no live words** while speaking and wait (`isTranscribing`) after stopping for a full ElevenLabs STT upload & response (`speechService.transcribe`, L722–726).
- **Blocking AI Round-Trips:** Both image analysis (`isAnalyzing`) and story evaluation (`isEvaluating`) block interaction until backend LLM completion.

### 4.3 Parent Reports Integration Points (`frontend/components/reports/`)
- Grep across all 17 files in `frontend/components/reports/**` confirms **0 references** to `sentence-shooter`, `picture-description`, `karaoke`, `entertainment`, or `memory`.
- Parent reports (`progress-report-screen.tsx`, `child-progress-assessment.tsx`, `session-history-screen.tsx`, `difficult-words-screen.tsx`) currently surface **Reading Sessions only**.
- **Clean V4.0 Integration Points:**
  1. `frontend/components/reports/progress-report-screen.tsx` (metric grid L349–353 and collapsible sections below L510–523) — ideal host for an additive "Hoạt động Vui học" (Play & Learn) summary card.
  2. `frontend/components/reports/child-progress-assessment.tsx` — natural location for cross-activity skill indicators (vocabulary, sentence building, rhythm/singing, visual memory).
  3. `frontend/components/reports/difficult-words-screen.tsx` — direct deep-link hook to practice difficult reading words inside Sentence Shooter / Picture Storytelling / Memory Game.

---

## 5. BEFORE — Android Shell & Device Audit (`android/`)

### 5.1 ADB Connected Devices Check (2026-11-25)
- Command: `adb devices -l`
- Output: ADB daemon started cleanly on `tcp:5037`; **0 devices / emulators attached** (`List of devices attached` empty). Physical/emulator testing requires connecting a device later.

### 5.2 Manifest, Gradle & WebView Media/Mic Permissions

| File | Verified Configuration | Implication for Play & Learn V4.0 |
| --- | --- | --- |
| `android/app/build.gradle` | `compileSdk 35`, `minSdk 26`, `targetSdk 35`, `applicationId 'vn.viread.android'`, `versionName '0.1.0'`. Enforces HTTPS Next.js origin (`verifyVireadFrontend`) and live check (`verifyLiveFrontend` on `assembleDebug`/`assembleRelease`, L295–297). | Debug LAN mode opt-in only; release strictly requires public HTTPS origin. |
| `android/app/src/main/AndroidManifest.xml` | Declares `INTERNET`, `ACCESS_NETWORK_STATE`, `CAMERA`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`. `usesCleartextTraffic="false"`, `enableOnBackInvokedCallback="true"`. | Mic and camera OS permissions are already declared cleanly. |
| `MainActivity.java` — WebSettings (L244–269) | `setJavaScriptEnabled(true)`, `setDomStorageEnabled(true)`, **`setMediaPlaybackRequiresUserGesture(false)` (L253)**, `setAllowFileAccess(false)`, `MIXED_CONTENT_NEVER_ALLOW`, UA appends `ViReadAndroid/1.0`. | Async Vietnamese TTS, countdown tones, and game SFX play without silent `NotAllowedError`. |
| `MainActivity.java` — WebView Mic/Cam Permissions (L378–387, L998–1118) | `WebChromeClient.onPermissionRequest` validates `navigation.isTrustedMediaOrigin(origin)`, maps `RESOURCE_AUDIO_CAPTURE` → `RECORD_AUDIO` and `RESOURCE_VIDEO_CAPTURE` → `CAMERA`, requests runtime Android permission, handles permanent denial with an App Settings dialog (L1101–1118). | `navigator.mediaDevices.getUserMedia({ audio: true })` and Web Audio API (`AudioContext` / `AudioWorklet`) work cleanly on trusted HTTPS origin. **HOWEVER, Web Speech API (`webkitSpeechRecognition`) is NOT reliably supported in Android System WebView** — making Web Audio DSP karaoke scoring far more reliable on Android APK than browser SpeechRecognition. |
| `MainActivity.java` — Background Lifecycle (L1180–1208) | `onStop()` dispatches `document.dispatchEvent(new Event('viread:android-background'))` (L1194–1195) and calls `webView.onPause()` unless awaiting system permission or file chooser. | Already wired to `useKaraokePlayer` (L159) and `useKaraokeScoring` (L584); any new V4.0 Web Audio / AudioWorklet / mic loop MUST also listen to `viread:android-background` and `visibilitychange` to release mic/audio cleanly. |

---

## 6. AFTER — Post-Optimization Measurements (Placeholder)

> **Status:** `PENDING IMPLEMENTATION` — To be populated with fresh post-implementation benchmarks and test runs.

### 6.1 Before vs After Performance Matrix

| Area & Metric | BEFORE (Measured 2026-11-25) | AFTER (Target / Measured) | Delta |
| --- | --- | --- | --- |
| Targeted frontend Vitest suite | 22 files / 335 tests PASS in 12.83s | _TBD_ | _TBD_ |
| Sentence Shooter: tap → visible token feedback | Full HTTP RTT (50–600ms+); board locked (`actionLockRef` + `isBusy`) | _TBD (target <16–50ms optimistic)_ | _TBD_ |
| Sentence Shooter: synchronous layout reflows per tap | 2× `getBoundingClientRect` pairs (`selectToken` + `animateShot`) | _TBD (target ≤1 cached/rAF)_ | _TBD_ |
| Sentence Shooter: rapid sequential tap support | Blocked until HTTP finishes | _TBD_ | _TBD_ |
| Karaoke: React re-renders during playback | Full 887-line `KaraokeStage` @ 60fps + double-render on phase changes | _TBD_ | _TBD_ |
| Karaoke: scoring dimensions measured | Word matching (Web Speech ASR) + silence RMS only (0% pitch, 0% rhythm) | _TBD (musical rhythm/pitch + honest wording)_ | _TBD_ |
| Karaoke: speaker-mode backing audio during scoring | Muted by default unless headphones checkbox ticked | _TBD_ | _TBD_ |
| Karaoke: Android WebView compatibility | Fails/disabled where `SpeechRecognition` absent | _TBD (Web Audio DSP)_ | _TBD_ |
| Admin `SyllableTimingEditor`: idle rAF loop | 60fps `setTime` even while paused | _TBD_ | _TBD_ |
| Parent Reports: Play & Learn visibility | 0 entertainment/game metrics shown | _TBD_ | _TBD_ |

### 6.2 AFTER Verification Notes

- _TBD: Record fresh Vitest counts/durations, Chrome DevTools / React Profiler frame times, Sentence Shooter tap-to-paint latency, Karaoke DSP & re-render measurements, and Android WebView checks._
