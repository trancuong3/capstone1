# QA Report — ViRead Admin AI, Child Safety, Rights Evidence, Verification Gate & Quality

**Status:** IN PROGRESS (Milestone 1)  
**Branch:** `feat/admin-ai-quality-qa-20261121`  
**Base Commit:** `aafa3966`

## 1. Baseline Evidence (Before Fixes)

### Backend Baseline (`unittest` on 13 targeted Admin/OCR/Quality modules)
- Executed: 161 tests
- Result: **FAILED** (`errors=14, skipped=9`)
  - 13 errors in `test_admin_ocr_child_safety.py:431`: `NameError: name 'uuid4' is not defined`
  - 1 error in `test_admin_ai_workflow_parallel.py:325`: `KeyError: 'book_id'` at `admin_ai_workflow_worker.py:400`
  - 9 skipped: `test_book_content_quality_persistence.py` & `test_admin_ocr_postgres_integration.py` (requires isolated PostgreSQL test DB URL)

### Frontend Baseline (`vitest`)
- `tests/admin/admin-ocr-review-screen.test.tsx` + `tests/admin/ocr-review-service.test.ts`: **27 passed**

### Real Local Ollama Connectivity Probe (2026-11-21)
- Endpoint: `http://127.0.0.1:11434` (`ollama v0.40.16`)
- Model: `qwen3-vl:4b-instruct-q4_K_M` (3.6 GB, running 100% CPU on host GPU with 4 GB VRAM)
- Synthetic OCR correction probe: **OK** (`123.80s` cold load, valid structured JSON)
- Synthetic Child Safety probe (safe): **OK** (`20.43s`, `suitability=SUITABLE`, `output_mode=json_schema`)
- Synthetic Child Safety probe (unsafe): **OK** (`4.86s` warm, `suitability=REVIEW_REQUIRED`)
- Synthetic Book Quality Ollama probe: **OK** (`9.81s`, valid JSON)
- Cloud API keys: Present in local `backend/.env` (never logged; paid cloud calls NOT executed without explicit approval).

## 2. Milestone Verification Log
*(Updated at each milestone completion with exact commands and pass/fail/skip counts.)*
