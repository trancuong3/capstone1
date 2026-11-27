# Zero-Cost, Render 512 MiB & Free-Tier Capacity Audit — ViRead Play & Learn V4.0

- **Audit Date:** 2026-11-25
- **Auditor:** `qa-independent` (Independent Zero-Cost & Infrastructure Auditor)
- **Branch:** `feature/viread-intelligent-play-learn-v4`
- **Verdict:** **`PASS — STRICT 0 VND ($0.00/month) OPERATIONAL ARCHITECTURE VERIFIED`**

---

## 1. Zero-Cost Invariant Verification Checklist

| Constraint | Verification Method | Verified Result | Status |
|---|---|---|---|
| **Zero Paid APIs Introduced** | Audited all V4 backend/frontend HTTP clients (`picture_description_ai.py`, `memory_game_evaluator.py`, `karaoke_simple_import_service.py`, `adaptive_learning_service.py`, `sentence_shooter_service.py`, `musical-dsp.ts`) | Uses ONLY **Gemini Free Tier**, **Groq Free Tier** (`whisper-large-v3-turbo` / `qwen/qwen3.8-27b` / `llama-3.1-8b-instant`), optional local **Ollama**, and **Tier-0 deterministic engines**. Zero OpenAI, zero paid image-gen (FLUX/DALL·E), zero LALAL.ai/Moises, zero new paid TTS/STT calls. | **PASS** |
| **Render Free 512 MiB RAM Protection** | `git diff 29e2da36 -- backend/requirements.txt backend/requirements-web.txt backend/app/sever.py backend/app/services/ocr_ai/` + `test_web_lightweight_startup.py` (5/5 PASS) | **0 bytes added** to `requirements-web.txt` or `requirements.txt`. Zero `torch`, `librosa`, `demucs`, `scipy`, or `ffmpeg` imported by web API startup. Audio DSP (YIN F0, spectral flux, vocal/instrumental classifier) executes 100% client-side in browser Web Audio API (`0 MB` server RAM). | **PASS** |
| **Zero Cloud Calls on Built-In Samples** | Audited `picture_description_service.py:651-658` + `test_picture_description.py` | Opening built-in samples (`sunny-garden`, `lakeside-picnic`, `happy-classroom`) serves `curated-sample-v4` directly with **0 outbound cloud Vision calls**. | **PASS** |
| **No 2× Free-Tier Quota Burn (Sequential AI)** | Audited `picture_description_ai.py:72-73, 291-297` & `memory_game_evaluator.py:792-805` | `PICTURE_DESC_HEDGED_GEMINI` defaults to **`False`**; `PICTURE_DESC_TRANSIENT_RETRIES` defaults to **`0`**. Both AI Teacher and Memory Game call providers strictly sequentially (`Gemini -> Groq -> Ollama -> Deterministic`). | **PASS** |
| **Zero Image Binary Storage for Memory Game** | Audited `memory_scene_generator.py`, `memory_game_repository.py`, `memory-scene-canvas.tsx` | Unlimited deterministic Vietnamese SVG scenes stored strictly as compact `SceneSpec` JSONB (**~3 KB/session**), **0 bytes** Supabase Object Storage and **0 bytes** image egress. | **PASS** |
| **Zero Raw Audio Storage for Karaoke** | Audited `schemas/karaoke_practice.py:32-70, 153-160`, `20261125120000_entertainment_v4_ecosystem.sql:113-150` | Strictly forbids raw audio keys (`extra="forbid"`, recursive key blocklist), caps `report_payload <= 32 KiB`, persists only compact summary integers + segment pointers (~1–2 KB/session). | **PASS** |
| **Laptop-Off / Offline Cloud Honest Degraded Mode** | Audited `picture_description_ai.py:1910-1999`, `memory_game_evaluator.py:725-738`, `karaoke_simple_import_service.py:673-705`, `karaoke-workspace-screen.tsx:195-208` | When local Ollama is unreachable (`_OLLAMA_UNREACHABLE_UNTIL` 60s circuit breaker) or offline Demucs worker is OFF: (1) Admin Karaoke Simple Mode stays 100% active via browser DSP + ID3/LRC/Groq Whisper + Spacebar tap-sync; (2) Memory Game & Sentence Shooter & Karaoke DSP work 100% deterministically; (3) AI Teacher falls back to deterministic Vietnamese rubric for `SAMPLE`/`BOOK_PAGE` and evaluations while failing closed for unscreened `CUSTOM_UPLOAD` (P1-1 fixed & verified). | **PASS** |

