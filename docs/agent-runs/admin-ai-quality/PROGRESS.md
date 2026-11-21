# Execution Progress & Checkpoints

## Checkpoint — M5 Book Quality UI, Rights Panel & Parent Reports Complete (2026-11-21)

- **Done:**
  - Hardened `get_parent_report` (`include_internal_findings=False`) so internal Admin scan findings never leak to Parents.
  - Added `CHILD_SAFETY_CONCERN` and `COPYRIGHT_CONCERN` across Zod schemas, `BookContentReportDialog`, `ParentBookReportsScreen`, and `AdminBookContentQualityScreen`.
  - Built Rights Evidence review & history panel in `AdminBookContentQualityScreen` (no hardcoded `rights_confirmed: false`, no "không vi phạm bản quyền" claim; locks Approve until `RIGHTS_REVIEWED`).
  - Built Per-Page Quality Diagnostics panel with filter chips (`Tất cả`, `Trang có vấn đề`, `Chưa xác minh`, `Lỗi ảnh / OCR`) and unknown physical page count disclaimer.
  - Added expandable Admin resolution response view in `ParentBookReportsScreen` via `getMine`.
  - Verified Frontend `vitest` (M5 suite 4/4 PASS), `tsc --noEmit` (0 errors), `eslint .` (0 errors), `prettier` clean.
- **In Progress:** M6 Adversarial QA (Hypothesis property-based tests, Contract parity, Concurrency/Race, RBAC/IDOR/Prompt-Injection, Recovery, Controlled Mutation Checks, Performance/Memory).
- **Bugs Closed:** BUG-04, BUG-08 (ALL 10 discovered bugs BUG-01..BUG-10 now FIXED).

## Checkpoint — M4 Rights Evidence & Strict Verification Gate Complete (2026-11-21)

- **Done:**
  - Created strictly additive PostgreSQL migration `supabase/migrations/20261121120000_book_rights_and_verification_gate.sql` (image safety columns on `adminaiworkflows`, `bookrightsevidences`, `bookrightsevidencehistory` with service_role RLS, expanded `bookcontentreports` CHECK constraint with `CHILD_SAFETY_CONCERN` and `COPYRIGHT_CONCERN`).
  - Implemented full Rights Evidence layer (`BookRightsEvidence`, `BookRightsEvidenceHistory`, repository, `get_book_rights`/`upsert_book_rights`, routes `GET/PUT /books/admin/quality/books/{book_id}/rights`) with required-field enforcement, immutable versioned history, content-fingerprint staleness detection, and RBAC.
  - Hardened server-side `AdminOcrService.verify`: disabled `AI_AUTO_VERIFIED` (`409 AI_AUTO_VERIFY_DISABLED`), required `workflow_id` (`409 WORKFLOW_REQUIRED`), enforced `source_image_sha256` binding, candidate hash, chunk completeness, text safety, Admin manual image safety on current SHA, and persisted `RIGHTS_REVIEWED` evidence version; removed automatic `auto_publish_if_eligible`.
  - Updated `save_draft` to invalidate stale workflow safety inside the same transaction.
  - Disabled `auto_publish_if_eligible` across worker/verify/quality while preserving legacy v2 `AUTO_APPROVAL` published books without mass re-approval.
  - Removed all `AI_AUTO_VERIFIED` auto-verification bypasses from `frontend/components/admin/admin-book-ai-batch-review.tsx`.
  - Added per-page quality diagnostics (`MISSING_IMAGE`, `EMPTY_OCR`, `OCR_ERROR`, `DUPLICATE_PAGE`, `SUSPECTED_MISSING_PAGE`, `UNVERIFIED_PAGE`, `IMAGE_ONLY_PAGE`) with explicit unknown-physical-page-count disclaimer.
  - Verified **186/186** backend tests across 13 modules PASS (3.90s).
- **In Progress:** Starting M5 (Book Quality UI, Rights Evidence Panel, Parent Reports `CHILD_SAFETY_CONCERN`/`COPYRIGHT_CONCERN` & Isolation, Frontend Component Tests).
- **Bugs Closed:** BUG-01, BUG-02, BUG-03, BUG-04 (backend).

## Checkpoint — M3 Workflow Persistence & Child Safety Complete (2026-11-21)

- **Done:**
  - Hardened `child_safety.py`: explicit JSON schema/enum contract for Groq & Ollama fallback, shared `disabled_families` across chunks, contradiction/prompt-injection escalation (`HIGH->NOT_RECOMMENDED`, `MEDIUM->REVIEW_REQUIRED`, `LOW->SUITABLE_WITH_GUIDANCE`), explicit chunk completeness proof (`chunks_total`, `chunks_completed`, `all_chunks_completed`), explicit separation of `text_safety_status` vs `image_safety_status = UNASSESSED_NO_VISION_MODEL`.
  - Hardened `admin_ai_workflow_worker.py`: eliminated `KeyError: 'book_id'` & disabled automatic book publication (`_try_auto_publish` no longer auto-publishes), persisted chunk completeness & `image_safety_status` into `SafetyMetadata`.
  - Added Admin manual Image Safety review bound to `source_image_sha256`: model fields, schemas, `AdminAiWorkflowService.decide_image_safety`, route `POST /books/admin/pages/{page_id}/ai-workflows/{workflow_id}/image-safety-decision`, and Frontend UI panel in `admin-ocr-review-screen.tsx`.
  - Fixed Dutch text at `admin-ocr-review-screen.tsx:1820` -> clean Vietnamese.
  - Verified **36/36** backend M3 tests + **28/28** frontend OCR review tests PASS.
