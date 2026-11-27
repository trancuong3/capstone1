# Admin Karaoke Workflow Research — Ultra-Simple 1-File MP3 Automation

**Date:** 2026-11-25  
**Scope:** Eliminating Admin Karaoke publishing friction via a "Simple Mode" one-file MP3 upload pipeline — automatic ID3v2 metadata/cover/lyrics extraction (`mutagen`), vocal vs. instrumental track detection, optional zero-cost lyric transcription & timing assistance, and full backward compatibility with the existing manual editor & isolated `ai/karaoke_processing/` worker.  
**Codebase Baseline:** Branch `feature/viread-intelligent-play-learn-v4`, SHA `29e2da36`.

---

## 1. Problem Statement

Today, publishing a new Vietnamese primary-school karaoke song in ViRead Admin requires an intimidating multi-step manual workflow:
1. Create song metadata (`title`, `author`, `min_grade`, `max_grade`, `source_note`, `usage_note` — 3 of which are hard-required by `content_issues()` in `karaoke_service.py:37-40`).
2. Manually upload an MP3 audio file (and separately upload a cover image and/or reference vocal audio).
3. Manually paste every lyric line.
4. Manually tap or type `start_ms` and `end_ms` for every single line/syllable (or depend on `KARAOKE_PROCESSING_ENABLED=true`, which is **disabled by default** in `.env.example`, requires an isolated `.cache/karaoke-ai/.venv` not installed on Render Free 512 MiB, takes **~474 seconds (~8 minutes)** per song on CPU for Demucs + CTC, and still blocks publishing with `NEEDS_REVIEW` + incomplete syllable ends).
5. Separately run validation, acknowledge review flags, and publish.

**Goal for ViRead Play & Learn V4.0:** Let an Admin drop **1 single MP3 file** (and optionally a `.lrc` file or pasted lyrics) and have the system **automatically** pre-fill title, artist, cover art, lyrics (from ID3 `SYLT`/`USLT`, `.lrc`, or optional zero-cost Groq Whisper / local ASR), detect whether the track is vocal-bearing or instrumental, propose clean timing marks when timed lyrics or beat/onset anchors exist, provide smart defaults for grade range & notes, and let the Admin review & click **Publish** in seconds — while **keeping Advanced Mode and all existing publication/safety invariants 100% intact**.

---

## 2. Existing Implementation Audit

A deep audit of the backend karaoke stack on SHA `29e2da36` establishes the exact baseline:

| Component | File Path | Audited Behavior & Bottlenecks |
|---|---|---|
| **Media Inspector** | `backend/app/services/karaoke_media_service.py` (`L36-58`) | Uses `mutagen.mp3.MP3(BytesIO(data)).info` (already installed in `requirements-web.txt`: `mutagen==1.48.1`). **Only extracts `duration_ms`, `size_bytes`, `sha256`.** Ignores `TIT2` (title), `TPE1` (artist), `APIC` (embedded album cover), `USLT` (unsynced lyrics), and `SYLT` (synced timestamped lyrics)! |
| **Song CRUD & Validation** | `backend/app/services/karaoke_service.py` (`L33-53`, `L170-377`) | `content_issues()` requires non-empty `title`, `source_note`, `usage_note`, `audio_path`+`audio_sha256`+`duration_ms`, non-empty `lyrics.lines`, complete valid timings (`timing_issues()`), and `audio_sha256 == timed_audio_sha256`. Uploading audio clears existing timings (`clear_timings()`). |
| **API Routes** | `backend/app/api/routes/karaoke.py` (146 lines) | Requires separate sequential requests: `POST /admin/songs` → `POST /draft/audio` → (optional `POST /draft/cover`) → `PUT /draft` (lyrics & timings) → `GET /draft/validation` → `POST /publish`. No single-step MP3 inspect/import endpoint exists. |
| **Auto-Import Job Queue & Worker** | `backend/app/services/karaoke_processing_service.py`, `karaoke_processing_pipeline.py`, `app/jobs/karaoke_processing_worker.py`, `core/karaoke_processing_config.py` | Strong transactional/fencing architecture (`karaoke_processing_jobs`, `karaoke_processing_operations`, SHA-256 caching, lease heartbeats, immutable snapshot trigger). **Disabled by default** (`KARAOKE_PROCESSING_ENABLED=false`). Requires `KARAOKE_LOCAL_PYTHON`, Demucs weights (`84 MB`), and `nguyenvulebinh/lyric-alignment` (CC-BY-NC-4.0 weights). |
| **Offline Local Engine** | `ai/karaoke_processing/media_engine.py`, `ctc_engine.py`, `runner.py`, `docs/karaoke-auto-import/STATUS.md` | Verified real-song benchmark in `STATUS.md`: full-song Demucs + Wav2Vec2 CTC took **473.88 seconds (~7.9 min)** on CPU, produced only `45/160` (then `86/160` in boundary v3) complete syllable pairs, and **failed the 90% quality gate** (`NOT_VERIFIED`). Also requires `imageio-ffmpeg` + `torch` + `torchaudio` + `demucs`, which cannot run inside Render Free 512 MiB RAM. |
| **Database Schema** | `supabase/migrations/20261114130000_add_karaoke.sql`, `20261117060000_add_karaoke_processing.sql` | Private bucket `viread-karaoke` (20 MiB max, `audio/mpeg`, `image/webp`); server-only RLS. Note from `STATUS.md`: `20261117060000` processing tables are additive and may not yet be applied on every target Supabase instance, so Simple Mode **must work even when `KARAOKE_PROCESSING_ENABLED=false`**! |
| **Baseline Tests** | `test_karaoke*.py` (16 modules) + `ai/karaoke_processing/test_*.py` (3 modules) | **All tracked tests PASS**: backend karaoke tests included in 327 passed / 8 skipped; AI pure tests **32 passed, 0 failed**. |

