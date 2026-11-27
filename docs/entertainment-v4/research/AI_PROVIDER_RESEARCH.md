# AI Provider Research — ViRead Play & Learn V4.0

**Date:** 2026-11-25  
**Scope:** Multi-provider AI routing, latency, zero-cost sustainability, Vietnamese primary-education quality (Grades 1–5), child privacy, and deterministic fallback across all ViRead Play & Learn V4.0 features (AI Teacher / Picture Storytelling, AI Memory Game, Sentence Shooter personalization, Musical Karaoke lyric transcription/structuring, and Parent Progress Insights).  
**Codebase Baseline:** Branch `feature/viread-intelligent-play-learn-v4`, SHA `29e2da36`.

---

## 1. Problem Statement

ViRead Play & Learn V4.0 introduces richer interactive learning loops for Vietnamese primary students (Grades 1–5):
1. **AI Teacher / Picture Storytelling (`picture_description`)** — analyzing images, generating Grade 1–5 Vietnamese guiding questions & vocabulary, evaluating child spoken/typed storytelling across multi-turn attempts, and integrating child reading/difficult-word signals.
2. **AI Memory Game (New)** — generating grade-appropriate Vietnamese recall questions, distractors, and feedback grounded in verifiable scene ground-truth JSON (never allowing AI to hallucinate nonexistent scene details).
3. **Sentence Shooter (`sentence_shooter`)** — currently 100% deterministic from verified book `PageRevisionWord` rows (zero AI calls on hot path), plus optional difficult-word prioritization from `difficult_word_practice_attempts` and `ReadingEvent`.
4. **Admin Karaoke Automation (`karaoke_processing`)** — optional one-file MP3 lyric transcription & draft lyric structuring when embedded ID3 `USLT`/`SYLT` tags are absent.
5. **Parent Learning Reports (`child_progress`)** — summarizing deterministic backend metrics (never letting LLMs invent or alter scores).

**Core Constraints:**
- **Zero-cost operational target (0 VND / $0/month):** Must sustain classroom/family demo and capstone production workloads without paid billing surprises.
- **Render Free Web API RAM ceiling (512 MiB):** `backend/requirements-web.txt` explicitly excludes `torch`, `torchvision`, `paddlepaddle`, `librosa`, and heavy local ML runtimes.
- **Child privacy & safety:** Children's raw audio and personal identifiers must never leak to third-party training pipelines; prompts must fence untrusted child transcripts against prompt injection; outputs must enforce child-safe Vietnamese pedagogical tone (`cô` / `bé`, Grades 1–5).
- **Resilience:** No feature may hard-block a child when a cloud free-tier quota (`429`) or transient overload (`503`) occurs.

---

## 2. Existing Implementation Audit

A full read of the `backend/` codebase on SHA `29e2da36` reveals **four independent AI/Voice orchestration stacks** with overlapping provider logic and slightly inconsistent model defaults:

