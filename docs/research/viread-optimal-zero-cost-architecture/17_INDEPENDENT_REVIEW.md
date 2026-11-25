# 17 — Independent Technical Audit & Diff Verification (`d5eee4dc..HEAD`)

> **Auditor:** `@independent-red-team` (VERIFIER ONLY — zero edits to application source files)  
> **Audit Date:** `2026-11-25`  
> **Target Worktree:** `F:\c1\capstone1-rc-zero-cost` (`feat/viread-rc-zero-cost-20261125`)  
> **Diff Audited:** `git diff d5eee4dc..HEAD` + untracked RC files + `docs/research/viread-optimal-zero-cost-architecture/**`

---

## 1. Core Architectural Invariants Verification

| Invariant | Verification Method | Result | Evidence |
|---|---|---|---|
| **ABI Pins in `backend/requirements.txt` Unchanged** | `git diff d5eee4dc -- backend/requirements.txt ocr_worker/requirements.txt` | **PASS (0 diff lines)** | `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13` preserved verbatim. |
| **`backend/app/sever.py` Filename Preserved** | `git status` & `git diff --stat d5eee4dc` | **PASS** | `backend/app/sever.py` modified in-place (`+48/-x` lines); not renamed to `server.py`. |
| **Zero Duplicate OpenAPI Operation IDs** | `python -W "error:Duplicate Operation ID:UserWarning" -c "from app.sever import app; app.openapi()"` | **PASS (`235` paths, `0` warnings)** | Duplicate `POST /books/admin/catalog` removed from `admin_ocr.py` (`book.py` remains owner). |
| **Secrets Regex Scan Across Code & Research Docs** | Python `re.findall` across `git diff d5eee4dc`, untracked code, and `docs/research/**` | **PASS (`0` hits)** | `0` matches for `sk-`, `AIza`, `eyJhbGciOi`, `sb_secret_`, `gsk_`, PEM keys, or `<user-home>\.env`. |
| **Strict Boundary Compliance** | `git diff --stat d5eee4dc` | **PASS** | All edits confined to `F:\c1\capstone1-rc-zero-cost`; `capstone1` & `capstone1-staging-release` untouched. |

---

## 2. Independent Re-Verification Command Ledger (Executed Directly by Auditor)