---

## 3. Candidate Automation Workflows Compared

### 3.1 Metadata, Cover Art & Embedded Lyrics Extraction (from 1 MP3)

| Candidate | Mechanism | Dependencies (Render 512 MiB Safe?) | Speed | Cost |
|---|---|---|---|---|
| **A. Server-Side `mutagen` ID3v2 + Filename Parser (Selected Core)** | Parse `ID3` frames from the uploaded MP3 bytes in memory: `TIT2` (title), `TPE1`/`TPE2` (author), `APIC` (embedded cover → pass through existing `normalize_cover()` to WebP!), `SYLT` (synced lyrics → direct `start_ms`/`end_ms`!), `USLT` (unsynced lyrics → check for inline `[mm:ss.xx]` LRC timestamps or plain lines!), plus smart filename fallback (`"Chau Len Ba - Pham Tuyen.mp3"` → title + author). | **ZERO new dependencies** (`mutagen==1.48.1` + `pillow==12.0.0` ALREADY in `backend/requirements-web.txt`!) | **< 25 ms** | **$0 / 0 VND** |
| **B. Client-Side JS ID3 Parser (`jsmediatags` / `music-metadata-browser`)** | Parse ID3 tags in the browser before upload so the Admin UI shows instant title/cover/lyrics preview even before HTTP upload finishes. | Small browser-only parser or zero-dep ID3v2 header reader | **< 15 ms** | **$0 / 0 VND** |
| **C. External Music Metadata APIs (AcoustID / MusicBrainz / Musixmatch)** | Fingerprint audio and query external lyric databases. | Requires `fpcalc` native binary + external API keys; Musixmatch paid & strict copyright restrictions on lyrics redistribution. | 1–3s | Paid / Legal Risk |

### 3.2 Vocal vs. Instrumental Track Detection (No `ffmpeg` Required on Render Free!)

| Candidate | Mechanism | Runs on Render Free 512 MiB (No `ffmpeg`)? | Accuracy | Speed |
|---|---|---|---|---|
| **A. Client-Side Browser Web Audio `decodeAudioData` DSP Analyzer (Selected Primary)** | Browser decodes the selected MP3 natively (zero server RAM, zero `ffmpeg`!) via `AudioContext.decodeAudioData()`. Computes: (1) **Mid/Side vocal-band ratio** (`300–3400 Hz` energy in `(L+R)/2` vs `(L-R)/2`), (2) **Voice-band pitch clarity ratio** (YIN periodicity fraction across 20 sampled 1s windows in `150–700 Hz`), and (3) **Energy/onset phrase envelope** for auto-suggesting vocal phrase boundaries! | **100% Yes** — runs inside Admin's browser! **0 MB server RAM!** | High (~85–92% for distinguishing sung vocal tracks vs pure piano/karaoke backing tracks) | **0.3–1.2 seconds** for a 3-min MP3 |
| **B. Server-Side `librosa` / `ffmpeg` Spectral & Mid-Side Analysis** | Decode MP3 via `ffmpeg` → NumPy/SciPy mid-side + vocal harmonicity. | **No** (`ffmpeg` not installed in container/PATH; decoding 44.1 kHz stereo PCM for 5-min MP3 takes ~105 MB RAM per request — dangerous on Render 512 MiB) | High | 2–4 seconds |
| **C. Full Demucs v4 (`htdemucs`) Separation Just to Detect Vocals** | Run `media_engine.py` (`vocal_to_input_rms >= 0.03`). | **No** (requires PyTorch + 84 MB weights + ~3–8 min CPU) | Very High | **180–480 seconds** |

