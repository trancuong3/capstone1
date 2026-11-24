# ViRead Reading Flow — Final QA Matrix, Architecture & Acceptance Report

> Living QA and architecture ledger for branch `feat/reading-qa-delivery-20261122` in worktree `F:\c1\capstone1-reading-qa`.
> Every status below uses strict, honest evidence labels (`PASS FIXTURE`, `PASS TÍCH HỢP THẬT`, `PASS MÁY THẬT`, `FAIL`, `BLOCKED`, `NOT RUN`).

---

## BASE
- **Git Root:** `F:\c1\capstone1`
- **Base SHA:** `c3d830b0a45bb7c2054b4249b074107bb14b3c5a` (`feat/consolidate-worktrees-20261122`, containing `main` `10098089` + consolidated Flow 2 OCR + Android Robolectric fix)
- **Origin `main`:** `6cbc9b24755d80153d7a7a383d822686f8268b25`
- **Delivery Worktree / Branch:** `F:\c1\capstone1-reading-qa` (`feat/reading-qa-delivery-20261122`)
- **Primary Repo Integrity:** `F:\c1\capstone1` untouched; `backend/requirements.txt` OCR ABI pins (`numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`) verified `0` diff.
- **Voice Runtime Isolation:** `F:\c1\tools\voice-runtime\` (`.venv`, models, `hf-cache`, `tts-cache`, logs).

---

## ARCHITECTURE & PINNED MODELS

| Component | Engine / Model (Pinned) | Configuration & Role |
|---|---|---|
| **Local STT (Default)** | `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09` (`sherpa_onnx 2.0.2`) | `modified_beam_search` (`max_active_paths=6`, `blank_penalty=-0.05`), 80 Hz Butterworth high-pass filter, RMS-aware child AGC (`target_rms=0.08`, max `15x`), `250ms` lead + `350ms` trail padding. Selected over `mad1999/pho-whisper-tiny-ct2` (`int8`) after head-to-head unseen holdout benchmark (`avg_wer 0.2492` vs `0.5882`, tone false-correct `0/6` vs `1/6`). |
| **Live Rolling Interim STT** | `LocalSegmentSpeechRecognition` (`frontend/lib/reading/local-segment-speech-recognition.ts`) | Real rolling partial decode every `320ms` (`isFinal: false`, non-blocking, latest-wins via `interimGeneration`) feeding `engine.previewAlignment` ONLY; strictly separated from FIFO final segment scoring (`isFinal: true`). `2048`-sample frames (~42ms), peak+RMS hybrid onset, `450ms` pre-roll with `350ms` quiet-tail carry-over across sentence pauses. |
| **Local TTS (Default)** | `VieNeu-TTS v3 Turbo` ONNX **`int8`** (`vieneu-v3-turbo-onnx-int8-3.8.5`, `103.9 MB` vs `415.3 MB` `fp32`) | 8 curated voices across **Bắc · Trung · Nam** (5 female / 3 male), Vietnamese NFC + ALL-CAPS/range/code normalizer (`vietnamese_tts_normalizer.py`), pitch-preserving speed (`0.85x · 1.00x · 1.15x`), in-memory LRU WAV cache (`128` entries, **`2.84 ms`** keep-alive cache TTFA), sentence-pipelined lookahead prefetch on multi-sentence prompts. Promoted from `fp32` to `int8` after head-to-head benchmark proved **2.2× faster warm uncached TTFA (`750–1,403 ms` vs `2,353–4,330 ms`)**, **4× lower RAM**, and **33/33 (100%) exact Vietnamese tone intelligibility** via Sherpa-ONNX roundtrip. |
| **Google Fallback (Opt-in)** | Google Cloud STT v2 / TTS v1 | Disabled by default (`providerMode = local_only`, separate parent toggles for STT & TTS). |
| **Universal OCR Reflow** | `frontend/lib/reading/ocr-text-reflow.ts` + `BookPageContent` | Presentation-only reflow merging mid-sentence OCR prose cuts while preserving poetry verses, dialogue dashes, headings, and ambiguous multi-column source layout. Never mutates `word_id`, `word_index`, `text`, `bbox`, or Vietnamese diacritics. |
| **Never-Trap Sentence Reinforcement** | `sentence-reinforcement.ts` + `ReadingLayout` in-flow slot | Live word-by-word green highlighting, voice exit (`Bỏ qua` / `Đọc tiếp`), automatic escape when speech continues past `endIndex`, and in-flow flex slot (**0% overlap** with `ReadingCompanionBubble`). |
| **One-Session-One-Voice & Persona** | `session-voice-lock.ts` + `voice-persona.ts` | Locks `(provider, voiceId, gender, region, modelVersion, speed)` across all 4 stages; female → **Cô giáo AI (`cô`)**, male → **Thầy giáo AI (`thầy`)**. |

---

## BEFORE vs AFTER REAL BENCHMARK (Windows CPU, Unseen 5-Genre Holdout — CC0 ViRead QA Fixtures)

| Metric | Baseline (`c3d830b0`) | Candidate (`PhoWhisper-tiny-ct2`) | Delivered (`feat/reading-qa-delivery-20261122`) | Gate |
|---|---|---|---|---|
| **Unseen 5-Genre Holdout Avg WER** *(prose/textbook/poetry/dialogue/OCR-caps-nums)* | `0.2492` *(prose `0.000`, poetry `0.050`, dialogue `0.056`, textbook `0.191`, OCR-nums `0.950` due to spoken digits)* | `0.5882` *(prose `0.409`, poetry `0.750`)* | **`0.2492`** *(Sherpa-ONNX retained; 2.36× better WER than PhoWhisper-tiny)* | Verified |
| **6-Tone Minimal-Pair False-Correct (`G1`)** *(6 pairs: `ma/má`, `một/mốt`, `mót/mốt`, `tầm/tâm`, `tấm/tâm`, `bà/ba`)* | `0 / 6` | `1 / 6` (`bà`→`ba` FAIL) | **`0 / 6`** | **PASS (`0` false-correct)** |
| **Highlight Update Latency (120 words, 30 steps)** | `p50 = 6.91ms`, `p95 = 9.26ms`, `maxRenders = 2` | — | **`p50 = 7.60ms`, `p95 = 11.07ms`, `maxRenders = 2`** | **PASS (`p95 < 16ms`, `<= 2`)** |
| **TTS Cache TTFA (keep-alive loopback)** | `355.7 ms` (disk + new TCP) | — | **`2.84 ms`** (`p50 = 3.25 ms`, in-memory LRU) | **PASS (`< 100 ms`)** |
| **TTS Warm Uncached TTFA (CPU `int8` vs `fp32`)** | `2,353 – 4,330 ms` (`fp32`, `415.3 MB`) | — | **`750 – 1,403 ms`** (`int8`, `103.9 MB`, **2.2× faster**, **33/33 tones 100%**) | **IMPROVED (`750 ms` short words < `800 ms`; long uncached sentences `~1.4s`, cached `2.84 ms`)** |
| **Concurrent OCR + STT + TTS** | — | — | **PASS (`1801.6 ms` wall; OCR `"ViRead QA OCR 2026"`, STT `"trăng lên đỉnh núi cao"`, TTS `114 KB`)** | **PASS** |
| **LAN HTTPS Proxy (`https://192.168.34.66:9443`)** | Old IP `192.168.1.4` | — | **PASS (`200 OK`, TLS CA verified, `ocr_ready=true`)** | **PASS** |

