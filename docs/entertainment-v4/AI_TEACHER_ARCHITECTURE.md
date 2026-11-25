# AI Teacher V4.0 & Voice Anti-Self-Capture Architecture (G05 / G10)

- **Date:** 2026-11-25
- **Branch:** `feature/viread-intelligent-play-learn-v4`
- **Goals Covered:** **G05 (AI Teacher V4.0 — Picture Storytelling)** and **G10 (Voice Anti-Self-Capture Lifecycle)**
- **Cost Target:** `0 VND / $0/month` (strict sequential free-tier routing + zero-cloud static samples + deterministic Vietnamese pedagogical fallback)

---

## 1. Strict Sequential Zero-Cost AI Routing

Implemented in `backend/app/services/picture_description_ai.py`:

### 1.1 Configuration Defaults
- `PICTURE_DESC_HEDGED_GEMINI` defaults to **`false`** (`hedged_gemini=False`). Parallel speculative hedging is disabled by default so slow primary calls never burn `2x` Gemini Free Tier RPM/RPD quota.
- `PICTURE_DESC_TRANSIENT_RETRIES` defaults to **`0`**, preventing silent extra Gemini retries after the sequential fallback chain executes.
- Existing `ocr_ai` pipelines are completely untouched.

### 1.2 Exact 5-Tier Sequential Routing Chain

```text
Tier 0 (Samples): Curated static guide (`curated-sample-v4`, 0 outbound cloud calls)
        │ (only on CUSTOM_UPLOAD, BOOK_PAGE, explicit refresh_ai_guide=True, or attempt evaluation)
        ▼
Tier 1 (Cloud 1): Gemini Primary (`GEMINI_PRIMARY`, default `gemini-3.1-flash-lite`, `thinkingLevel: MINIMAL`)
        │ (on timeout / 429 / 503 / invalid JSON; NEVER on PictureSafetyError or 401/403)
        ▼
Tier 2 (Cloud 2): Gemini Fallback (`GEMINI_FALLBACK`, default `gemini-3.5-flash-lite` + optional extras)
        │
        ▼
Tier 3 (Cloud 3): Groq Free (`GROQ_FREE`, `GROQ_API_KEY`, default `qwen/qwen3.8-27b`)
        │   • On `picture_evaluate`: uses **text-only** evaluation grounded in verified scene guide
        │     (`scene_title`, `scene_summary`, `suggested_vocabulary`, `model_sample_sentences`, rubric)
        │     so free-tier text models work cleanly with zero image-token overhead.
        ▼
Tier 4 (Local):   Local Ollama (`LOCAL_OLLAMA`, loopback `127.0.0.1:11434`, `think: false`, optional)
        │
        ▼
Tier 5 (Offline): Deterministic Vietnamese Pedagogical Fallback (`DETERMINISTIC_FALLBACK`,
                  `evaluate_description_with_guide_fallback` / `_fallback_evaluate_attempt`,
                  `build_deterministic_picture_guide`)
```

Each session and evaluation attempt carries a stable `provider_tier` tag:
`CURATED | GEMINI_PRIMARY | GEMINI_FALLBACK | GROQ_FREE | LOCAL_OLLAMA | DETERMINISTIC_FALLBACK`.

---

## 2. Zero Cloud Calls on Built-In Samples

Implemented in `backend/app/services/picture_description_service.py`:

- **`source_type == "SAMPLE"` (default `refresh_ai_guide=False`):**
  - Serves `SamplePictureSpec.default_guide` directly with `AiModelUsed = "curated-sample-v4"` and `provider_tier = "CURATED"`.
  - Executes **0 outbound cloud vision calls** when opening a built-in sample picture (`sunny-garden`, `lakeside-picnic`, `happy-classroom`).
  - Explicit `refresh_ai_guide=True` (for example via `"Tạo bộ gợi ý mới"`) releases the DB transaction (`rollback()`) before invoking vision AI, falling back cleanly to `curated-sample-v4` on retryable outages.
- **`source_type in {"CUSTOM_UPLOAD", "BOOK_PAGE"}`:**
  - Always runs vision AI + child-safety verification (`analyze_picture`) after EXIF stripping & dimension normalization (`_normalize_upload_image` / `_normalize_mime_type`).
  - On transient cloud/local unavailability (`retryable=True` or `AI_NOT_CONFIGURED`), falls back gracefully to `build_deterministic_picture_guide(...)` (`provider_tier = "DETERMINISTIC_FALLBACK"`).
  - Never masks `AI_AUTH_FAILED` (401/403) or bypasses safety blocks.