| Subsystem | Source Files | Provider Chain Today | Default Models (`.env.example` / code) | Fallback / Resilience |
|---|---|---|---|---|
| **Picture Description (Multimodal VLM)** | `backend/app/services/picture_description_ai.py` (1,983 lines), `picture_description_service.py` (718 lines) | Gemini (hedged multi-model) → Groq OpenAI-compat → Local Ollama (`127.0.0.1:11434`) → Deterministic fallback | Primary `gemini-3.1-flash-lite`, fallback `gemini-3.5-flash-lite`, extras `gemma-4-26b-a4b-it`, `gemini-flash-lite-latest`; Groq `qwen/qwen3.8-27b`; Ollama `qwen3-vl:4b-instruct-q4_K_M` | Hedged Gemini stagger (`3.5s`), 45s per-model cooldown, `thinkingLevel: MINIMAL`, curated sample guide fallback (`builtin-sample-guide`), deterministic Vietnamese keyword/rubric evaluator (`guide-fallback`) |
| **OCR Post-Correction (Multimodal VLM)** | `backend/app/services/ocr_ai/orchestrator.py` (487 lines), `config.py`, `gemini_provider.py`, `groq_provider.py`, `ollama_provider.py` | Strict sequential: `gemini_3_5` → `gemini_3_1` → `groq_qwen` → `ollama_qwen3_vl` (fail-closed) | Primary `gemini-3.5-flash-lite`, fallback `gemini-3.1-flash-lite`, Groq `qwen/qwen3.8-27b`, Ollama `qwen3-vl:4b-instruct-q4_K_M` | Family-level circuit disable (`disables_family=True` on 401/403/429/5xx), uncertain-token partial handoff, private parent books forced `local_only_copy()` unless `PRIVATE_BOOK_ALLOW_CLOUD_AI=true` |
| **Child Progress & Tutor Questions (Text LLM)** | `backend/app/services/child_progress/ai.py` (303 lines), `child_progress_service.py`, `tutor_questions/config.py` | Sequential: Gemini primary → Gemini fallback → Groq | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `qwen/qwen3.8-27b` | 24h in-memory fingerprint LRU cache (256 entries), 60s refresh cooldown, deterministic `rule_based_assessment(facts)` fallback; **missing local Ollama fallback** |
| **Voice STT & TTS** | `backend/app/services/voice_orchestrator.py` (521 lines), `app/api/routes/voice.py`, `providers/local_voice_provider.py`, `google_voice_provider.py`, `elevenlabs_voice_provider.py` | Local-first (`127.0.0.1:8010`) → Optional Google Cloud backup (explicit parent toggle `local_with_google_fallback`) | Local Vietnamese TTS/STT worker; Google Neural2/WaveNet backup; legacy ElevenLabs disabled by default | `SessionVoiceLock` ("Một buổi, một giọng"), turn deduplication cache (`120s` TTL, 512 entries), zero child audio persistence |

### Verified Baseline Findings & Bottlenecks
1. **Fragmented AI client configs:** `ocr_ai`, `picture_description_ai`, `child_progress/ai`, and `tutor_questions` each parse `GEMINI_API_KEY` / `GROQ_API_KEY` separately and even swap primary/fallback order (`gemini-3.1-flash-lite` first in Picture Description vs `gemini-3.5-flash-lite` first in OCR/Progress/Tutor).
2. **Double-download / high latency in Picture Description:**
   - `picture_description_service.py` downloads & normalizes the session image on *every* `evaluate_attempt()` call (`L639`) and re-sends base64 image bytes to the VLM even when evaluating attempt #2 or #3 of a static `SAMPLE` or `PROCEDURAL` scene that already has structured ground truth.
   - `picture_description_ai.py` runs `hedged_gemini=True` by default (`L235`), which can double Gemini Free Tier RPM/RPD consumption whenever primary takes >`3.5s` (common on Vietnamese multimodal responses).
3. **No local Ollama binary on current host PATH** (verified via `Get-Command ollama` = empty), and Render Free (512 MiB RAM) cannot host Ollama. Therefore, local Ollama is strictly a **desktop/dev-host fallback**, not a hosted cloud fallback.
4. **Data Privacy Gap on Gemini Free Tier:** Per Google AI Studio official Terms of Service, prompts/media sent via Gemini **Free Tier** may be reviewed by human reviewers and used to improve Google products. For children's `CUSTOM_UPLOAD` photos or child voice transcripts, sending raw PII or child photos over a free tier without minimization/consent is a privacy risk.
5. **Baseline Backend Test Verification (2026-11-25):**
   - `test_picture_description.py`, `test_admin_ocr_multimodel.py`, `test_admin_ocr_contracts.py`, `test_admin_ocr_child_safety.py`, `test_child_progress.py`, `test_voice.py` all **PASSED** as part of the 22-module tracked baseline (**327 passed, 8 skipped, 0 failed**, 219 subtests in 12.29s).

---

## 3. Candidate Providers Evaluated