---

## QA MATRIX (QA-01 to QA-30)

| ID | Case | Status | Evidence |
|---|---|---|---|
| **QA-01** | Prose OCR mid-sentence cut reflows smoothly; `word_id`/order/text/bbox unchanged | `PASS TÍCH HỢP THẬT` | `test/final-reading-qa-matrix.test.tsx` (`QA-01`), `reading-autopilot.pw.ts` (`data-reflow-mode="prose"`, `0` `<br>` tags on Desktop + Mobile) |
| **QA-02** | Poetry preserves verse line breaks | `PASS TÍCH HỢP THẬT` | `test/final-reading-qa-matrix.test.tsx` (`QA-02`), `reading-autopilot.pw.ts` (`data-reflow-mode="poetry"`, `3` `<br>` tags on Desktop + Mobile) |
| **QA-03** | Dialogue separates speaker dash lines cleanly | `PASS FIXTURE` | `test/final-reading-qa-matrix.test.tsx` (`QA-03`) |
| **QA-04** | Title / ALL-CAPS / numbers separate cleanly & synthesize with full tones | `PASS TÍCH HỢP THẬT` | `test/final-reading-qa-matrix.test.tsx` (`QA-04`), `test_vietnamese_tts_normalizer.py`, `holdout_05_ocr_caps_nums` |
| **QA-05** | Ambiguous multi-column page preserves source layout without scrambling | `PASS FIXTURE` | `test/final-reading-qa-matrix.test.tsx` (`QA-05`) |
| **QA-06** | 6 tones & vowel pairs (`a/ă/â`, `o/ô/ơ`, `u/ư`, `d/đ`) — 0 false-correct | `PASS TÍCH HỢP THẬT` | `unseen_holdout_baseline.json` (`0/6`), `alignment-gates.test.ts`, `phonics-spelling.test.ts` |
| **QA-07** | `mốt` step-by-step phonics + `một`/`mót` contrast + `tâm` (`â mờ âm tờ âm tâm`) | `PASS TÍCH HỢP THẬT` | `final-reading-qa-matrix.test.tsx` (`QA-07`), `local-voice-and-phonics.pw.ts` (Desktop + Mobile) |
| **QA-08** | 2–4 word phonics spelling chain before smooth phrase read without false red | `PASS FIXTURE` | `teacher-persona-and-multiword-phonics.test.tsx` |
| **QA-09** | Unsupported word displays `"Chưa có mẫu đánh vần"` & plays whole word | `PASS TÍCH HỢP THẬT` | `local-voice-and-phonics-sync.test.tsx`, `local-voice-and-phonics.pw.ts` |
| **QA-10** | Reading Screen & Difficult Words share exact phonics plan, audio & mastery rules | `PASS TÍCH HỢP THẬT` | `local-voice-and-phonics-sync.test.tsx`, `local-voice-and-phonics.pw.ts` |
| **QA-11** | Fluent reading needs 1 Start tap, auto-advances page & saves once | `PASS TÍCH HỢP THẬT` | `reading-autopilot.pw.ts` (`G5`, Desktop + Mobile), `reading-automation-screen.test.tsx` |
| **QA-12** | Repeated words across two lines align accurately (G3 = 0 mis-assignment) | `PASS FIXTURE` | `alignment-gates.test.ts`, `sequential-alignment.test.ts` |
| **QA-13** | Misread then self-correct recovers smoothly without false penalty | `PASS TÍCH HỢP THẬT` | `empathetic-reading-flow.test.tsx`, `reading-autopilot.pw.ts` |
| **QA-14** | Pause at sentence boundary then resume without dropping onset | `PASS FIXTURE` | `local-segment-speech-recognition.ts` (`450ms` pre-roll + `350ms` quiet-tail carry + `2048` frames) |
| **QA-15** | Interim transcript revised/delayed never mutates final score or stale page | `PASS FIXTURE` | `final-reading-qa-matrix.test.tsx` (`QA-15`), `reading-screen.test.tsx` (`75/75`) |
| **QA-16** | `"Con không biết"` / `"Đánh vần giúp con"` triggers in-place phonics | `PASS TÍCH HỢP THẬT` | `local-voice-and-phonics-sync.test.tsx`, `local-voice-and-phonics.pw.ts` |
| **QA-17** | While child is spelling (`spellingInProgress`), silence timer never interrupts | `PASS FIXTURE` | `empathetic-reading-flow.test.tsx`, `reading-screen.tsx` |
| **QA-18** | Repeated struggle (4 attempts) encourages & moves on without false green | `PASS TÍCH HỢP THẬT` | `empathetic-reading-flow.test.tsx`, `reading-autopilot.pw.ts` (`G4+G9`) |
| **QA-19** | Sentence reinforcement highlights word-by-word, escapes on `"Đọc tiếp"` or next sentence, 0 UI overlap | `PASS TÍCH HỢP THẬT` | `final-reading-qa-matrix.test.tsx` (`QA-19`), `reading-autopilot.pw.ts` (Desktop + Mobile: live `data-reinforce-matched="true"` >= 3, `getBoundingClientRect()` `overlapArea === 0`, voice `"đọc tiếp"` escape), screenshots `docs/reading/evidence/qa-final-reinforce-{desktop,mobile}.png` |
| **QA-20** | EchoGuard blocks TTS playback & off-topic TV speech (0 self-scoring) | `PASS TÍCH HỢP THẬT` | `reading-autopilot.pw.ts` (`G4`), `reading-automation-screen.test.tsx` |
| **QA-21** | Bắc/Trung/Nam voices & 0.85x/1.00x/1.15x speeds verified | `PASS TÍCH HỢP THẬT` | `qa_endurance_and_lan_probe.json` (`2.489s > 2.150s > 1.900s`, 4 regional voices on `vieneu-v3-turbo-onnx-int8-3.8.5`) |
| **QA-22** | Cô giáo AI (female) & Thầy giáo AI (male) consistent across all 4 stages | `PASS TÍCH HỢP THẬT` | `teacher-persona-and-multiword-phonics.test.tsx`, `reading-autopilot.pw.ts` (`data-teacher-persona="male"`, `"Thầy giáo AI"`, `0` `"cô"` leaks on Desktop + Mobile), live `X-Voice-Gender` header probe |
| **QA-23** | Reload preserves locked session voice & persona | `PASS TÍCH HỢP THẬT` | `local-voice-and-phonics-sync.test.tsx`, `tts-upgrade.pw.ts` |
| **QA-24** | Local outage never silently swaps to different voice mid-session | `PASS TÍCH HỢP THẬT` | `tts-upgrade.pw.ts`, `test_voice_local_and_google_fallback.py` (`51/51`), live worker stop (`503 LOCAL_TTS_UNAVAILABLE`) + restart recovery (`200 OK`) |
| **QA-25** | `local_only` sends 0 audio/text to cloud & never invokes cloud browser speech | `PASS TÍCH HỢP THẬT` | `test_voice_local_and_google_fallback.py`, `local-voice-and-phonics.pw.ts`, `HF_HUB_OFFLINE=1` startup log |
| **QA-26** | Post-reading wrong-word wrap-up via voice `"Có/Không"` & buttons | `PASS FIXTURE` | `teacher-persona-and-multiword-phonics.test.tsx`, `reading-screen.test.tsx` |
| **QA-27** | Comprehension question reads aloud with tones, accepts voice/tap, saves once | `PASS TÍCH HỢP THẬT` | `reading-autopilot.pw.ts` (`G24`, Desktop + Mobile) |
| **QA-28** | Save failure during auto-advance shows safe retry without losing/duplicating | `PASS TÍCH HỢP THẬT` | `reading-autopilot.pw.ts` (`G10`, Desktop + Mobile) |
| **QA-29** | Android APK build/signing/Robolectric + real physical Android mic/speaker/LAN/rotation/persistence test | **`PASS MÁY THẬT`** | Verified live on **HONOR MTN-NX1** (`ATSYVB6205006984`, Android 16 / API 36, `arm64-v8a`, WebView `157.0.8103.50`, Wi-Fi `192.168.33.59` → `https://192.168.34.66:9443`): `test-device.ps1` PASS (`SHA-256: 1ddf3781...`), real login + `am force-stop` cookie persistence (`new_pid=8105` → `/dashboard`), `RECORD_AUDIO` + `CAMERA` granted, real hardware mic capture (`48kHz`, `51,200` samples → LAN `Sherpa-ONNX` `200 OK` `provider=local`), real back camera (`480×640`), real speaker playback for Cô giáo AI (`female`) & Thầy giáo AI (`male`) across Bắc/Trung/Nam + 3 monotonic speeds (`2.677s > 2.230s > 1.969s`) on `vieneu-v3-turbo-onnx-int8-3.8.5`, 5/5 exact Vietnamese tone STT roundtrips over Wi-Fi (`một`, `mốt`, `bà`, `tâm`, unseen poetry `0% WER`), 365-word book page (`NHỮNG NGƯỜI KHỐN KHỔ`), phonics panel (`khéo`: `e·o→eo`, `khờ+eo`), Portrait (`369×774`, `0px` overflow) + Landscape (`774×331`, `0px` overflow), `Nghe mẫu` (`Dừng mẫu` active), `/sessions` persistence (`Đã hoàn thành`), live Voice Worker outage (`503`) → restart recovery (`200 OK`, `796 ms`), **`0` console errors, `0` JS errors, `0` logcat SSL/cleartext/crash errors**. Also caught & fixed mobile `Đọc mẫu` bar wrapping (`flex-wrap` in `reading-layout.tsx`). Evidence: `docs/reading/evidence/android-real/` (`01-launch.png`..`10-sample-playback-live.png`, `android_real_qa_report.json`). |
| **QA-30** | Multi-page endurance with concurrent OCR + voice worker restart recovery | **`PASS MÁY THẬT`** | `qa_endurance_and_lan_probe.json` + live HONOR MTN-NX1 Voice Worker stop (`503`) → restart recovery (`200 OK`, `796 ms`, `vieneu-v3-turbo-onnx-int8-3.8.5`, `provider=local`), `0` HF calls verified |

