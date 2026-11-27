# Zero-Cost Feasibility & Infrastructure Capacity Audit — ViRead Play & Learn V4.0

**Date:** 2026-11-25  
**Scope:** End-to-end 0 VND ($0/month) feasibility analysis covering Hosting (Render Free + Vercel Hobby), Database & Storage (Supabase Free), AI Inference (Gemini Free + Groq Free + Local Ollama), Audio DSP & Speech, Visual Scene Generation, Database Schema & Egress Optimization, and Sentence Shooter / Cross-Game Latency Bottlenecks.  
**Codebase Baseline:** Branch `feature/viread-intelligent-play-learn-v4`, SHA `29e2da36`.

---

## 1. Problem Statement

ViRead is a Vietnamese primary-education capstone and family-accessible reading platform targeting **strict 0 VND ($0/month)** operational cost across all four Play & Learn V4.0 games (**AI Teacher / Picture Storytelling**, **Sentence Shooter**, **Musical Karaoke**, and **AI Memory Game**) plus **Admin Karaoke Simple Mode** and **Parent Reports**.

Adding rich AI, visual memory, and real-time musical karaoke naively can silently blow past free-tier ceilings:
- **RAM OOM crash** on Render Free (`512 MiB` RAM) if heavy Python ML/audio libraries (`torch`, `librosa`, `demucs`, `ffmpeg`) are added to `backend/requirements-web.txt`.
- **Supabase Free Storage (`1 GB`) & Egress (`5 GB/month`) exhaustion** if AI-generated PNGs/JPEGs or raw child audio recordings are stored or repeatedly signed/downloaded.
- **Database Size (`500 MB`) & Connection Pool saturation** if noisy per-frame telemetry or redundant DB round-trips run on every tap in Sentence Shooter or every frame in Karaoke.
- **AI Free-Tier `429 Too Many Requests` lockouts** if static scenes, sample guides, or unchanged reports trigger redundant cloud VLM calls.

---

## 2. Existing Implementation & Infrastructure Audit

### 2.1 Audited Hosting & Service Limits (Verified 2026-11-25)

| Layer | Platform & Tier | Verified Free-Tier Ceilings | Key Operational Constraints |
|---|---|---|---|
| **Frontend Web** | **Vercel Hobby** (non-commercial / academic) | 100 GB Fast Data Transfer/mo, 1M function invocations/mo, 4 active CPU-hrs, 360 GB-hrs RAM | Non-commercial only; hard pause on overage; static SVG/JS assets served cheaply from Edge CDN |
| **Backend API** | **Render Free Web Service** | **512 MiB RAM**, 0.1 CPU, 5 GB outbound bandwidth/mo | Spins down after idle (30–50s cold start); cannot install `torch`/`librosa`/`demucs` in `requirements-web.txt` |
| **Database & Storage** | **Supabase Free** | **500 MB PostgreSQL**, 500 MB shared DB RAM, **1 GB File Storage**, **5 GB DB egress + 5 GB cached egress/mo**, 50,000 MAUs | Auto-pauses after 7 days of zero traffic; no automatic PITR backups; `NullPool` + `DATABASE_CONCURRENCY_LIMIT=8` already configured in `backend/.env.example` |
| **Mobile** | **Android APK (WebView wrapper)** | **$0** (self-hosted APK / sideload) | Runs on child's Android CPU/WebView; ideal compute offload target for AudioWorklet DSP & SVG rendering |
| **Cloud AI (Primary)** | **Google AI Studio — Gemini Free Tier** | Free tokens on `gemini-3.1-flash-lite` / `gemini-3.5-flash-lite` / `gemma-4-26b-a4b-it`; dynamic per-project RPM/TPM/RPD | Free tier data may be used by Google to improve products → strip PII/EXIF & prefer text-only ground-truth prompts |
| **Cloud AI (Secondary + Admin Audio)** | **Groq Cloud Free Tier** | **30 RPM / 1,000 RPD / 8,000 TPM / 200,000 TPD** (LLM); **20 RPM / 2,000 RPD / 28,800 audio sec/day (8h/day)** for `whisper-large-v3-turbo`, 100 MB/file | Org-wide shared rate pool; no credit card required; does not auto-bill |
| **Local Fallback (Desktop/Dev)** | **Ollama (`127.0.0.1:11434`) + Local Voice Worker (`127.0.0.1:8010`)** | **$0 / Unlimited** on local host (4 GB VRAM / 16 GB RAM) | Not available on Render Free; verified `ollama` binary is absent on current shell PATH |