| Candidate | Modalities | Free Tier Limits (Verified 2026-11-25) | Vietnamese Quality (Grades 1–5) | Structured JSON Support | Latency (p50) | Privacy / Data Policy |
|---|---|---|---|---|---|---|
| **A. Google Gemini API (Free Tier: Flash-Lite / Gemma 4)** | Text, Image, Audio | Free tokens; per-project RPM/TPM/RPD enforced dynamically in AI Studio (`aistudio.google.com/rate-limit`). Paid ref: 3.1 Flash-Lite $0.25/1M in, $1.50/1M out. | **Excellent** for Vietnamese diacritics, tone marks, and primary-school pedagogy. | Native `responseMimeType: application/json` + `responseJsonSchema`. | 1.5–4.5s (with `thinkingLevel: MINIMAL`) | **Free tier data may be used by Google to improve products**; paid tier opts out. Must strip PII & EXIF. |
| **B. Groq Cloud API (Free Tier: Qwen + Whisper Large v3 Turbo)** | Text, Vision (console-rotated), Audio STT | No credit card; **30 RPM / 1,000 RPD / 8,000 TPM / 200,000 TPD** (LLM); **20 RPM / 2,000 RPD / 28,800 audio sec/day (8h/day)** for Whisper, 100 MB max file. | **Strong** on Qwen3 series for Vietnamese; **Very Strong** on `whisper-large-v3-turbo` for Vietnamese audio transcription. | `response_format: {"type": "json_object"}` (validate schema locally). | **Very Fast** (0.4–1.5s on LPU) | Free tier enforces org-wide rate pool; check console retention toggle (zero-data-retention configurable in org settings). |
| **C. Local Ollama (`qwen3-vl:4b-instruct-q4_K_M`)** | Text, Image | **Unlimited / $0** (local hardware electricity only; requires 4 GB VRAM or 16 GB RAM host). | Good for OCR/short Vietnamese JSON with `think: false`; slower and occasionally drops schema fields on complex rubrics. | Native `format: <json_schema>` in `/api/chat`. | 4–25s on 4 GB VRAM / CPU | **100% private** (loopback `127.0.0.1:11434`, zero external egress). |
| **D. Deterministic / Algorithmic Engine (Zero-AI Ground Truth)** | Structured JSON, Vietnamese NLP (`unicodedata`, `RapidFuzz`, regex, rules) | **Unlimited / $0**, runs inside Render 512 MiB RAM and/or client browser. | **100% deterministic, zero hallucination** when paired with procedural scene specs or curated guides. | Native Python/TS structs. | **< 10 ms** | **100% private**, zero external transfer. |
| **E. Cloudflare Workers AI (Free Tier)** | Text, Image, Audio (`whisper`, Llama, FLUX) | **10,000 Neurons/day** (resets 00:00 UTC), no credit card. | Moderate for Vietnamese (Llama 3.x weaker than Gemini/Qwen on Vietnamese primary-school idioms). | JSON mode via prompt / grammar on select models. | 1–3s at edge | Data not trained on by default per Cloudflare AI policy, but 10k Neurons/day is tight for vision+text. |
| **F. OpenAI / Anthropic Paid APIs** | Text, Vision, Audio | **$0 free tier unavailable** (requires paid credits). | Excellent | Native JSON schema | 1–3s | Commercial API zero-training default. **Eliminated by 0 VND constraint.** |

---

## 4. Pros, Cons, Cost, Risks & Educational Impact

### Pros & Cons Summary
- **Hybrid Tiered Router (Deterministic First → Cache → Gemini Free → Groq Free → Local Ollama → Deterministic Fallback):**
  - *Pros:* Preserves 90%+ of free-tier quota by eliminating redundant AI calls (procedural scenes, cached guides, cached progress reports, deterministic Sentence Shooter, client-side DSP karaoke scoring); keeps interactive UX responsive even under Gemini `503`/`429`; reuses existing `httpx` clients with zero new pip dependencies.
  - *Cons:* Requires disciplined quota conservation (e.g., turning off wasteful eager hedging when primary latency is normal, or raising hedge stagger from `3.5s` to `5.5s`), and careful PII redaction before cloud calls.

### Cost Analysis (Monthly Projection for 50 Active Families / Classroom Pilot)
- **Deterministic tasks** (Sentence Shooter, Memory Game scene generation + answer verification, Karaoke live DSP scoring, Audio ID3 metadata parsing): **0 API calls = $0 / 0 VND**.
- **AI Teacher / Picture Storytelling:**
  - Procedural & Sample scenes carry pre-computed ground-truth guides (**0 VLM analyze calls**).
  - Child storytelling evaluation (~200–400 evaluations/day): Text-only evaluation against scene ground-truth JSON uses ~450 input tokens + ~250 output tokens = ~700 tokens/eval (~140k–280k tokens/day). Fits comfortably inside **Gemini Free Tier + Groq Free Tier (1,000 RPD / 200k TPD)** with **0 VND cost**.
  - Custom uploaded parent photos (~20–50/day): Multimodal VLM call only on creation (1 call) + optional evaluation. Fits inside Gemini Free Tier (**0 VND**).