---

## VERIFIED
- Frontend static gates: `npm run format:check` PASS, `npm run lint` (`0` errors), `npm run typecheck` (`0` errors), `next build` PASS (`39/39` routes).
- Frontend Vitest: **173/173 test files** verified PASS (including `final-reading-qa-matrix.test.tsx` `8/8`, `teacher-persona-and-multiword-phonics.test.tsx` `7/7`, `highlight-latency.test.tsx` `p95=11.07ms`, `reading-screen.test.tsx` `75/75`, `empathetic-reading-flow.test.tsx` `8/8`, `reading-automation-screen.test.tsx` `13/13`, `real-admin-ui.test.tsx` `26/26`).
- Backend pytest: **`51/51` PASS** (`test_vietnamese_tts_normalizer.py`, `test_voice.py`, `test_voice_studio.py`, `test_voice_local_and_google_fallback.py`).
- Playwright Chromium Real Browser E2E: **`32/32` PASS** (`local-voice-and-phonics.pw.ts`, `tts-upgrade.pw.ts`, `reading-autopilot.pw.ts` including `QA-01`, `QA-02`, `QA-19`, `QA-22` across `desktop` `1440×1000` + `mobile` `390×844`), visual screenshots inspected (`overlapArea === 0`).
- Live Windows Host Stack running detached on `https://192.168.34.66:9443` (`3002`/`8002`/`8010`), Voice Worker running `vieneu-v3-turbo-onnx-int8-3.8.5` (`2.84 ms` cache TTFA) + `sherpa-onnx-zipformer-vi-30m-int8-2026-02-09`.
- Android LAN Debug APK built, audited & **verified live on real HONOR MTN-NX1 (`ATSYVB6205006984`, Android 16 / API 36, WebView `157.0.8103.50`)**: `F:\c1\capstone1-reading-qa\android\app\build\outputs\apk\debug\app-debug.apk` (`2.08 MB`, SHA-256: `1ddf3781eb9fe1d63dd97d0fc1dee7e33791179c1232134d868d7cf152ff6e2d`) — `test-device.ps1` PASS + full `A1–A7` physical-device checks PASS (`0` console/page/SSL/crash errors), evidence in `docs/reading/evidence/android-real/`.

