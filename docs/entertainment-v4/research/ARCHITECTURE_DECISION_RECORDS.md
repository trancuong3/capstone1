# ViRead Intelligent Play & Learn V4.0 — Architecture Decision Records (ADRs)

- **Date**: 2026-11-25
- **Baseline Commit**: `29e2da36a3311949a0e45dc40c1e80664b9c0ec3`
- **Branch**: `feature/viread-intelligent-play-learn-v4`
- **Research Inputs**: `EDUCATIONAL_RESEARCH.md`, `PRODUCT_COMPARISON.md`, `AI_PROVIDER_RESEARCH.md`, `AUDIO_DSP_RESEARCH.md`, `IMAGE_GENERATION_RESEARCH.md`, `ADMIN_KARAOKE_WORKFLOW_RESEARCH.md`, `ZERO_COST_FEASIBILITY.md`, `ADMIN_WORKFLOW_BEFORE_AFTER.md`, `PERFORMANCE_BEFORE_AFTER.md`.

---

## ADR-01: Hybrid Adaptive Learning Engine & Additive Database Schema

- **Problem**: The 3 existing games (Picture Description, Sentence Shooter, Karaoke) plus the new Memory Game operate in isolation from Reading History and Difficult Words, with no unified skill evidence model, adaptive difficulty, or parent analytics.
- **Existing Implementation**: `ChildProgressService` aggregates reading sessions/reports/retries/comprehension only; `GameSession`, `PictureDescriptionSession`, and `KaraokeSong` have no shared evidence table or cross-game recommendation endpoint.
- **Candidate Solutions**:
  1. *Option A (Selected)*: Additive PostgreSQL tables (`learning_skill_evidence`, `memory_game_sessions`, `memory_game_attempts`, `karaoke_practice_sessions`) + nullable `reference_musical_profile` JSONB on `karaokesongversions`, paired with a deterministic rule-based `AdaptiveLearningService` computing observed/estimated/unknown skill statuses, multi-attempt adaptive difficulty (`>= 3` high-confidence attempts), spaced difficult-word selection, and non-diagnostic parent insights.
  2. *Option B (Rejected)*: LLM-driven student modeling on every attempt. Rejected due to free-tier quota burn, non-deterministic grading drift, latency, and privacy risk.
  3. *Option C (Rejected)*: Client-only `localStorage` tracking. Rejected because progress breaks across desktop/Android devices and cannot feed Parent Reports or cross-game backend content selection.
- **Cost & Risk**: 0 VND (Supabase Free 500 MB DB; compact JSON summaries only, zero raw audio persisted). Graceful fallback when new migration tables are not yet applied in an unmigrated environment prevents production breakage.
- **Rollback Plan**: Companion `20261125120000_entertainment_v4_ecosystem_rollback.sql` drops only the new additive objects cleanly; existing reading/books/karaoke tables remain untouched.

---

## ADR-02: Strict Sequential Cloud-Before-Ollama AI Teacher V4.0 Architecture

- **Problem**: `picture_description_ai.py` enabled parallel `hedged_gemini=True` (risking 2× free-tier RPM/RPD consumption), called Gemini Vision on static built-in `SAMPLE` pictures, and supported only one-shot essay submission rather than scaffolded PEER/CROWD teaching modes.
- **Existing Implementation**: `GeminiPictureDescriptionAI` (`picture_description_ai.py`) already has `thinkingConfig: MINIMAL`, vision image downscaling, 45s model cooldown, Groq fallback, Ollama loopback fallback, and guide-grounded fallback.
- **Candidate Solutions**:
  1. *Option A (Selected)*: Enforce strict sequential tier order by default (`Cloud 1 Gemini primary -> Cloud 2 Gemini fallback -> Cloud 3 Groq -> Local Ollama -> Deterministic Guide Fallback`), reuse verified curated `default_guide` for static `SAMPLE` pictures (0 cloud calls to open built-in samples), add 6 pedagogical teaching modes (`OBSERVE`, `VOCABULARY`, `SENTENCE`, `STORY`, `INFER`, `CREATE`) with PEER/CROWD scaffolding and target difficult-word integration, and strictly prohibit using fallback to bypass `UNSAFE_PICTURE` rejections or leaking PII/EXIF. Keep `ocr_ai` completely untouched to guarantee zero OCR regressions.
  2. *Option B (Rejected)*: Parallel fan-out across Gemini + Groq simultaneously. Rejected by Zero-Cost & Master Prompt Section 10.3 policy.
- **Cost & Risk**: 0 VND; cuts free Gemini quota usage by ~50%+ on built-in sample sessions while preserving sub-6s p50 grading.
- **Rollback Plan**: Revert `picture_description_ai.py` / `picture_description_service.py` commits independently; API contract stays backward-compatible via optional request/response fields.

---

## ADR-03: Decoupled Real-Time Input Queue & Educational Modes for Sentence Shooter V4.0

- **Problem**: `sentence-shooter-screen.tsx` sets `actionLockRef.current = true` and disables every token button across the full `POST /shots` HTTP RTT (150–3,000 ms), performs duplicate synchronous `getBoundingClientRect()` layout reflows per tap, and allocates a fresh `AudioContext` on every sound effect.
- **Existing Implementation**: Backend already preloads `next_round` and enforces idempotent round/token state via PostgreSQL row locks.
- **Candidate Solutions**:
  1. *Option A (Selected)*: Decouple immediate visual cannon aim, projectile animation (GPU `transform`, `ResizeObserver`-cached rects, singleton `AudioContext`), and tactile feedback (`< 30 ms` tap-to-visible-feedback) from a bounded ordered FIFO server-validation queue (`epoch` + `idempotency` guarded) that reconciles authoritative server verdicts without double-scoring or locking out input. Extend backend `SentenceShooterService` with optional `learning_mode` (`WORD_ORDER`, `FILL_BLANK`, `GRAMMAR_FOCUS`) and difficult-word sentence prioritization while preserving 100% of existing `WORD_ORDER` behavior.
  2. *Option B (Rejected)*: Client-authoritative scoring with full answer leaked to browser. Rejected because it weakens game integrity and risks stale/duplicate rewards.