- **Admin Karaoke Auto-Lyrics (optional when MP3 has no ID3 lyrics):** ~5–15 songs/day × 3 min = 15–45 min audio/day, well below Groq Whisper Free Tier (**480 min/day = 28,800 sec/day**). **0 VND**.
- **Total Monthly AI Spend:** **$0.00 (0 VND)**.

### Risks & Mitigations
1. **Risk: Gemini Free Tier Privacy on Child Photos/Audio.**
   - *Mitigation:* Never send child names, parent IDs, emails, or GPS/EXIF metadata (already stripped by `ImageOps.exif_transpose` + re-encode in `picture_description_service.py`). For procedural scenes and memory scenes, evaluate via **text-only structured ground truth** so no child photo is uploaded. Display clear parent notice before uploading custom family photos to cloud vision, and support `PICTURE_DESC_CLOUD_ENABLED=false` (local Ollama / deterministic fallback) just like `PRIVATE_BOOK_ALLOW_CLOUD_AI=false` in `ocr_ai/config.py`.
2. **Risk: Quota Exhaustion (`429`) from Hedged Requests.**
   - *Mitigation:* `PICTURE_DESC_HEDGED_GEMINI` currently fires a second Gemini model after `3.5s`, consuming 2× RPM/RPD on slower calls. Recommend: keep hedging opt-in or raise `DEFAULT_HEDGE_STAGGER_SECONDS` to `5.0–6.0s` AND skip cloud VLM altogether for `SAMPLE` and `PROCEDURAL` `analyze_picture` calls (use exact ground-truth guide directly; call AI only for dynamic child attempt coaching).
3. **Risk: LLM Hallucination in Educational Grading.**
   - *Mitigation:* Keep **backend deterministic rubrics as the authority**:
     - `child_progress`: Backend computes all scores; AI only narrates verified `facts_payload`.
     - `picture_description`: Preserve `_apply_evaluation_rubric` (`picture_description_ai.py:604`) + add ground-truth entity/fact verification for procedural scenes.
     - `memory_game`: Ground truth (`objects`, `colors`, `counts`, `positions`, `relations`) is generated deterministically with the scene; answer grading is **100% deterministic**, while AI is strictly optional for warm Vietnamese coaching messages.
4. **Risk: Prompt Injection from Child/Parent Input.**
   - *Mitigation:* Retain XML fencing (`<child_description>`, `<previous_attempt>`, `<so_lieu>`) and strict JSON schema validation + Vietnamese length/character sanitization.

### Educational Impact (Vietnamese Primary Grades 1–5)
- **Immediate, Honest Formative Feedback:** Deterministic + LLM hybrid guarantees `<3s` feedback (and `<10ms` fallback if cloud is down), preventing frustration for 6–11-year-old learners.
- **Grade-Adaptive Vietnamese Scaffolding:** Prompts enforce `cô`/`bé` tone, Grade 1–2 short 1-sentence scaffolds vs Grade 3–5 descriptive multi-clause expansion (`Ai + đang làm gì + ở đâu + cảm xúc`), aligned with GDPT 2018 Tiếng Việt tiểu học.
- **Zero-Hallucination Trust:** Children never get marked wrong for a detail that *is* in the picture or rewarded for copying sample sentences (`_is_copied_from_samples`).

---

## 5. Selected Recommendation

Adopt a **Unified Zero-Cost 4-Tier AI Routing Policy** across ViRead Play & Learn V4.0 (without breaking existing `ocr_ai`, `child_progress`, or `voice_orchestrator` contracts):

1. **Tier 0 — Deterministic Engine & Ground Truth (Default for Structure & Scoring):**
   - Procedural scene generation + ground truth (`Picture Storytelling` & `AI Memory Game`).
   - All numeric scoring (Sentence Shooter, Memory Game MCQ/recall verification, Karaoke DSP pitch/rhythm/words, Child Progress KPIs).
   - Built-in sample guides (`SAMPLE_CATALOG`) and guide-grounded fallback (`evaluate_description_with_guide_fallback`).
