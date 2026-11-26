# 09. Functional & PostgreSQL 16 Integration Regression Results

**Branch:** `feat/viread-rc-zero-cost-20261125` (atop `d5eee4dc907d81b737b53da08c916b1b4ba095d3`)  
**Interpreters & Runtimes:**  
- Backend PG/Web tests: `F:\c1\capstone1\.venv\Scripts\python.exe` (`Python 3.12.10`, `pytest 9.2.0`)  
- OCR/Rasterizer tests: `%LOCALAPPDATA%\Programs\Python\Python312\python.exe` (`Python 3.12.10`) & WSL2 `/home/cuong/ocr_worker_wsl_venv/bin/python`  
- PostgreSQL: Disposable `PG 16.4` (`127.0.0.1:55432`, `55447`, `55439`)

## 1. Live PostgreSQL 16 Integration Suites (Executed on Isolated PG16 Clusters)

| Suite / Module | DB Target / Port | Passed | Failed | Skipped | Duration | Notes / Findings |
|---|---|---:|---:|---:|---:|---|
| Core PG + Flow 2 + OCR Jobs (`9` modules: `test_book_content_quality_persistence.py`, `test_parent_private_book_access.py`, `test_reading_comparison_postgres_integration.py`, `test_reading_presence_postgres_integration.py`, `test_ocr_inference_jobs.py`, `test_admin_book_delete.py`, `test_flow2_admin_verified_pipeline.py`, `test_viread_ocr_outbox_worker.py`, `test_viread_training_worker_claim.py`) | `127.0.0.1:55432` | **79** (`+2` subtests) | `0` | **0** | `269.46s` | Clean 0-skip run |
| Phase 7 Reading Concurrency (`test_phase7_postgres.py`) | `127.0.0.1:55439` (`viread_phase7_test`) | **8** | `0` | **0** | `121.85s` | Isolated UUID schema, `1–20` concurrent sessions |
| Karaoke Schema, Pipeline, Service & Worker (`5` modules: `test_karaoke_postgres_integration.py`, `test_karaoke_processing_pipeline_postgres.py`, `test_karaoke_processing_postgres_integration.py`, `test_karaoke_processing_service_postgres.py`, `test_karaoke_processing_worker.py`) | `127.0.0.1:55447` (`karaoke_phase2_test`) | **42** (`+3` subtests) | `0` | **0** | `117.37s` | Clean dedicated PG16 cluster (`task-962`) |
| Parent Private Book Moderation & Submission (`test_audit_private_book_and_moderation_regressions.py`, `test_parent_book_submission.py`, incl. live local Ollama test) | `127.0.0.1:55432` | **10** | `0` | **0** | `177.97s` | Caught & verified `sub.SourceStoragePath` fix (`task-975`, isolated `APP_ENVIRONMENT=test`) |
| Parent Private Book Access + Audit Waves 2 & 3 (`test_parent_private_book_access.py`, `test_audit_wave2_ocr_workers_health_ai.py`, `test_audit_wave3_rbac_reading_games_presence.py`) | `127.0.0.1:55432` | **16** | `0` | **0** | `91.62s` | `APP_ENVIRONMENT=test` (`task-992`) |
| Admin OCR PG Integration (`test_admin_ocr_postgres_integration.py`) on `viread_rc_migrations` (`APP_ENVIRONMENT=test`) | `127.0.0.1:55432` | **4** | **1** | **0** | `31.50s` | **`test_api_supports_two_edit_cycles_and_history_remains_immutable` FAIL:** `asyncSetUp` line 73 inserts `public.pagerevisions (id, pageid)` omitting `NOT NULL revisionno` |

**Total Isolated PG16 Suites Executed:** `159 passed (+5 subtests)`, **`0` DB skips**, `1` test-fixture SQL schema mismatch remaining (`test_admin_ocr_postgres_integration.py:73`).

## 2. Genuine Defects Exposed & Status

1. **FIXED (`20261105072703_add_profile_avatar_storage.sql`):** Unescaped `'parent's'` SQL quote broke clean PG16 cluster migration (`#10` -> fixed `#11`, verified all `40/40` migrations applied).
2. **FIXED (`ocr_worker/Dockerfile`):** `imgaug==0.4.0` transitively pulled `opencv-python==4.11.0.86` alongside `opencv-python-headless==4.10.0.84` (`#10` -> fixed `#11`, verified sole `cv2` owner in WSL2).
3. **FIXED (`backend/app/services/parent_private_book_service.py:392, 2732`):** Proxyless URL update called `sub.ImagePath` on `ParentBookPageSubmission` instead of `sub.SourceStoragePath`, crashing `test_aud001`–`003` and `test_parent_book_submission.py` (`#30` -> fixed `#33`, verified `10/10` pass in `task-975`).
4. **OPEN TEST/SECURITY FINDING (`backend/app/database/role_cache.py` & `test_admin_ocr_postgres_integration.py`):**
   - `test_admin_ocr_postgres_integration.py` does not set `APP_ENVIRONMENT="test"` before importing `app.database.config`, activating `role_cache.py`'s `60s` TTL (`_ROLE_TTL_SECONDS = 60.0`) when run standalone or before other test modules. When active, deactivating a user in DB (`UPDATE profiles SET active = 0`) leaves cached `active = 1` stale for up to `60s` — causing `test_inactive_admin_is_denied_before_ocr_draft_write` to **allow an inactive admin to write a draft**, causing `test_direct_postgres_rls_and_storage_objects_isolation` to return `409` instead of `403`, and polluting `PARENT_A` (`1111...`) across test modules (`403 Access denied`).
   - `test_admin_ocr_postgres_integration.py:73` still inserts `(id, pageid)` without `revisionno` into `public.pagerevisions`, failing `NotNullViolationError` against a full migrated PG16 DB (`viread_rc_migrations`) and failing `UndefinedTableError` on an empty/stub DB missing `public.viread_ocr_outbox`.
5. **SQL Hardening Check (`supabase/tests/*.sql` on `viread_rc_migrations`):** Both `reading_query_indexes_disposable.sql` and `security_hardening_disposable.sql` exited `1` explicitly refusing the DB name `viread_rc_migrations` (`Refusing database other than viread_perf_ci` / `Refusing non-disposable database`).

## 3. Rasterizer, OCR Worker & Cross-Team Final Verification

- **`test_document_rasterizer_and_upload.py` (Python 3.12, post-TIFF fix):** **`Ran 14 tests in 176.184s — OK`**, exit `0` (verified by `ai-bench-pg-sre` on PNG baseline; re-verified `Ran 14 tests in 611.627s OK` by `@rc-backend-worker` `#34` after JPEG `q=85` default switch).
- **WSL2 `ocr_worker` (`task-1006`):** `unittest discover -s ocr_worker -p "test_*.py" -v` -> **`Ran 5 tests in 34.945s — OK`**, exit `0`.
- **Reported Cross-Team Final Gates (see `#14`, `#31`, `#34` — not re-executed by `ai-bench-pg-sre`):** Backend `.venv` suite (`929 tests, skipped=6`), OpenAPI duplicate check (`235` paths, `0` warnings), Frontend (`typecheck` `0`, `lint` `0`, `next build` `39/39`, `vitest` `2614 passed | 1 skipped`), Android (`18` script tests `OK`, Gradle debug build/unit/lint `BUILD SUCCESSFUL`).