### 2.2 Audited Codebase Bottlenecks Affecting Cost & Latency (`backend/`, SHA `29e2da36`)
1. **Picture Description Redundant VLM Calls & Image Re-Downloads (`backend/app/services/picture_description_service.py`):**
   - `create_session()` (`L540`) calls Gemini Vision even for built-in `SAMPLE` pictures that ALREADY have curated Vietnamese `default_guide` metadata (`L83-171`).
   - `evaluate_attempt()` (`L639`) downloads the image from Supabase Storage (spending egress) and sends base64 image tokens to Gemini on *every single retry attempt*, even for `SAMPLE` or future `PROCEDURAL` scenes with deterministic ground truth.
   - `PICTURE_DESC_HEDGED_GEMINI=true` (`L235` of `picture_description_ai.py`) fires a second Gemini call after `3.5s`, potentially doubling Free Tier RPM/RPD usage.
2. **Sentence Shooter Per-Shot Network & DB Lock Latency (`backend/app/services/games/sentence_shooter_service.py` + `sentence_shooter_repository.py`):**
   - Every single word tap executes `POST /sessions/{session_id}/shots` which acquires `SELECT ... FOR UPDATE` row locks on both `GameSession` and `GameRound` (`load_shot_bundle`, `L313`), writes a `GameAttempt` row, and commits to Supabase Postgres before returning `is_correct`!
   - Even though `load_shot_bundle` already consolidated 4 queries into 1 (`L280-318`) and `shoot()` prefetches `next_round` on round completion (`L361-379`), **every shot still pays a full HTTPS + Supabase transaction round-trip (150–600 ms on mobile / Render Free)** before the UI can confirm a hit if the client waits synchronously!
   - Also: `SentenceShooterService.create_session()` currently picks random sentences (`random.SystemRandom().sample`, `L175`) without prioritizing the child's actual difficult words from `difficult_word_practice_attempts` / reading reports!
3. **Karaoke Heavy Worker Incompatibility with Render Free:**
   - `ai/karaoke_processing/` requires `torch`, `torchaudio`, `demucs`, `transformers`, and `imageio-ffmpeg` (~2.5 GB disk + >1.5 GB RAM + ~474s CPU per song). Completely incompatible with Render Free 512 MiB, yet zero lightweight ID3/client-DSP auto-import path exists yet.
4. **Parent Report & Cross-Game Integration Gap:**
   - `ChildProgressService.assess()` (`backend/app/services/child_progress_service.py`) currently aggregates only Reading (`sessions`, `reports`, `word_retries`, `answers`). Entertainment data (`GameSession`, `PictureDescriptionSession`, future `MemoryGameSession`, `KaraokeSession`) is isolated in separate tables and not yet surfaced in a unified low-egress summary for parents.
5. **Baseline Backend Test Health (Verified 2026-11-25):**
   - 22 tracked backend test modules (`picture_description`, `sentence_shooter`, `karaoke*`, `ocr_ai`, `child_progress`, `difficult_words`, `voice`): **327 passed, 8 skipped, 0 failed** (219 subtests, 12.29s).
   - 3 `ai/karaoke_processing/` pure tests: **32 passed, 0 failed** (11 subtests, 1.52s).
   - Note: Untracked local dirty file `backend/test_word_practice.py` has an `ImportError` (`cannot import name 'WordPracticeAttempt' from 'app.models'`) — must be preserved untouched per workspace rules.

---

## 3. Candidate Zero-Cost Architecture Strategies Compared

| Strategy | Monthly Cost | Render 512 MiB Safe? | Supabase 500 MB / 1 GB / 5 GB Safe? | UX Latency | Reliability Under Free-Tier Limits |
|---|---|---|---|---|---|
| **A. Edge/Client-First + Deterministic-First + Tiered Free Cloud AI (Selected)** | **$0.00 (0 VND)** | **Yes** (~140–220 MiB RAM; zero new heavy Python deps) | **Yes** (JSONB-only scenes/scores, ~5–15 MB DB/year, zero generated image storage, zero child audio storage) | **< 16 ms** (Memory SVG, Sentence Shooter optimistic/local-verified UX, Karaoke AudioWorklet); **1–3s** (AI coaching) | **High** — every feature works 100% even if all cloud AI APIs return `429`/`503` |
| **B. Server-Heavy Local ML (All-in-One Python Server with Demucs + Whisper + Stable Diffusion)** | $0 API, but **requires $25–$80/mo GPU/8 GB RAM VPS** | **No — instant OOM crash on Render Free 512 MiB** | Yes | Slow on CPU (30–480s) | Eliminated by 0 VND hosting constraint |
| **C. Cloud-Everything Paid/Freemium (OpenAI Vision + ElevenLabs + FLUX + LALAL.ai)** | **$40–$200/month** | Yes | High Storage/Egress risk from AI images & audio | 2–10s | Eliminated by 0 VND constraint |