| Verification Command | Interpreter / Env | Observed Outcome | Notes |
|---|---|---|---|
| `python -W "error:Duplicate Operation ID:UserWarning" -c "from app.sever import app; schema = app.openapi()"` | `F:\c1\capstone1\.venv\Scripts\python.exe` | **Exit `0` (`OPENAPI_OK paths= 235`)** | Re-verified directly; 0 duplicate warnings. |
| `python -m unittest test_web_lightweight_startup -v` | `.venv` (`APP_ENVIRONMENT=test`) | **Exit `0` (`Ran 5 tests in 16.732s — OK`)** | Note: initial run under parallel swarm build/ML load hit transient `MemoryError` & `30s` subprocess timeout when Windows `FreeVirtualMemory` dropped to `561 MiB` (`FreePhysicalMemory: 541 MiB`); re-run once memory cleared passed `5/5`. |
| `python -m unittest test_document_rasterizer_and_upload.DocumentRasterizerTests test_rc_security_cron_and_voice test_admin_ocr_contracts test_ocr_inference_jobs -v` | `.venv` (`APP_ENVIRONMENT=test`) | **Exit `0` (`Ran 38 tests in 21.080s — OK`)** | Verified `429` rate limits, `12 MB` `413`, `Active==1`, `internal_cron`, `sub.SourceStoragePath`, `BOOK_SOFT_DELETED` `409`, proxyless signed URLs, and JPEG `q=85` rasterizer contracts. |
| `python -m unittest test_voice_local_and_google_fallback -v` | `.venv` (`DATABASE_URL=127.0.0.1:1`, `AUTOSTART=false`) | **Exit `0` (`Ran 10 tests in 0.253s — OK`)** | Verified local-first voice orchestrator pooling & fallback boundaries. *(Note: running `test_parent_private_book_access` with `127.0.0.1:5432` failed `InvalidPasswordError` for `user "test"` because local PG port `5432` isn't configured with `test/test`; live PG16 suites verified on isolated `55432` in `09`.)* |
| `python -m unittest test_ocr_engine test_ocr_adjudication -v` + `python -m unittest ocr_worker.test_ocr_worker -v` | `%LOCALAPPDATA%\Programs\Python\Python312\python.exe` | **Exit `0` (`60` OCR tests `OK (skipped=5)`, `5` worker tests in `34.517s OK`)** | Initial run hit `cv::OutOfMemoryError` (`OpenCV 4.6.0` host pkg) during `561 MiB` free commit; re-run passed `60/60` + `5/5` real 3-engine smoke & zero-DB shim! |
| `python -m unittest discover -s android/scripts -p "test_*.py" -v` | `.venv` | **Exit `0` (`Ran 18 tests in 0.191s — OK`)** | Verified Android origin validation & APK quality checks. |
| `npm run typecheck` + `npx vitest run tests/config/security-headers.test.ts tests/auth/oauth-callback.test.ts tests/reading/benchmark/highlight-latency.test.ts` | `frontend/` (`Node` / `Vitest 5.0.0`) | **Exit `0` (`tsc` OK; `3` files, `11/11` passed in `6.46s`)** | Verified CSP/security headers, OAuth origin allowlist (`9/9`), and highlight latency (`p50=12.28ms`, `p95=23.45ms <= 50ms`, `maxRendersPerStep=2`). |
| Raw Benchmark JSON/CSV Cross-Check | `benchmarks/*.json`, `summary_metrics.csv`, `14_COST_SIMULATION.csv` | **Verified Consistent** | All headline figures in `04, 05, 08, 10, 11, 13, 14` match raw JSON fields (`exp_a`, `exp_c`, `exp_d`, `pg16`), with one minor logging quirk (`pg_dump_bytes: 0` recorded returncode instead of byte count in `pg16_contention_and_drills.json`). |

*Note on cross-team full suites (`#14`, `#31`, `#34`, `#36`):* Full 929-test `.venv` sweep, full 14-test `test_document_rasterizer_and_upload.py` (`176.18s` & `611.63s`), full 2,614-test Vitest + `next build`, Gradle debug/lint, WSL2 `ocr_worker` `5/5`, and isolated PG16 `159` tests (`0` DB skips) were executed and reported by `@rc-backend-worker`, `@rc-frontend-android`, and `@ai-bench-pg-sre`; auditor directly re-verified representative core suites, raw JSON artifacts, and all source diffs listed above.

---

## 3. `BACKEND_FLOW_STANDARD.md` Layer & Code Quality Audit

1. **Compliant RC Additions:**
   - `/books/my-books/paged` (`parent_private_book.py` -> `ParentPrivateBookService.list_books_paged` -> `ParentPrivateBookRepository.list_owned_private_books_paged` -> `ParentPrivateBookPageRead`): clean strict 6-layer flow.
   - `AdminBookRepository.soft_delete` + `OcrInferenceJobService` (`_is_book_deleted`, `_is_target_still_current`, `complete_job`) + `find_completed_cached_job`: clean repository/service separation with strict `OwnerUserId` tenant isolation.
   - `parent_book_submission_worker.py` (`only_post_ocr=True` Stage 2/3 sweeper): cleanly reuses `ParentPrivateBookRepository.claim_next_checking_submission` (`FOR UPDATE SKIP LOCKED`) and `run_parent_submission_post_ocr` with zero `torch`/`paddle` imports.
2. **Documented Layer Deviations (Pre-Existing Patterns Preserved in RC):**
   - `backend/app/api/routes/reading.py:692, 816` (`/books/{book_id}/match-page` & `/match-page`) still executes SQLAlchemy `select(BookPage, Book)` directly inside the router rather than delegating to `ReadingContentRepository` (though RC fixed the broken `CatalogRepository.is_private_book` attribute bug and added `12 MB` chunked reads + candidate limits).
   - `backend/app/services/runtime_diagnostics.py:253` (`collect_worker_queue_metrics`) executes raw SQL `text(...)` inside a service helper called by `AdminSystemRepository.worker_queue_metrics()` (acceptable read-only aggregate diagnostic across 10 tables, though technically SQL-in-service).

---

## 4. Defects Caught During Swarm Audit & Remaining Open Items

- **Caught & Fixed During Swarm:**
  1. `supabase/migrations/20261105072703_add_profile_avatar_storage.sql:9` unescaped `'parent's'` quote -> fixed to `'parent''s'`, enabling clean `40/40` PG16 migration apply.
  2. `ocr_worker/Dockerfile` transitive `imgaug` -> `opencv-python` collision & missing `ocr_text_utils.py` / CPU torch index -> fixed and verified in WSL2 (`opencv-python-headless==4.10.0.84` sole `cv2` owner).
  3. `parent_private_book_service.py:392, 2732` `sub.ImagePath` `AttributeError` -> fixed to `sub.SourceStoragePath`, verified `10/10` on live PG16.
  4. `ocr_engine.py` / `ocr_adjudication.py` TIFF `<pad>` leakage -> fixed via `_sanitize_vietocr_prediction` + `adjudication_token`, verified `14/14` in `test_document_rasterizer_and_upload.py`.
- **Remaining Open Findings for Cutover / Post-RC:**
  1. **`role_cache.py` 60-Second Deactivation Lag:** `require_active_profile_id` and `get_cached_profile_role` cache `Active == 1` for `60s` without automatic invalidation on admin deactivation; also broke `test_admin_ocr_postgres_integration.py` when `APP_ENVIRONMENT` wasn't forced to `"test"` before import.
  2. **`test_admin_ocr_postgres_integration.py:73` Migrated-DB Failure (`4/5` pass):** `asyncSetUp` inserts `public.pagerevisions (id, pageid)` omitting `NOT NULL revisionno`, causing `test_api_supports_two_edit_cycles_and_history_remains_immutable` to fail against full migrated PG16 schemas (`09_FUNCTIONAL_REGRESSION_RESULTS.md:18`).
  3. **Public Catalog Still Uses `?token=` Signed URLs:** `book_service.py:192,468` & `reading_content_service.py:1257` still emit fresh `?token=` signed URLs for catalog books, meaning Option 5's `Supa Cached` (`5 GB/mo`) savings require a future public/CDN URL refactor.
  4. **`hybrid_int8_word_fp32` Memory Penalty:** Uses **`1,901.30 MB` RSS** (`+454.31 MB` more than standalone `fp32` `1,446.99 MB`) — disable on `<=8–16 GB` hosts sharing OCR + Ollama.
  5. **`infra/cloudflare-cron` Timeout & Render 750h Math:** `wrangler.toml` `*/5` cron keeps Render awake `24/7` (`720–744h / 750h` workspace cap, leaving minimal headroom for any second service) and uses a `25,000 ms` fetch abort (`src/index.js:17`) that is shorter than a `50–60s` Render Free cold start if Render ever sleeps.