- **In Progress:** Starting M4 (Additive SQL Migration, Rights Evidence Persistence & History, Strict Server-Side Verification Gate, Eliminating `AI_AUTO_VERIFIED` & `auto_publish_if_eligible`).
- **Bugs Closed:** BUG-05, BUG-07, BUG-09.

## Checkpoint — M2 AI Correction & Ollama Hardening Complete (2026-11-21)

- **Done:**
  - Fixed Gemini HTTP error reporting (`upstream_status_code` preserved on all non-200 responses).
  - Added Ollama 400/422 JSON-mode fallback retry with explicit schema contract (`ollama_provider.py` & `book_quality_ollama.py`).
  - Added cloud timeout budget reservation in `OcrCorrectionOrchestrator` so slow/hung cloud providers cannot starve local Ollama fallback.
  - Fixed Vietnamese repeated-word diacritic/d-đ validation in `validators.py` while keeping cross-word reorder and exact token-swap detection strict.
  - Fixed multi-chunk `chunk_prompt` & `admin_ocr_local._prompt` to emit 0-based chunk-local indices matching `response_json_schema` and `validators.py`.
  - Fixed `book_quality_ollama.py` double-escaped `\\n`/`\\t`, added `"think": False`, `trust_env=False`, `follow_redirects=False`, and JSON-mode fallback.
  - Verified **58/58** mocked unit tests (`test_admin_ocr_multimodel`, `test_admin_ocr_local_provider`, `test_book_content_quality`) AND **2/2** real local Ollama fallback tests (`test_admin_ai_real_ollama_live`, 28.57s warm against `http://127.0.0.1:11434`, zero paid cloud calls).
- **In Progress:** Starting M3 (Workflow Persistence, Child Safety Completeness, Text vs Image Separation).
- **Next:** Write M3 failing TDD tests, implement Child Safety + Worker + Manual Image Safety review + Dutch UI fix, run targeted & regression tests, commit M3.
- **Bugs Closed:** BUG-06, BUG-10.
- **Self-Critique (Vòng D):** Checked repeated 400 fallback failure, single-token uncertain chunk, `\r\n` boundaries, multi-chunk cloud budget depletion, and NFD/Đ accent folding.

## Checkpoint — M1 Discovery & Isolation Setup (2026-11-21)

- **Done:**
  - Read `GEMINI.md`, `AGENTS.md`, `BACKEND_FLOW_STANDARD.md`, `backend/AGENTS.md`, `frontend/AGENTS.md`, skills, CI workflows, and all backend/frontend Admin OCR, AI Workflow, Child Safety, Book Quality, Approval Policy, and Parent Reports source & test files.
  - Created isolated worktree `F:\c1\capstone1-admin-ai-qa` on branch `feat/admin-ai-quality-qa-20261121` (from `aafa3966`) so `F:\c1\capstone1` remains completely untouched.
  - Installed `hypothesis 6.170.17` in `.venv` and verified locked ABI pins unchanged (`numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`).
  - Verified live local Ollama (`127.0.0.1:11434`, `qwen3-vl:4b-instruct-q4_K_M`, 100% CPU, 123.8s cold / 5–20s warm) works end-to-end for OCR correction, Child Safety, and Book Quality Ollama review using synthetic data.
  - Captured baseline test results:
    - Backend 13 targeted modules: 161 tests run -> 14 errors (`NameError: uuid4` in `test_admin_ocr_child_safety.py:431`; `KeyError: 'book_id'` in `admin_ai_workflow_worker.py:400`), 9 skipped (PostgreSQL integration tests awaiting `*_TEST_DATABASE_URL`).
    - Frontend admin OCR tests: 27 passed.
  - Initialized working memory docs under `docs/agent-runs/admin-ai-quality/`.
- **In Progress:**
  - Confirming `vitest` baseline inside isolated worktree (`task-601`).
  - Fixing baseline `uuid4` import in `test_admin_ocr_child_safety.py` and committing M1 docs + baseline.
- **Next:**
  - M2: Write failing tests for AI correction & Ollama bugs, fix them cleanly, run real local Ollama fallback test, self-critique, commit M2.
- **Bugs Found:** 9 confirmed bugs logged in `BUGS.md` (BUG-01..BUG-09).
- **Decisions Made:**
  - Use isolated worktree `F:\c1\capstone1-admin-ai-qa` because `F:\c1\capstone1` is checked out to `feat/parent-private-books-20261121`.
  - Never connect to production Supabase DB; keep all tests strictly isolated.
- **Risks & Unknowns:**
  - `qwen3-vl:4b-instruct-q4_K_M` runs at 100% CPU (~124s cold load on this laptop's 4 GB GTX 1650 Max-Q); tests using real Ollama must allow generous cold-start timeout (e.g. 180s) or warm model once per suite.
  - Local PostgreSQL server is not pre-installed on this Windows host; will evaluate portable local PostgreSQL setup or document exact PostgreSQL integration status honestly.