---

## 4. Detailed Zero-Cost Budget & Resource Math (50 Active Families / 100 Children Pilot)

Assuming **100 active children** playing **15 minutes/day** (3,000 child-sessions/month across all 4 games):

| Resource | Usage per Session | Monthly Volume | Monthly Total | Free-Tier Allowance | Headroom |
|---|---|---|---|---|---|
| **AI Memory Game — Visuals & Grading** | Procedural SVG JSON (~3 KB) | 1,000 sessions | **3 MB DB JSON**, **0 MB Storage**, **0 AI calls** | 500 MB DB / 1 GB Storage | **99.4% free** |
| **Sentence Shooter — Gameplay** | Deterministic DB rows (~2 KB/session) | 1,000 sessions | **2 MB DB**, **0 AI calls** | 500 MB DB | **99.6% free** |
| **Musical Karaoke — Child Playback & Live Scoring** | 1 cached MP3 (~3 MB, browser HTTP cache) + AudioWorklet DSP on device + compact session score row (~1 KB) | 500 sessions (~15 songs) | **0.5 MB DB**, **~45 MB Storage** (15 songs), **~1.5 GB Egress** (with client caching/Cache-Control), **0 AI calls**, **0 child audio uploaded** | 1 GB Storage / 5 GB Egress | **>70% free** |
| **AI Teacher / Picture Storytelling** | Procedural/Sample guide (**0 analyze calls**) + 2 text-only eval calls (~700 tok each) + occasional Custom Upload (~5% sessions) | 500 sessions (~1,000 eval calls/mo ≈ 33/day; ~25 uploads/mo ≈ 4 MB Storage) | **~700k tokens/mo (~23k tok/day)**, **4 MB Storage**, **1 MB DB** | Gemini Free + Groq Free (**200k TPD / 1,000 RPD**) | **>88% free** |
| **Admin Karaoke Simple Mode** | `mutagen` ID3 + client Web Audio + optional Groq Whisper on ~20 new songs/mo (3 min each = 60 min/mo) | 20 songs/mo | **60 min audio/mo (~2 min/day)** | Groq Whisper Free (**480 min/day**) | **>99.5% free** |
| **Render Free Web RAM** | FastAPI + SQLAlchemy + `mutagen` + `pillow` + `numpy` + `httpx` | Always-on web worker | **~160–240 MiB peak RSS** | **512 MiB RAM** | **>50% headroom** |

**Total Cash Expenditure:** **0 VND / $0.00 per month.**

---

## 5. Pros, Cons, Risks & Educational Impact

### Key Risks & Mitigations
1. **Risk: Supabase 5 GB Monthly Egress Exceeded by Repeated Karaoke MP3 Downloads.**
   - *Mitigation:* Cache signed MP3 audio in browser `Cache API` / `IndexedDB` keyed by `(song_id, version_id, audio_sha256)` on the child's device/APK so replaying a favorite song 10 times costs **1 download instead of 10** (90% egress reduction!).
2. **Risk: Supabase Free 7-Day Inactivity Pause & Render 50s Cold Start.**
   - *Mitigation:* Keep existing `/api/v1/health` lightweight endpoint (no heavy imports at startup, verified by `test_web_lightweight_startup.py`) and show a friendly Vietnamese warm-up message on frontend retry if a cold start occurs.
3. **Risk: Database Row Growth from Unbounded Per-Frame / Per-Shot Telemetry.**
   - *Mitigation:*
     - **Karaoke:** Never persist per-frame (20 Hz) DSP pitch arrays to PostgreSQL! Compute live metrics on-device and persist **only 1 compact summary row per completed karaoke session** (`lyrics_score`, `rhythm_score`, `pitch_score`, `overall_score`, `stars`, `duration_seconds`, `scoring_mode`, `weak_lines_json`).
     - **Memory Game:** Persist 1 session row (`scene_spec` JSONB ~3 KB, `questions_json` ~2 KB, summary stats) + compact per-question answers, capped cleanly with strict CHECK constraints & parent-owns-child RLS identical to `20261113120000_sentence_shooter.sql`.
     - **Sentence Shooter:** Keep idempotent server authority while optimizing client responsiveness (see `auditor-frontend` + optional batch/prefetch optimization so tap-to-animation is `< 16 ms` without spamming duplicate DB writes!).
4. **Risk: Free-Tier API Policy Change (Gemini / Groq).**
   - *Mitigation:* Every single game has a **Tier-0 Deterministic Engine** (`guide-fallback`, procedural Memory Game grading, deterministic Sentence Shooter, client-side Karaoke AudioWorklet DSP, `mutagen` ID3 + Tap-to-Sync Admin Karaoke). Even if both Gemini and Groq disappeared overnight, **all 4 games and Admin Karaoke remain 100% playable at 0 VND**.