- **Cost & Risk**: 0 VND; zero schema change required for core shooter rounds (additive optional query/body fields only).
- **Rollback Plan**: Revert shooter UI/service commits cleanly; default `learning_mode="WORD_ORDER"` maintains full wire compatibility.

---

## ADR-04: Client-Side Web Audio DSP Musical Karaoke Scoring + Render-Safe Admin One-File Automation

- **Problem**:
  1. Karaoke currently measures ONLY lyric text via unreliable Web Speech API (`0%` rhythm, `0%` pitch), mutes backing music by default, and re-renders the entire 887-line `KaraokeStage` tree at 60 Hz.
  2. Admin Karaoke `/admin/karaoke/new` silently falls back to a 100–300 tap manual editor when heavy offline Demucs is disabled, requires manual verbatim lyrics up front, and hides required rights fields inside collapsed `<details>` causing Step 3 bounce + state wipe.
- **Existing Implementation**: `mutagen 1.48.1` is installed in `requirements-web.txt`; `MainActivity.java` grants `RECORD_AUDIO` for WebView `getUserMedia`; Render Free has 512 MiB RAM and no `ffmpeg`/`librosa`/`demucs`.
- **Candidate Solutions**:
  1. *Option A (Selected)*:
     - **Karaoke DSP**: 100% client-side Web Audio API DSP (`musical-dsp.ts` + `musical-scoring.ts`) running **YIN F0 pitch tracking** (`130–880 Hz`, octave-invariant child voice tolerance) + **spectral-flux/energy vocal onset & beat alignment** strictly on the audio playback clock + echo/leakage/silence quality gating (`INSUFFICIENT_EVIDENCE` when audio is unusable) + explicit non-conflated scoring modes (`FULL_MUSICAL`, `RHYTHM_AND_LYRICS`, `LYRICS_ONLY`, `INSUFFICIENT_EVIDENCE`). Optimize `KaraokeStage` & `SyllableLyrics` (memoization, throttled UI tick, stopped idle editor rAF) and add musical practice modes (`RHYTHM_TAP`, `LINE_PRACTICE`, `FULL_SONG`, `SEGMENT` with `0.85x` speed) + segment-level reports persisted via `karaoke_practice_sessions`.
     - **Admin One-File Simple Mode**: Default **Simple Mode** ("THÊM BÀI HÁT MỚI": 1 MP3 upload -> backend `mutagen` ID3v2 extraction of `TIT2`/`TPE1`/`APIC` cover/`USLT`/`SYLT` + LRC parsing + client Web Audio vocal/instrumental classification -> optional Groq `whisper-large-v3-turbo` draft lyric extraction when configured or 1-pass Spacebar Tap-to-Sync -> Review-by-Exception panel highlighting only uncertain segments -> explicit unchecked-by-default rights & safety checklist right before Publish -> "Chỉnh sửa nâng cao" button preserving full existing `KaraokeEditorScreen`).
  2. *Option B (Rejected)*: Server-side `librosa`/`crepe`/`demucs` on Render Free. Rejected — exceeds 512 MiB RAM immediately (OOM crash) and requires installing `ffmpeg`/`torch` in web container.
- **Cost & Risk**: 0 VND, 0 MB Render RAM growth, works with laptop turned off once songs are published, and works natively on Android WebView `getUserMedia`.
- **Rollback Plan**: Existing `KaraokeEditorScreen`, `KaraokeSongVersion` format, and legacy scoring remain fully accessible and backward-compatible.

---

## ADR-05: Deterministic Parametric SVG Scene Composer for AI Memory & Creative Story Game ("Bé nhớ được gì?")

- **Problem**: ViRead needs a brand-new AI Memory & Creative Story game with fresh, varied, child-safe scenes, accurate ground truth (objects, counts, colors, locations, actions), highlightable reveal coordinates, selectable post-load observation timers, and 0 VND cost.
- **Existing Implementation**: Only 3 static JPEGs exist in `picture_description`; diffusion models hallucinate counts/spatial relations, burn free quotas, and consume Supabase Storage/Egress.
- **Candidate Solutions**:
  1. *Option A (Selected)*: **Deterministic Parametric Vietnamese SVG Scene Composer** (6 curated primary-school themes, 36+ layered vector sprites, 6 high-contrast canonical colors, collision-free spatial slots, grade-capped object counts: G1 `<=4`, G2–3 `<=6`, G4–5 `<=9`) generating a compact ~3 KB `SceneSpec` JSON with **100% mathematically verifiable ground truth & exact bounding boxes** + hybrid evaluation (deterministic Vietnamese synonym/color/count/spatial matcher separating factual recall from creative imagination + optional tiered AI narrative coaching).
  2. *Option B (Rejected)*: Calling free diffusion image APIs per round. Rejected due to latency (10–30s), unreliable object counting/spatial hallucinations, rate limits, and Supabase storage/egress consumption.
- **Cost & Risk**: 0 VND, 0 bytes Supabase Storage, `<16 ms` client render, 100% child-safe, honest coordinate spotlights on Reveal.
- **Rollback Plan**: Self-contained new module (`/entertainment/memory-game`, `/games/memory/*`) removable without affecting any existing route.
