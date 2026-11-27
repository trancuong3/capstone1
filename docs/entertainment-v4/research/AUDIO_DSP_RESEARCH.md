# Audio DSP Research — Musical Karaoke Real-Time Scoring & Vocal/Instrumental Analysis

**Date:** 2026-11-25  
**Scope:** Real-time singing pitch detection, onset/rhythm tracking, vocal activity detection, melody-contour alignment, client-side Web Audio (`AudioWorklet`) vs server-side Python DSP, Android WebView acoustic constraints, and honest child-friendly scoring for ViRead Play & Learn V4.0.  
**Codebase Baseline:** Branch `feature/viread-intelligent-play-learn-v4`, SHA `29e2da36`.

---

## 1. Problem Statement

Current karaoke web experiences for children often either:
- Only measure **speech-to-text word matching** (which fails badly on sustained singing notes, vibrato, and background speaker bleed, and ignores melody and rhythm completely), OR
- Fake musical scores from raw microphone volume (RMS loudness), rewarding shouting or speaker bleed rather than genuine singing.

For ViRead Play & Learn V4.0, **Musical Karaoke** must provide **honest, real-time, child-encouraging musical evaluation** across three transparent dimensions — **Lyrics/Words**, **Rhythm/Timing**, and **Pitch/Melody** — while running smoothly at **60 fps UI / low latency** on desktop browsers and **Android WebView (APK)** with **0 VND cloud audio cost** and **zero persistence of raw child audio**.

---

## 2. Existing Implementation Audit

### Backend Audio & Karaoke Audit (`backend/` + `ai/karaoke_processing/`)
1. **Installed Python packages (`backend/.venv` vs `backend/requirements-web.txt`):**
   - `backend/.venv` (dev/OCR venv): `numpy 1.26.4`, `scipy 1.12.0`, `mutagen 1.48.1`, `pillow 12.0.0`, `onnxruntime 1.26.0`, `torch 2.14.1`. **NOT installed:** `librosa`, `aubio`, `crepe`, `pydub`, `soundfile`, `torchaudio`, `demucs`, `faster-whisper`. System `ffmpeg` / `ffprobe` are NOT on PATH.
   - `backend/requirements-web.txt` (Render Free 512 MiB production web API): includes `mutagen==1.48.1`, `numpy==1.26.4`, `pillow==12.0.0`, `opencv-python-headless==4.10.0.84`; deliberately excludes `scipy`, `torch`, `librosa`, and heavy DSP/ML packages to stay under 512 MiB RAM.
2. **Existing Karaoke Media & Storage (`backend/app/services/karaoke_media_service.py`):**
   - Uses `mutagen.mp3.MP3(BytesIO(data)).info` solely to validate MPEG Layer III format, reject `info.sketchy`, compute `duration_ms` (max `300_000 ms` = 5 min), and compute SHA-256 + `size_bytes` (max 20 MiB).
   - **Gap:** Does NOT read ID3v2 tags (`TIT2`, `TPE1`, `APIC`, `USLT`, `SYLT`) or extract reference beat/pitch contours.
3. **Existing Karaoke Lyrics & Playback Schema (`backend/app/schemas/karaoke.py`):**
   - Supports `Lyrics` `format_version: Literal[1, 2]` with `SyllableLine` (`id`, `text`, `start_ms`, `end_ms`, `syllables: list[Syllable]`).
   - `Playback` DTO returns `{song_id, version_id, title, author, duration_ms, audio_url, audio_url_expires_at, cover_url, lyrics}`.
   - **Gap:** No reference pitch contour (`f0_contour`) or beat/onset grid is stored or transmitted yet (can be added as optional additive metadata without breaking `Playback` or `TimedLyrics` contracts!).
4. **Existing Offline Alignment Engine (`ai/karaoke_processing/`):**
   - Isolated venv (`.cache/karaoke-ai/.venv` — not installed on current host) using `imageio-ffmpeg`, `demucs 4.0.1` (`htdemucs`), `nguyenvulebinh/lyric-alignment` (Wav2Vec2 CTC), `audio_clock.py` (active-anchor cross-correlation clock proof), and `acoustic_boundaries.py` (energy-valley held-note refinement).
   - Verified baseline pure DSP tests (`ai/karaoke_processing/test_acoustic_boundaries.py`, `test_audio_clock.py`, `test_ctc_boundaries.py`): **32 passed, 0 failed** (11 subtests) in 1.52s.
