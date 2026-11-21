# ViRead Admin AI, Child Safety, Rights Evidence, Verification Gate & Quality QA — Master Plan

**Working Branch:** `feat/admin-ai-quality-qa-20261121` (isolated worktree `F:\c1\capstone1-admin-ai-qa`)  
**Base Commit:** `aafa3966` (`origin/main`)  
**Date:** 2026-11-21

## 1. Architecture & Layer Map (`BACKEND_FLOW_STANDARD.md`)

Strict layering: `Router -> Schema -> Service -> Repository -> Model/ORM -> PostgreSQL`.

### Backend Core Modules
- **AI OCR Correction & Fallback:**
  - `backend/app/services/ocr_ai/config.py` — Cloud (`gemini_3_5`, `gemini_3_1`, `groq_qwen`) + local (`ollama_qwen3_vl` at `127.0.0.1:11434`).
  - `backend/app/services/ocr_ai/orchestrator.py` — Chunk-level provider fallback, family disabling, budget reservation for local Ollama, safe structured logging.
  - `backend/app/services/ocr_ai/{gemini_provider,groq_provider,ollama_provider}.py` — Provider clients, structured output + JSON fallback.
  - `backend/app/services/ocr_ai/validators.py` — Strict token count, boundary punctuation preservation, internal punctuation guard, reorder guard without false positives on legitimate repeated-word diacritic fixes.
  - `backend/app/services/ocr_ai/child_safety.py` — `GRADE_1_TO_5` multi-chunk text safety assessment, shared `disabled_families`, schema-explicit fallback prompt, contradiction escalation, explicit separation of `text_safety_status` vs `image_safety_status` (`UNASSESSED_NO_VISION_MODEL`).
- **Durable Workflow & Worker:**
  - `backend/app/models/admin_ai_workflow.py` — `AdminAiWorkflow` + `AdminAiWorkflowEvent` + `AdminAiWorkflowSafetyRun` (plus additive manual image safety review metadata/columns).
  - `backend/app/repositories/admin_ai_workflow_repository.py` — Atomic lease claiming, lease heartbeat/reclaim, stale-lease protection, revision/hash-bound updates.
  - `backend/app/services/admin_ai_workflow_service.py` — Idempotent start/retry/edit/decision + manual Admin image safety confirmation bound to `source_image_sha256`.
  - `backend/app/jobs/admin_ai_workflow_worker.py` — Background worker executing OCR AI + Child Safety with zero auto-publish/auto-verify bypasses.
- **Verification Gate & OCR Revision Lifecycle:**
  - `backend/app/services/admin_ocr_service.py` — `save_draft` (marks mismatched workflow candidate/safety stale) & hardened server-side `verify` gate bound to `(page_id, revision_id, image_revision/source_image_sha256, content_hash, workflow_state, text_safety_complete, admin_image_safety, rights_evidence_version)`. Rejects `AI_AUTO_VERIFIED` for new verifications; preserves legacy verified records.
- **Rights Evidence, Book Quality & Parent Reports:**
  - `supabase/migrations/20261121120000_book_rights_and_verification_gate.sql` — Additive tables `bookrightsevidences`, `bookrightsevidencehistory`, additive columns on `adminaiworkflows`, updated CHECK constraint on `bookcontentreports` (`CHILD_SAFETY_CONCERN`, `COPYRIGHT_CONCERN`).
  - `backend/app/models/book_content_quality.py`, `backend/app/repositories/book_content_quality_repository.py`, `backend/app/services/book_content_quality_service.py`, `backend/app/services/book_quality_ollama.py`, `backend/app/api/routes/book_content_quality.py`, `backend/app/policies/book_approval.py`.
  - Per-page quality diagnostics (`MISSING_IMAGE`, `EMPTY_OCR`, `OCR_ERROR`, `DUPLICATE_PAGE`, `SUSPECTED_MISSING_PAGE`, `UNVERIFIED_PAGE`, `IMAGE_ONLY_PAGE`) with explicit caveat when original book page count is unknown.

### Frontend Modules
- `frontend/components/admin/admin-ocr-review-screen.tsx` — Durable workflow status, explicit Text Safety vs Image Safety separation, Admin manual image safety confirmation bound to current image revision, rights status link/gate visibility, Vietnamese localization fix.
- `frontend/components/admin/admin-book-ai-batch-review.tsx` — Never calls `AI_AUTO_VERIFIED`; queues durable workflows / saves drafts for explicit Admin review.
- `frontend/components/admin/admin-book-content-quality-screen.tsx` — Real Rights Evidence editor & version history, per-page diagnostic badges & problem filters, Parent Reports inbox with `CHILD_SAFETY_CONCERN` and `COPYRIGHT_CONCERN`, independent manual book approval (never auto-published).
- `frontend/components/books/book-content-report-dialog.tsx` & `frontend/components/books/parent-book-reports-screen.tsx` — Parent book/page reporting including `CHILD_SAFETY_CONCERN` and `COPYRIGHT_CONCERN`, strict Parent A/B isolation.

## 2. Milestones

| Milestone | Scope | Gate |
|---|---|---|
| M1 | Discovery, isolated worktree, working memory docs, baseline reproduction fixes (`uuid4` import) | Baseline tests cataloged, docs committed |
| M2 | AI OCR correction, Gemini HTTP status, Ollama JSON fallback, cloud timeout budget for Ollama, repeated-word validator fix, `book_quality_ollama.py` fix + REAL local Ollama fallback proof | Targeted + regression + real local Ollama PASS |
| M3 | Durable workflow lease/stale protection, Child Safety completeness & contradiction escalation, Text vs Image safety separation + Admin manual image safety review + Dutch UI fix | Targeted + worker recovery + UI tests PASS |
| M4 | Additive SQL migration, Rights Evidence persistence & history, strict server-side verification gate, disable `AI_AUTO_VERIFIED` & `auto_publish_if_eligible`, preserve legacy data | Direct API bypass attempts fail with machine-readable codes; legacy preserved |
| M5 | Book Quality per-page diagnostics & filters, Rights UI, Parent Reports `CHILD_SAFETY_CONCERN`/`COPYRIGHT_CONCERN`, anti-duplicate & Parent A/B isolation, Frontend component tests | `npm run verify` + backend tests PASS |
| M6 | Adversarial QA: Hypothesis property-based, Contract, Concurrency/Race, Security/RBAC/IDOR/Prompt-Injection, AI Robustness, Recovery, Controlled Mutation checks, Performance | 80+ meaningful test scenarios PASS |
| M7 | Full regression, real Playwright E2E (8 flows, desktop + mobile screenshots with synthetic data), 3-perspective final review (Architect/Security/QA), docs update, push branch + PR | All gates green, honest report, zero unverified claims |