2. **Tier 1 — Primary Cloud Free Tier (Gemini Flash-Lite):**
   - `gemini-3.1-flash-lite` / `gemini-3.5-flash-lite` (with `thinkingLevel: MINIMAL` and native `responseJsonSchema`) for Vietnamese pedagogical coaching, storytelling evaluation, and custom-upload picture analysis.
   - Add **text-only evaluation fast path** when the session already has verified structured ground-truth JSON (procedural/sample scenes), cutting token size by ~75% and latency by ~40–60%.
3. **Tier 2 — Secondary Cloud Free Tier (Groq LPU):**
   - `qwen/qwen3.8-27b` (JSON mode + local Pydantic validation) as fast text/multimodal failover when Gemini returns `429`/`503`/timeout.
   - `whisper-large-v3-turbo` on Groq Audio API (`https://api.groq.com/openai/v1/audio/transcriptions`, 28,800 audio sec/day free) as an **opt-in, zero-cost Admin Karaoke lyric-transcription helper** when an uploaded MP3 lacks embedded `USLT`/`SYLT` lyrics and no local ASR worker is configured.
4. **Tier 3 — Local Privacy-First Fallback (Ollama `qwen3-vl:4b-instruct-q4_K_M` + Local Voice Worker):**
   - Used on desktop/local-host deployments (`127.0.0.1:11434`, `127.0.0.1:8010`) and mandatory for private books (`PRIVATE_BOOK_ALLOW_CLOUD_AI=false`).
   - Add content-hash caching (in-memory LRU + DB persistence in `PromptPayload` / `FeedbackPayload`) so repeated evaluations or unchanged guides never pay a second API call.

---

## 6. Rollback Strategy

- Every V4.0 AI routing improvement is controlled by explicit environment flags (`PICTURE_DESC_CLOUD_ENABLED`, `PICTURE_DESC_HEDGED_GEMINI`, `PICTURE_DESC_TEXT_ONLY_GROUND_TRUTH_EVAL`, `KARAOKE_ADMIN_GROQ_LYRICS_ENABLED`), defaulting safely so disabling a flag restores the exact baseline SHA `29e2da36` behavior.
- Existing `ocr_ai`, `child_progress`, `tutor_questions`, and `voice_orchestrator` interfaces remain backward-compatible; no existing API keys, env var names, or DB columns are removed or renamed.
- If any cloud provider revokes or tightens free-tier quotas, flipping `*_CLOUD_ENABLED=false` drops cleanly to Tier 3 (Ollama) + Tier 0 (deterministic Vietnamese fallback) with zero downtime or 5xx errors for children.

---

## 7. Citations & Verification Sources (Accessed 2026-11-25)

1. Google AI for Developers — Gemini API Pricing & Free Tier Overview (Flash-Lite tiers, context caching, Batch API): https://ai.google.dev/gemini-api/docs/pricing (accessed 2026-11-25).
2. Google AI Studio — Rate Limits & Terms of Service (RPM/TPM/RPD per project; Free vs Paid data usage policy): https://ai.google.dev/gemini-api/docs/rate-limits and https://ai.google.dev/gemini-api/terms (accessed 2026-11-25).
3. Groq Cloud Documentation — Rate Limits & Audio Speech-to-Text (`whisper-large-v3-turbo`, 30 RPM / 1,000 RPD / 8k TPM / 200k TPD; 20 RPM / 28,800 audio sec/day, 100 MB limit): https://console.groq.com/docs/rate-limits and https://console.groq.com/docs/speech-to-text (accessed 2026-11-25).
4. Cloudflare Workers AI — Pricing & Free Tier (10,000 Neurons/day): https://developers.cloudflare.com/workers-ai/platform/pricing/ (accessed 2026-11-25).
5. Codebase Audit (SHA `29e2da36`): `backend/app/services/picture_description_ai.py`, `backend/app/services/picture_description_service.py`, `backend/app/services/ocr_ai/orchestrator.py`, `backend/app/services/ocr_ai/config.py`, `backend/app/services/child_progress/ai.py`, `backend/app/services/tutor_questions/config.py`, `backend/app/services/voice_orchestrator.py`, `backend/requirements-web.txt`, `backend/.env.example`.