5. **Existing Backend Karaoke Tests:** All tracked karaoke tests in `backend/` pass cleanly (**327 passed, 8 skipped** across the 22-module baseline). Note: real-time singing scoring currently has **zero backend DSP endpoints** — live scoring runs entirely on the client (audited in detail by `auditor-frontend`).

---

## 3. Candidate DSP Algorithms & Execution Architectures

### 3.1 Pitch Estimation ($f_0$) Algorithms

| Candidate | Core Mechanism | Singing Accuracy & Octave Stability | Latency / Window | CPU Cost (JS/WASM or NumPy) | Child Voice Suitability (200–700 Hz) |
|---|---|---|---|---|---|
| **A. YIN** *(de Cheveigné & Kawahara, 2002)* | Difference function + Cumulative Mean Normalized Difference Function (CMNDF) + absolute threshold ($\tau \approx 0.12\text{--}0.15$) + parabolic interpolation | **High**; strong octave-error suppression via CMNDF; industry baseline for monophonic vocals | 1024–2048 samples (~21–43 ms @ 48 kHz; 23–46 ms @ 44.1 kHz) | Low ($O(N \cdot \tau_{\max})$; with child $f_0 \in [130, 880]\text{ Hz}$, $\tau_{\max} \approx 370$ samples → **< 0.4 ms/frame** in pure TS/Float32Array!) | **Excellent** — narrowing lag search to 130–880 Hz eliminates low-frequency rumble & sub-harmonic errors and cuts CPU by 3× |
| **B. MPM (McLeod Pitch Method)** *(McLeod & Wyvill, 2005)* | Normalized Square Difference Function (NSDF) + key-maximum peak picking with clarity metric $c \in [0,1]$ | **High**; intuitive clarity threshold ($c \ge 0.80\text{--}0.85$) cleanly separates voiced vowels from breath/consonants | 1024–2048 samples (~21–43 ms) | Low (comparable to YIN; **< 0.4 ms/frame** in Float32Array) | **Excellent** — clarity score maps cleanly to voiced/unvoiced gating and visual pitch needle confidence |
| **C. pYIN (Probabilistic YIN)** *(Mauch & Dixon, 2014)* | Multiple YIN threshold candidates + Hidden Markov Model (HMM) Viterbi decoding over pitch states | **Highest** for offline melodic contour extraction; suppresses vibrato jitter and octave flips | Requires lookahead / full-phrase Viterbi pass (offline or 200–500 ms delay) | Medium-High (HMM state lattice) | **Best for offline server/prep reference melody extraction**; overkill/too latent for real-time 20 ms AudioWorklet loop |
| **D. Raw Autocorrelation / FFT Peak Picking** | Direct time-domain autocorrelation or FFT magnitude max | **Poor** on singing: frequent octave/harmonic lock-on (formant peaks > $f_0$ in children's voices) | 2048–4096 samples | Very Low | **Unsuitable** — children's strong vocal formants trick FFT peaks constantly |
| **E. Neural Pitch (CREPE / BasicPitch / SwiftF0)** | CNN/ONNX neural network on waveform or CQT | State-of-the-art in noisy polyphonic mixtures | 16–32 ms hop + model inference | **High** (10–80 MB model weights; high mobile battery/RAM; exceeds Render 512 MiB if server-side) | Unsuitable for zero-bloat mobile WebView real-time loop |

### 3.2 Onset Detection, Rhythm & Tempo-Aligned Scoring Algorithms

| Candidate | Core Mechanism | Strengths for Children's Karaoke | Weaknesses |
|---|---|---|---|
| **A. Spectral Flux / Half-Wave Rectified Energy Envelope Onset Detection** *(Bello et al., 2005; Dixon, 2006)* | Compare consecutive short-time magnitude spectra (or multiband RMS envelope in vocal band 250–3500 Hz), half-wave rectify positive rises, adaptive median peak picking | **Fast (< 0.2 ms/frame)**; works cleanly on singing syllable attacks; easy to run in Web Audio `AudioWorklet` alongside YIN/MPM | Soft vocal attacks (slurred vowels) have weaker flux peaks than percussive instruments — mitigate using combined vocal-band energy + pitch-change novelty |
| **B. Syllable-Timeline Rhythm Matching (Reference Onsets from `TimedLyrics`)** | Compare detected child vocal onset timestamps against the song's known syllable/line `start_ms` & `end_ms` (after estimating/compensating systematic device latency offset $\Delta_{\text{lat}} \in [-180, +180]\text{ ms}$) | **Directly aligned with ViRead's existing `SyllableLine` timestamps!** Zero need for beat tracking on backing track when syllable timestamps exist; tolerant scoring window ($\pm 120\text{ ms}$ perfect, $\pm 250\text{ ms}$ good for primary children) | Requires accurate lyric timings; if only line-level timing exists (`format_version: 1`), falls back to line-entry timing + steady vocal activity coverage |
| **C. Dynamic Time Warping (DTW) on Pitch / Envelope Contours** | Elastic sequence alignment between reference contour and sung contour (Sakoe-Chiba band-constrained) | Separates tempo drift from pitch errors; great for **end-of-line / end-of-song summary scoring** on short 2–6s phrases (50–150 frames → < 2 ms in JS) | Non-causal (cannot give instant per-frame feedback; use as phrase-end refinement, not live ticker) |
| **D. Global Beat Tracking (BeatRoot / Dynamic Programming)** | Autocorrelation / comb-filter tempo induction + beat grid tracking | Useful during **Admin import** to auto-estimate BPM/beat grid of an instrumental MP3 | Overkill on child's live mic because backing audio already defines exact song clock `audio.currentTime` |

### 3.3 Execution Architecture: Client-Side Web Audio (`AudioWorklet`) vs Server-Side Python DSP

| Dimension | Client-Side Web Audio (`AudioWorklet` + Fallback `AnalyserNode`) | Server-Side Python DSP (Streaming WebSocket / Chunked Upload) |
|---|---|---|
| **Latency** | **~20–45 ms** end-to-end (real-time visual pitch guide & rhythm sparks) | 300–1500 ms (network RTT + encoding + decode) — unusable for live pitch bar |
| **Hosting Cost & RAM** | **$0 server CPU/RAM**; runs on child's browser/Android WebView | Violates Render Free 512 MiB RAM + 0.1 CPU under even 2 concurrent singers |
| **Child Audio Privacy** | **100% on-device**; zero mic PCM leaves device for pitch/rhythm scoring | Requires streaming child voice audio over the internet |
| **Android WebView Compatibility** | Supported since Chrome/WebView 64+ (requires HTTPS/localhost + `RECORD_AUDIO`). Must handle silent-destination clock bug & `AnalyserNode` fallback if AudioWorklet fails to load. | Works if MediaRecorder works, but high mobile bandwidth & battery |
| **Offline Prep Role** | N/A | **Ideal for Admin-time preprocessing** (optional vocal/instrumental detection, ID3 extraction, and offline reference $f_0$ contour extraction when a vocal track is processed!) |

---

## 4. Pros, Cons, Cost, Risks & Educational Impact

### Critical Acoustic Risks & Concrete Mitigations (Especially Mobile & Android WebView)
1. **Risk: Speaker Bleed & Telephony AEC Trap (`echoCancellation` vs Singing).**
   - *Fact (verified via MDN/WebRTC):* Default `getUserMedia({ audio: true })` enables `echoCancellation`, `noiseSuppression`, and `autoGainControl`, which are tuned for telephony speech and often **notch out sustained singing notes** or cause volume ducking. Conversely, disabling `echoCancellation` *without headphones* lets the backing track from the tablet speaker bleed into the mic!
   - *Mitigation (Dual-Mode Acoustic Strategy):*
     - Provide a simple child/parent toggle: **"Đang đeo tai nghe"** (`echoCancellation: false, noiseSuppression: false, autoGainControl: false` for pure vocal DSP) vs **"Loa ngoài" (default safe mode)** (`echoCancellation: true, noiseSuppression: false, autoGainControl: false`) so hardware AEC cancels the backing track coming from the device speaker while avoiding aggressive speech noise-suppression that clips sustained notes!
     - Add **pre-song 1.0s ambient noise floor calibration** + **speaker-bleed guard** (when mic signal strongly matches backing-track energy during known instrumental-only gaps where no lyric line is active, discount bleed rather than awarding fake singing points).
2. **Risk: Android WebView Silent-Destination Clock Stall & CPU Spikes.**
   - *Mitigation:* Connect the `AudioWorkletNode` through a `GainNode` with `gain = 0` to `audioContext.destination` (keeps the hardware audio clock pumping without creating acoustic feedback); pre-allocate a single `Float32Array(2048)` ring buffer inside `AudioWorkletProcessor` with **zero heap allocations inside `process()`**; decimate hop interval to **512 samples (~10.7 ms @ 48 kHz)** or **1024 samples (~21.3 ms)** and throttle UI messages to **20 Hz (every 50 ms)** so React never re-renders at 60–375 Hz!
   - *Graceful fallback:* If `audioContext.audioWorklet` fails (older WebView / restricted context), seamlessly fall back to a `50 ms` `requestAnimationFrame`/timer loop reading `AnalyserNode.getFloatTimeDomainData(buffer)` and running the exact same pure-TS YIN/MPM + onset module.
3. **Risk: Key / Octave Mismatch for Primary Children (Age 6–11).**
   - Children's natural singing range is typically **C4–D5 (~261–587 Hz)**, often an **octave higher** than an adult reference singer or slightly transposed.
   - *Mitigation:* Score **octave-invariant pitch classes (modulo 12 semitones)** and **relative melodic contour (semitone intervals $\Delta p_t$)** rather than punishing a Grade 1 child for singing an octave above a male/adult vocal! Also use child-friendly tolerance bands:
     - Within $\pm 75\text{ cents}$ (0.75 semitone): **Full pitch credit**
     - Within $\pm 150\text{ cents}$ (1.5 semitones): **Partial credit**
     - Furthermore, when a song lacks a reference pitch contour (e.g., instrumental-only MP3), **never fabricate a fake pitch accuracy score**: instead score **Pitch Stability & Musicality** (sustained steady voiced pitch on lyric spans, low erratic jitter, melodic movement matching Vietnamese tonal phrasing) and label it honestly as **"Độ vang & giữ cao độ" (Vocal Steadiness)** rather than claiming exact melody match!
4. **Risk: Device Audio Latency Skewing Rhythm Scores.**
   - Bluetooth/Android audio output latency varies from `40 ms` to `250 ms`.
   - *Mitigation:* Run an **automatic adaptive latency estimator** over the first 2–3 sung lines (compute median signed offset between detected vocal onsets and scheduled syllable `start_ms`, clamped to `[-150, +250] ms`) and subtract it before computing rhythm timing accuracy.

### Cost
- **Client-side AudioWorklet + pure-TypeScript YIN/MPM + Spectral/Energy Onset + Phrase DTW:** **$0 / 0 VND** forever; **0 bytes** of additional server RAM on Render Free; **0 network egress** on Supabase.
- **Optional Admin-time reference contour extraction (Python NumPy in offline worker or client Web Audio `OfflineAudioContext` during Admin upload):** **$0 / 0 VND**. (Running reference vocal/backing analysis via browser `OfflineAudioContext` during Admin MP3 upload even works when the backend runs on Render Free 512 MiB without `ffmpeg`!)

### Educational Impact (Vietnamese Primary Grades 1–5)
- **Honest Multi-Dimensional Music Literacy:** Children learn to hear and control **timing (nhịp điệu)**, **sustained clear voice / pitch stability (cao độ & giữ giọng)**, and **clear Vietnamese lyric articulation (lời hát)** — instead of gaming a volume bar.
- **Constructive Visual Scaffolding:** Real-time gentle pitch ribbon / rhythm pulse dots give immediate, non-punitive visual feedback (Mayer's multimedia principle + immediate formative feedback), while capping harsh penalties so children never feel humiliated.

---

## 5. Selected Recommendation

Adopt a **100% Zero-Cost Client-Side Hybrid DSP Engine** (with optional Admin-time reference contour metadata):

1. **Real-Time AudioWorklet DSP Core (`frontend/lib/karaoke/dsp/`):**
   - **Pitch Estimator:** **YIN (CMNDF + parabolic interpolation)** restricted to child/human vocal band **$130\text{ Hz}\text{--}880\text{ Hz}$** (window `2048` samples, hop `1024` samples ≈ `21 ms`, clarity/aperiodicity threshold `0.15`), producing `{ frequencyHz, midiNote, clarity, rmsDb, voiced }`.
   - **Onset & Rhythm Tracker:** Vocal-band (`250–3500 Hz`) energy envelope + half-wave rectified spectral/envelope flux peak detector, matched against `TimedLyrics` syllable/line `start_ms` with automatic median latency compensation (`[-150, +250] ms`) and child-friendly windows ($\pm 120\text{ ms}$ full, $\pm 250\text{ ms}$ partial).
   - **Vocal Activity & Bleed Gate:** Adaptive noise floor + voiced-clarity gate (`clarity >= 0.80`) + instrumental-gap bleed detector.
   - **Fallback Path:** Identical pure-TS DSP functions driven by `AnalyserNode.getFloatTimeDomainData()` if `AudioWorklet` is unavailable.
2. **Transparent Composite Score Breakdown (Honest Labeling):**
   - **With reference pitch contour** (songs processed from vocal track): `Lyrics (35%) + Rhythm/Timing (35%) + Melody/Pitch (30%, octave-invariant + relative contour)`.
   - **Without reference pitch contour** (instrumental-only songs): `Lyrics (40%) + Rhythm/Timing (35%) + Vocal Pitch Stability & Phrasing (25%)`, explicitly labeled honestly in UI & Parent Report.
   - **Fallback when browser SpeechRecognition is unavailable (e.g., certain Android WebViews / offline):** Automatically re-weight transparently to `Rhythm/Timing (55%) + Vocal Pitch Stability/Melody (45%)` with a clear indicator that lyric speech recognition was unavailable (never giving 0% unfairly!).
3. **Optional Reference Contour Extraction (Zero Server Bloat):**
   - During Admin upload (or offline worker when vocal stem exists), extract a compact **10 Hz voiced pitch contour** (`~1.8 KB` JSON for a 3-minute song, quantized to MIDI tenths) and store it optionally in version metadata (additive JSONB field) so live singing can compare against true song melody at near-zero bandwidth.

---

## 6. Rollback Strategy

- Keep the existing `frontend/lib/karaoke/live-singing-score.ts` and `singing-score.ts` contracts backward-compatible; gate the new `AudioWorklet` DSP scorer behind a feature flag (`NEXT_PUBLIC_KARAOKE_DSP_V4` defaulting to enabled after verification, or toggleable per-browser).
- If `AudioWorklet` fails on any specific Android OEM WebView, automatic runtime fallback degrades first to `AnalyserNode` DSP, and second to the existing microphone-signal + speech-recognition baseline without crashing playback.
- Backend `Playback` DTO remains additive-only (optional `reference_pitch_contour` field ignored by older clients).

---

## 7. Citations & Verification Sources (Accessed 2026-11-25)

1. de Cheveigné, A., & Kawahara, H. (2002). *YIN, a fundamental frequency estimator for speech and music*. Journal of the Acoustical Society of America (JASA), 111(4), 1917–1930. DOI: https://doi.org/10.1121/1.1458024 (accessed 2026-11-25).
2. Mauch, M., & Dixon, S. (2014). *pYIN: A Fundamental Frequency Estimator Using Probabilistic Threshold Distributions*. Proc. IEEE ICASSP 2014, pp. 659–663. DOI: https://doi.org/10.1109/ICASSP.2014.6853678 (accessed 2026-11-25).
3. McLeod, P., & Wyvill, G. (2005). *A Smarter Way to Find Pitch*. Proc. International Computer Music Conference (ICMC 2005), pp. 138–141. URL: http://miracle.otago.ac.nz/postgrads/pkm/icmc2005-mcleod-wyvill.pdf (accessed 2026-11-25).
4. Bello, J. P., Daudet, L., Abdallah, S., Duxbury, C., Davies, M., & Sandler, M. (2005). *A Tutorial on Onset Detection in Music Signals*. IEEE Transactions on Speech and Audio Processing, 13(5), 1035–1047. DOI: https://doi.org/10.1109/TSA.2005.851998 (accessed 2026-11-25).
5. Dixon, S. (2006). *Onset Detection Revisited*. Proc. 9th Int. Conference on Digital Audio Effects (DAFx-06), Montreal, Canada. (accessed 2026-11-25).
6. MDN Web Docs — `AudioWorkletProcessor` & Web Audio API (128-sample render quantum, secure context, browser/Android WebView compatibility): https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor and https://caniuse.com/mdn-api_audioworkletprocessor (accessed 2026-11-25).
7. Codebase Audit (SHA `29e2da36`): `backend/app/services/karaoke_media_service.py`, `backend/app/schemas/karaoke.py`, `ai/karaoke_processing/audio_clock.py`, `ai/karaoke_processing/acoustic_boundaries.py`, `backend/requirements-web.txt`.