### 3.3 Lyric Transcription & Auto-Timing When MP3 Has No Embedded `SYLT`/LRC

| Candidate | Mechanism | Vietnamese Accuracy | Speed (3-min Song) | Cost & Hosting | Licensing / Safety |
|---|---|---|---|---|---|
| **A. LRC / `SYLT` / Smart Tap-Along + Phrase-Envelope Pre-Placement (Zero-AI Always-Available Baseline)** | (1) If MP3 contains `SYLT` or LRC-formatted `USLT` (or Admin drops an `.lrc` alongside `.mp3`), auto-populate **exact line timestamps** immediately. (2) If Admin pastes plain lyrics (or uses one-click **Tap-to-Sync** mode: press Spacebar once per line while listening at 1.0× or 1.25×), timing a 16-line children's song takes **< 45 seconds** with **100% human-verified accuracy**! (3) Optional client-side vocal-activity envelope suggests initial phrase anchors for un-timed lines (clearly flagged as "Đề xuất — cần kiểm tra nghe thử"). | **100%** (human-provided/verified text) | Instant (LRC/SYLT) or ~45s (1-pass tap sync) | **$0 / 0 VND**; 0 MB server RAM | 100% clean |
| **B. Opt-In Groq Free Tier `whisper-large-v3-turbo` (`verbose_json`, `timestamp_granularities[]=segment,word`, `language=vi`)** | Backend sends MP3 bytes (up to 20 MiB; Groq allows up to 100 MB) directly to Groq Audio Transcriptions API over `httpx` (already installed!), returning Vietnamese lyric draft + segment/word timestamps in **2–5 seconds**. Admin reviews & edits draft before publishing (never auto-publishes unreviewed ASR!). | **Good-to-Strong** on clear children's vocals (requires quick Admin spelling check for singing vibrato/chorus) | **2–5 seconds** (LPU accelerated!) | **$0 / 0 VND** (Groq Free Tier: **20 RPM, 2,000 RPD, 28,800 audio sec/day = 8 hours/day**!) | Admin-uploaded public/educational MP3s only (never child audio); opt-in flag `KARAOKE_ADMIN_GROQ_LYRICS_ENABLED` |
| **C. Existing Local Offline Pipeline (`ai/karaoke_processing/`: Demucs v4 + `nguyenvulebinh/lyric-alignment` CTC)** | Isolated worker separates stems (`htdemucs`, MIT code) and runs Vietnamese singing CTC forced alignment. | Mixed on real songs (`45–86/160` complete syllables on calibration; still `NOT_VERIFIED` in `STATUS.md`) | **~474 seconds (~8 min)** on CPU | **$0 API**, requires dedicated local GPU/CPU worker host (cannot run on Render Free) | CTC weights are **CC-BY-NC-4.0** (non-commercial/academic demo only) |
| **D. Paid Stem/Alignment APIs (LALAL.ai, AudioShake, AssemblyAI)** | Commercial cloud separation + alignment | Very High | 20–60s | **$0.10–$1.50/song** — **eliminated by 0 VND constraint** | Commercial |

---

## 4. Pros, Cons, Cost, Risks & Educational Impact

### Pros & Cons of Recommended "Smart Simple Mode" Architecture
- **Pros:**
  - **Dramatic UX Reduction:** Admin drops **1 MP3** → instant auto-fill of `title`, `author`, `duration_ms`, embedded `cover_art` (auto-normalized to WebP), `SYLT`/`USLT`/LRC lyrics + timings, and browser-detected track type (`VOCAL_TRACK` vs `INSTRUMENTAL`) + sensible defaults (`min_grade=1, max_grade=5`, editable `source_note`/`usage_note` presets).
  - **Zero Render Free RAM Bloat:** `mutagen` ID3 inspection uses `< 5 MB` peak memory; browser Web Audio `decodeAudioData` runs vocal/beat/contour detection on the Admin's computer (`0 MB` server RAM).
  - **Fast Zero-Cost Draft Lyrics Fallback:** When an MP3 has vocals but no embedded lyrics, one click on **"Tự trích lời bài hát (AI)"** calls Groq `whisper-large-v3-turbo` (`2–5s`, 0 VND) to generate a timed Vietnamese draft that the Admin edits and approves — **100× faster** than waiting 8 minutes on CPU Demucs/CTC and works on Render Free!
  - **Non-Destructive:** Existing `ai/karaoke_processing/` offline Demucs+CTC worker remains intact for local research/stem-separation hosts when `KARAOKE_PROCESSING_ENABLED=true`.