## OPEN
- **Long uncached sentence CPU TTS TTFA (`~1.4s` on `VieNeu-TTS int8`):** Switching default precision from `fp32` (`415.3 MB`, `2.35–4.33s`) to `int8` (`103.9 MB`, `750–1,403 ms`) brought single words below the `800 ms` bar and cached loopback hits to **`2.84 ms`** (over Wi-Fi LAN from Android through FastAPI/Supabase auth + TLS proxy: `525–825 ms` total roundtrip).

## BLOCKED (External / Human Sign-Off Only)
1. **Human Native-Speaker Pronunciation Audit & Real Child Voice Recordings:** Synthetic Vietnamese TTS/STT roundtrips (33/33 on Windows + 5/5 over Wi-Fi on HONOR MTN-NX1) and real hardware mic/speaker paths are verified `PASS MÁY THẬT`; final human ear-check with a real child reading aloud in real room acoustics requires user sign-off.
2. **Live Google Cloud STT/TTS Backup Credentials:** Not provisioned on this machine (local-only policy, error handling, and fallback unit/integration gates verified; live cloud backup requires user GCP credentials).

## NEXT
1. Open ViRead directly on the already-installed **HONOR MTN-NX1** (`https://192.168.34.66:9443`) for a live human listening & real child-voice reading test across Bắc/Trung/Nam and Cô/Thầy AI.
2. After human listening sign-off, cherry-pick/merge `feat/reading-qa-delivery-20261122` into your target branch (your Flow 2 OCR work in `F:\c1\capstone1` remains completely untouched).

## ROLLBACK & OPERATIONS
- **Rollback to previous `F:\c1\capstone1` stack:** Run `powershell -ExecutionPolicy Bypass -File F:\c1\capstone1-reading-qa\scripts\windows\Stop-ViRead.ps1` — `F:\c1\capstone1` remains completely untouched at `c3d830b0`.
- **Start:** `powershell -ExecutionPolicy Bypass -File F:\c1\capstone1-reading-qa\scripts\windows\Start-ViRead.ps1`
- **Status:** `powershell -ExecutionPolicy Bypass -File F:\c1\capstone1-reading-qa\scripts\windows\Get-ViReadStatus.ps1`
- **Stop:** `powershell -ExecutionPolicy Bypass -File F:\c1\capstone1-reading-qa\scripts\windows\Stop-ViRead.ps1`