### Educational Impact
- Zero-cost architecture ensures **equitable access** for Vietnamese primary students and families without paywalls, while freeing budget/effort to focus on **pedagogical craft** (honest scoring, scaffolding, adaptive difficulty, and unified parent insights).
- Connecting difficult words from Reading (`difficult_word_practice_attempts`) into Sentence Shooter and Memory/Storytelling vocabulary creates a **closed-loop intelligent learning ecosystem** using data already stored in Supabase at **0 extra infrastructure cost**.

---

## 6. Selected Recommendation (V4.0 Zero-Cost Blueprint)

1. **Keep `backend/requirements-web.txt` Strictly Lean:** Zero `torch`, `librosa`, `demucs`, `scipy`, or `ffmpeg` added to the web API container. Reuse installed `mutagen`, `pillow`, `numpy`, `httpx`, `FastAPI`, `SQLAlchemy`.
2. **Compute Offload Rule:**
   - **Client (Browser / Android WebView):** Real-time Karaoke AudioWorklet DSP (YIN pitch + onset rhythm), Admin MP3 Web Audio vocal/contour detection, Procedural SVG Scene rendering, Browser audio blob caching (`audio_sha256` keyed), Optimistic Sentence Shooter visual feedback.
   - **Backend (Render Free 512 MiB):** Auth/RBAC, PostgreSQL persistence, deterministic rubrics & ground-truth scene/question generation, `mutagen` ID3 extraction, thin `httpx` proxy to Gemini Free / Groq Free with caching & deterministic fallback, unified Parent Play & Learn report aggregation.
   - **Optional Local Worker Host (Desktop/Dev):** Ollama `qwen3-vl:4b`, Local Voice Worker, and `ai/karaoke_processing/` Demucs+CTC worker when explicitly enabled.
3. **Minimal Additive Database Migrations (All RLS-Protected, Parent-Owns-Child):**
   - `memory_game_sessions` & `memory_game_answers` (compact JSONB `scene_spec` + deterministic ground truth + score/stars/difficulty).
   - `karaoke_practice_sessions` (compact per-song summary scores: `lyrics_score`, `rhythm_score`, `pitch_score`, `overall_score`, `stars`, `scoring_mode`, `duration_seconds` — zero raw audio stored!).
   - Optional additive `metadata` / `reference_contour` JSONB column on `karaoke_song_versions` (nullable, backward-compatible).
   - Zero changes that break existing `gamesessions`, `picturedescriptionsessions`, `karaoke_songs`, or `difficult_word_practice_attempts`.

---

## 7. Rollback Strategy

- All V4.0 database tables and columns are strictly **additive** (new tables / nullable columns with safe defaults), following ViRead's established migration discipline (`supabase/migrations/`).
- Every new external integration (Groq Admin Whisper, text-only ground-truth evaluation fast path, procedural scenes, AudioWorklet DSP) is independently feature-flagged.
- Disabling any V4.0 flag immediately restores SHA `29e2da36` behavior with zero data loss and zero service interruption.

---

## 8. Citations & Verification Sources (Accessed 2026-11-25)

1. Render Pricing & Free Tier Documentation (512 MiB RAM, 0.1 CPU, idle spin-down, 5 GB bandwidth): https://render.com/docs/free (accessed 2026-11-25).
2. Supabase Pricing & Free Plan Quotas (500 MB DB, 1 GB Storage, 5 GB Egress, 50k MAUs, 7-day inactivity pause): https://supabase.com/pricing (accessed 2026-11-25).
3. Vercel Hobby Plan Limits (100 GB Fast Data Transfer, 1M invocations, non-commercial policy): https://vercel.com/docs/limits/overview (accessed 2026-11-25).
4. Google AI Studio — Gemini API Free Tier Pricing & Rate Limits: https://ai.google.dev/gemini-api/docs/pricing (accessed 2026-11-25).
5. Groq Cloud — Free Tier Rate Limits (LLM & Whisper Large v3 Turbo): https://console.groq.com/docs/rate-limits (accessed 2026-11-25).
6. Codebase Audit (SHA `29e2da36`): `backend/requirements-web.txt`, `backend/.env.example`, `backend/app/services/picture_description_service.py`, `backend/app/services/games/sentence_shooter_service.py`, `backend/app/repositories/sentence_shooter_repository.py`, `backend/app/services/child_progress_service.py`, `supabase/migrations/20261113120000_sentence_shooter.sql`, `20261114130000_add_karaoke.sql`, `20261115120000_picture_description.sql`, `20261117060000_add_karaoke_processing.sql`, `20261118090000_difficult_word_practice.sql`.