---

## 2. Bounded Memory, Cache & Payload Controls

| Component | Bound Verified in Code | Protection Against Resource Exhaustion |
|---|---|---|
| **Auth Token Cache** (`backend/app/api/deps.py:25`) | `_AUTH_CACHE_MAX_ENTRIES = 512`, TTL ≤ 45s capped by JWT `exp` | Bounded process RAM |
| **Role Cache** (`backend/app/database/role_cache.py:14`) | `_MAX_CACHE_ENTRIES = 2048`, TTL = 60s | Bounded process RAM |
| **Karaoke Practice Report** (`backend/app/schemas/karaoke_practice.py:32`) | `MAX_REPORT_PAYLOAD_BYTES = 32_768` (32 KiB) + max nesting depth `6` | Prevents DB bloat & JSON DoS |
| **Karaoke MP3 & Cover Uploads** (`backend/app/schemas/karaoke.py`, `karaoke_media_service.py`) | Audio `<= 20 MiB`, duration `<= 300,000 ms`, cover `<= 2 MiB` / `<= 4096 px`, lyrics `<= 300 lines` / `<= 50,000 chars` / `<= 10,000 syllables` | Prevents OOM & decompression bombs |
| **Picture Uploads** (`backend/app/services/picture_description_service.py:71-73`) | Upload `<= 5 MiB`, `<= 25M px`, downscaled `<= 1280 px` JPEG (`<= 768 px` for Vision AI) | Caps Supabase Storage & Vision token cost |
| **Adaptive Learning Queries** (`backend/app/repositories/adaptive_learning_repository.py`) | Explicit `.limit()` on every query (`400` evidence, `200` word attempts, `50` sessions/module) + `window_days` clamped `7..90` | Prevents unbounded scans on Supabase Free 500 MB DB |
| **Sentence Shooter Client Queue** (`frontend/components/entertainment/sentence-shooter/shot-queue.ts`) | `MAX_QUEUED_SHOTS = 6`, max `1` concurrent HTTP request on wire | Prevents request storms & DB lock contention |
| **Karaoke Client DSP Buffers** (`frontend/lib/karaoke/musical-dsp.ts`) | Pre-allocated `YinWorkspace` + single `Float32Array(2048)` reused at 25 Hz (`40ms`) | Zero per-frame GC churn on low-end Android phones |

---

## 3. Projected Monthly Free-Tier Headroom (100 Active Children · 3,000 Sessions/Month)

| Platform & Ceiling | V4.0 Projected Usage | Remaining Free Headroom | Risk Level |
|---|---|---|---|
| **Vercel Hobby** (`100 GB` transfer / `1M` invocations) | Static SVG/JS + Next.js routes (`< 5 GB/mo`) | **> 95%** | Low |
| **Render Free Web** (`512 MiB` RAM / `5 GB` egress) | Lightweight FastAPI (`~160–240 MiB` RSS; zero new Python deps) | **> 50% RAM** | Low *(30–50s cold start mitigated by Android 90s timeout)* |
| **Supabase Free Postgres** (`500 MB` DB) | ~6.5 MB/mo across all 4 games + evidence (~78 MB/year) | **> 84% (Year 1)** | Low |
| **Supabase Free Storage** (`1 GB` storage / `5 GB` egress) | ~45 MB (15 karaoke MP3s) + ~4 MB/mo custom pictures; **0 MB** Memory Game; **0 MB** child audio | **> 95% storage**; **~70% egress** *(monitor MP3 replay egress if scaling >100 children; consider client `Cache API` keyed by `audio_sha256`)* | Low–Medium *(egress)* |
| **Gemini Free + Groq Free** (`200k TPD` / `1,000 RPD` LLM; `480 min/day` Whisper) | ~33 AI Teacher evals/day (~23k tok/day) + ~2 min/day Admin Whisper; 0 calls for samples, Sentence Shooter, Karaoke DSP, Adaptive Engine | **> 88% LLM**, **> 99.5% Whisper** | Low |

**Verified Recurring Infrastructure Cost:** **`0 VND / $0.00 per month`**.