---

## 3. Critical Child-Safety Invariant (`PictureSafetyError` / `UNSAFE_PICTURE`)

Safety rejections are **strictly non-bypassable** across all tiers:

1. **Structured model rejection:** `is_child_safe: false` (boolean or string `"false"`) in Gemini, Groq, or Ollama immediately raises `PictureSafetyError` (`code="UNSAFE_PICTURE"`, `status_code=422`, `retryable=False`).
2. **Provider-level safety block:** Gemini `promptFeedback.blockReason`, candidate `finishReason`, or `safetyRatings[].blocked == true` matching safety categories (`SAFETY`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY`, `BLOCKLIST`, `SPII`, `SEXUALLY_EXPLICIT`, `HATE_SPEECH`, `HARASSMENT`, `DANGEROUS_CONTENT`) immediately raises `PictureSafetyError` inside `_extract_candidate_text`.
3. **Zero fall-through:** `_call_single_gemini_model`, `_try_gemini_hedged`, `_try_gemini`, `_try_groq`, `_try_ollama`, `_generate_json`, and `PictureDescriptionService` all propagate `PictureSafetyError` immediately without consulting lower providers, without falling back to deterministic guides, and without uploading rejected `CUSTOM_UPLOAD` bytes to storage.
4. **Prompt-injection fencing:** Child input and prior attempt transcripts remain fenced inside `<child_description>` and `<previous_attempt>` tags, and `_apply_evaluation_rubric` enforces server-side score clamps for off-topic, 1–2 word fragments, and verbatim copied sample sentences.

---

## 4. Six Pedagogical Teaching Modes, PEER/CROWD Scaffolding & Skill Evidence

### 4.1 Six Teaching Modes & Skill Mapping

| `teaching_mode` | Vietnamese UI Label | PEER / CROWD Pedagogical Focus | `learning_skill_evidence.skill_key` |
| :--- | :--- | :--- | :--- |
| `OBSERVE` *(default)* | Quan sát | Wh-questions (Ai, con vật gì, ở đâu, màu sắc) | `visual_observation` |
| `VOCABULARY` | Từ vựng | Completion & contextual usage of suggested/target difficult words | `vocabulary_naming` |
| `SENTENCE` | Ghép câu | PEER Expansion (`Ai/Con gì + đang làm gì + ở đâu/như thế nào`) | `descriptive_speaking` |
| `STORY` | Kể chuyện | Recall & 3-part narrative sequence (Mở đầu – Diễn biến – Cảm xúc) | `story_creativity` |
| `INFER` | Suy luận | Distancing & Why-questions (*vì sao*, *điều gì sắp xảy ra*) | `inferential_thinking` |
| `CREATE` | Sáng tạo | Imaginative dialogue, new title invention grounded in picture clues | `story_creativity` |

### 4.2 PEER/CROWD Response Enrichment (Backward-Compatible)
All V4 request and response fields are **optional with safe defaults** so legacy callers and stored PostgreSQL JSONB payloads remain 100% compatible:
- **Session / Evaluate Inputs:** optional `teaching_mode` (default `"OBSERVE"`), optional `target_words: list[str]` (normalized, deduplicated, max 8), optional `refresh_ai_guide: bool` on `POST /sessions`.
- **Feedback Outputs (`PictureEvaluationFeedbackRead`):**
  - `teaching_mode`
  - `scaffolding_step`: `PROMPT` | `EXPAND` | `PRAISE` | `NEXT_CHALLENGE`
  - `next_prompt_question`: warm grade-adaptive Vietnamese PEER/CROWD follow-up question (`cô` / `bé`), guaranteed non-empty via deterministic fallback if omitted by LLM
  - `used_target_words`: deterministically verified against child transcript (`detect_used_target_words`) so target words are never hallucinated
  - `provider_tier`

### 4.3 Compact `learning_skill_evidence` Recording
After each committed attempt, `PictureDescriptionService._record_learning_skill_evidence` inserts compact evidence rows into `learning_skill_evidence` (`source_module = 'PICTURE_DESCRIPTION'`, `source_record_id = str(attempt_id)`):
- Primary `skill_key` mapped from `teaching_mode`, plus a secondary `vocabulary_naming` row when `used_target_words` is non-empty and primary skill differs.
- `evidence_type = "OBSERVED"` (`confidence = 0.85`) for AI evaluations and `"ESTIMATED"` (`confidence = 0.55`) for deterministic fallback.
- Wrapped in an isolated transaction with `try/except` + `rollback()` so unmigrated environments or unit-test mocks skip cleanly without ever breaking `evaluate_attempt()`.

---

## 5. Frontend AI Teacher V4.0 & Anti-Self-Capture Voice Lifecycle (G10)

Implemented in `frontend/components/entertainment/picture-description/picture-description-screen.tsx`, `frontend/types/picture-description.ts`, and `frontend/lib/api/picture-description-service.ts`:

### 5.1 Pedagogy & Grade-Adaptive Scaffolding
- **6 Kid-Friendly Teaching Mode Selector Pills:** `Quan sát`, `Từ vựng`, `Ghép câu`, `Kể chuyện`, `Suy luận`, `Sáng tạo` with concise cues and 1-tap audio mode guidance.
- **Target Difficult-Word Badges:** Displayed when `target_words` exist on the session, highlighting matched words live and celebrating `used_target_words` in the Result tab.
- **AI Teacher Follow-Up Card:** Displays `next_prompt_question` + `scaffolding_step` badge in the Result tab with `"Nghe câu hỏi"` TTS playback and `"Trả lời câu hỏi này"` 1-tap transition back to the Practice tab.
- **Grade-Adaptive Scaffolding:**
  - **Grades 1–2:** Audio-first visual hints (`data-testid="grade-hint-chips"` + `"Nghe hướng dẫn"` audio button) are shown prominently by default.
  - **Grades 4–5:** Hint chips are collapsed by default (`aria-expanded="false"` on `toggle-grade-hint-chips`) and expandable in 1 tap.
- **Preserved 2-Tab Result Experience:** Existing `Mô tả tranh` and `Kết quả chấm điểm` tabs, spoiler-free hints, multi-attempt history, and `FALLBACK` AI re-grade flow remain intact.

### 5.2 G10 Anti-Self-Capture Voice Lifecycle
1. **TTS Start Aborts Active Mic:** Calling `speakVietnamese(...)` immediately invokes `abortActiveVoiceCapture({ preserveDraft: true })`, aborting active `SpeechRecognition`, cancelling `recorder`, and preserving any spoken words already captured.
2. **Record Start Cancels Active TTS + Cooldown:** Clicking `"Nói bằng Micro"` immediately calls `stopSpeechPlayback()` (`speechPlayer.stop()` + `window.speechSynthesis.cancel()`). If TTS was active or ended within `TTS_MIC_COOLDOWN_MS = 280ms`, mic arming waits the remaining cooldown with a cancellable token (`micArmTokenRef`) so acoustic speaker echo is never recorded.
3. **Hard Self-Capture Gate:** `SpeechRecognition.onresult` drops any event arriving while `isTtsPlayingRef.current`, `!isRecordingVoiceRef.current`, or `window.speechSynthesis.speaking` is true.
4. **Background & Unmount Safety:** `visibilitychange` (`document.hidden`), `viread:android-background`, and component unmount immediately cancel TTS, abort mic capture, clear pending cooldown timers, and preserve any live spoken draft in React state.
5. **Offline Draft Preservation & Duplicate Submission Guard:**
   - Offline (`navigator.onLine === false`) and failed network evaluations preserve `descriptionText` intact with a 1-tap retry button.
   - Synchronous `isEvaluatingRef` lock + `DUPLICATE_SUBMIT_WINDOW_MS = 1500ms` post-success dedupe key prevent accidental rapid double-submissions while explicitly allowing immediate retry on errors and immediate AI re-grade of `FALLBACK` attempts.

---

## 6. Verification Summary

All verification commands were run cleanly after final edits and Prettier formatting:

| Suite | Command | Result |
| :--- | :--- | :--- |
| **Backend Unit & Route Tests** | `backend\.venv\Scripts\python.exe -m pytest backend/test_picture_description.py -v` | **29 passed, 0 failed** (3.27s) |
| **Frontend UI & G10 Voice Tests** | `cd frontend; npx vitest run test/picture-description-ui.test.tsx` | **10 passed, 0 failed** (10.73s) |
| **Frontend ESLint (Owned Files)** | `cd frontend; npx eslint types/picture-description.ts lib/api/picture-description-service.ts components/entertainment/picture-description/picture-description-screen.tsx test/picture-description-ui.test.tsx` | **0 errors, 0 warnings** |
| **Frontend Formatting** | `cd frontend; npx prettier --write ...` | **All 4 files formatted cleanly** |