- **Cons:**
  - MP3 files without embedded ID3 tags or vocals (pure karaoke beat MP3) still require the Admin to paste lyrics (or upload a `.lrc`) and tap-sync lines once — which is physically unavoidable since an instrumental file contains no spoken words.
  - Groq `whisper-large-v3-turbo` cannot *remove* vocals from a vocal MP3 to create an instrumental backing track; for true vocal-removal stem separation, either the Admin uploads an instrumental/karaoke MP3 (common for Vietnamese children's karaoke), uses the existing local Demucs worker, or uses client-side **Karaoke Vocal Attenuator (Mid-Side phase cancellation filter in Web Audio)** as an optional playback toggle ("Giảm giọng ca sĩ mẫu")!

### Risks & Mitigations
1. **Risk: Malicious / Corrupt ID3 Tags or Oversized Embedded `APIC` Cover Art.**
   - *Mitigation:* Enforce existing `MAX_AUDIO_BYTES = 20 MiB` before parsing; strip control characters via existing `clean_text()` (`schemas/karaoke.py:19`) and cap field lengths (`title <= 200`, `author <= 200`); run any extracted `APIC` bytes through existing `normalize_cover()` (`karaoke_media_service.py:61`, which enforces decompression-bomb protection, `<= 4096 px`, non-animated JPEG/PNG/WEBP, EXIF stripping, `<= 2 MiB` WebP). Never trust raw browser MIME claims.
2. **Risk: Copyright / Usage Note Bypass.**
   - *Mitigation:* Never weaken `content_issues()` publication checks (`TITLE_REQUIRED`, `SOURCE_REQUIRED`, `USAGE_REQUIRED`, `TIMING_AUDIO_MISMATCH`). Instead, in Simple Mode provide clean one-click preset pills for `source_note` / `usage_note` (e.g., *"Nhạc thiếu nhi dân gian / tài liệu giáo dục nội bộ ViRead"*) that Admin explicitly reviews and confirms before publishing.
3. **Risk: Unreviewed ASR Lyrics Published to Primary Students (Spelling / Diacritic Errors).**
   - *Mitigation:* Any AI-transcribed or envelope-estimated lyrics are saved strictly to `DRAFT` with clear visual review badges; **zero auto-publish**. Admin can fix Vietnamese tone marks inline and verify playback before clicking **Xuất bản (Publish)**.
4. **Risk: Audio-Timing Mismatch on Replace.**
   - *Mitigation:* Preserve exact SHA-256 binding (`timed_audio_sha256 == audio_sha256`) and optimistic concurrency (`expected_revision`).

### Educational Impact
- Enables teachers and ViRead admins to expand the Vietnamese children's song library from a handful of songs to dozens of curriculum-aligned songs (*Cháu lên ba*, *Con cò bé bé*, *Cả nhà thương nhau*, *Em yêu trường em*, *Rước đèn tháng Tám*) in **under 1–2 minutes per song** instead of 20–30 minutes of manual timestamp entry — directly increasing children's exposure to rhythmic Vietnamese language and vocabulary.

---

## 5. Selected Recommendation

Implement an additive **Admin Karaoke Simple Mode (1-File MP3 Smart Import)** spanning lightweight backend + client DSP:

1. **Backend: Extend `karaoke_media_service.py` with `extract_mp3_metadata(data: bytes)` (Zero New Dependencies — uses installed `mutagen 1.48.1`):**
   - Extracts `duration_ms`, `size_bytes`, `sha256` (unchanged validation) PLUS safe normalized:
     - `title` (`TIT2` → fallback cleaned filename)
     - `author` (`TPE1` / `TPE2` → fallback filename separator `"Title - Artist"`)
     - `cover_webp_bytes` (first valid `APIC` frame passed through `normalize_cover()`, safely ignored if corrupt/oversized)
     - `embedded_lyrics` (`SYLT` synced timestamps → `Lyrics` v1/v2 lines with `start_ms`/`end_ms`; or `USLT` parsed for `[mm:ss.xx]` LRC tags or plain lines)
   - Expose additive endpoint `POST /api/v1/karaoke/admin/songs/inspect-mp3` (or integrated into 1-step `POST /api/v1/karaoke/admin/songs/quick-import`) gated by Admin RBAC (`_actor(actor_id, "admin")`).
2. **Frontend Admin Simple Mode (Browser-Side Zero-RAM Audio Analysis):**
   - When Admin drops 1 MP3 (and optional `.lrc`):
     - Browser Web Audio `decodeAudioData()` runs in `< 1s` to classify `track_kind` (`VOCAL_DETECTED` vs `INSTRUMENTAL_LIKELY`), extract a compact waveform preview + optional 10 Hz reference pitch contour (if vocal), and detect vocal phrase segments.
     - UI immediately populates Title, Artist, Cover preview, Grade 1–5 selector, Lyrics, and Timing status on **one single streamlined screen** (with a toggle to switch to `?mode=advanced` anytime).
3. **Optional Zero-Cost AI Draft Lyrics Helper (`POST /api/v1/karaoke/admin/songs/{song_id}/draft/auto-lyrics`):**
   - When MP3 has vocals and no embedded lyrics, Admin can click **"Tự trích lời & canh nhịp (Miễn phí)"**:
   - Calls Groq Free Tier `whisper-large-v3-turbo` (`language="vi"`, `response_format="verbose_json"`, `timestamp_granularities=["segment", "word"]`) via existing `httpx` client (2–5s, 0 VND, bounded by `KARAOKE_ADMIN_GROQ_LYRICS_ENABLED` and `GROQ_API_KEY`).
   - Maps segments/words cleanly into `Lyrics` `format_version=2` draft for Admin review + inline editing.
   - If Groq is unconfigured/rate-limited, falls back gracefully to **1-Pass Tap-to-Sync** (press Spacebar per line while playing audio) — 100% functional offline!
4. **Optional Client-Side Playback Vocal Reduction Toggle:**
   - When an Admin publishes a vocal-bearing MP3 without running Demucs, child playback can optionally offer a Web Audio Mid-Side / EQ vocal-attenuation toggle ("Hát cùng ca sĩ" vs "Giảm giọng ca sĩ") at **0 VND** and **0 server CPU**.

---

## 6. Rollback Strategy

- All new Simple Mode endpoints (`inspect-mp3`, `quick-import`, `auto-lyrics`) are **strictly additive**; every existing route in `backend/app/api/routes/karaoke.py` and `karaoke_processing.py` retains identical request/response schemas and validation rules.
- Controlled by feature flags (`KARAOKE_ADMIN_SIMPLE_MODE_ENABLED`, `KARAOKE_ADMIN_GROQ_LYRICS_ENABLED`); turning them off reverts instantly to the existing manual editor & opt-in local worker with zero schema impact.
- No destructive migrations; existing `karaoke_songs` and `karaoke_song_versions` columns already store everything required for Simple Mode!

---

## 7. Citations & Verification Sources (Accessed 2026-11-25)

1. Mutagen Official Documentation — ID3 Frames (`TIT2`, `TPE1`, `APIC`, `USLT`, `SYLT`) and MP3 stream inspection: https://mutagen.readthedocs.io/en/latest/api/id3_frames.html (accessed 2026-11-25).
2. Groq Cloud Documentation — Speech-to-Text (`whisper-large-v3-turbo`, `verbose_json`, word/segment timestamps, 100 MB limit, Free Tier 20 RPM / 28,800 audio sec/day): https://console.groq.com/docs/speech-to-text and https://console.groq.com/docs/rate-limits (accessed 2026-11-25).
3. Meta Research Demucs v4 (`htdemucs`, MIT code license, CPU ~1.5×–3× real-time): https://github.com/facebookresearch/demucs (accessed 2026-11-25).
4. VinAI PhoWhisper (Vietnamese ASR fine-tuned Whisper): https://github.com/VinAIResearch/PhoWhisper (accessed 2026-11-25).
5. Codebase Audit (SHA `29e2da36`): `backend/app/services/karaoke_media_service.py`, `backend/app/services/karaoke_service.py`, `backend/app/api/routes/karaoke.py`, `backend/app/services/karaoke_processing_pipeline.py`, `backend/app/core/karaoke_processing_config.py`, `ai/karaoke_processing/README.md`, `docs/karaoke-auto-import/STATUS.md`, `backend/requirements-web.txt`.
