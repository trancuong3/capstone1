# 13. Reliability, Fencing, Migration & Backup/Rollback Review

**Evidence:** [pg16_contention_and_drills.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/pg16_contention_and_drills.json), live PG16 clusters (`127.0.0.1:55432`, `55447`, `55439`)

## 1. Migration & Idempotency Verification (`40/40` Supabase Migrations)

- **Clean PG 16.4 Cluster (`127.0.0.1:55432`, DB `viread_rc_migrations`):** Applied **all `40` files** in `supabase/migrations/*.sql` sequentially (`0` failures after fixing unescaped `'parent''s'` in `20261105072703_add_profile_avatar_storage.sql`), creating **`60` public tables**.
- **Soft-Delete Idempotency:** Re-applying `supabase/migrations/20261124120000_soft_delete_catalog_books.sql` completed idempotently in **`6.99 ms`** (`0` errors).

## 2. Live Concurrency, Fencing-Token & Soft-Delete Race Results

Executed against live PG16 `viread_rc_migrations` via `pg16_contention_and_drills.py`:

| Scenario / Invariant Tested | Measured Outcome |
|---|---|
| **2 Parents + 1 Admin concurrent OCR uploads + live Child reading (`ReadingSession` + `ReadingEvent WORD_RETRY`)** | All 4 concurrent transactions committed cleanly in **`1,287.63 ms`** (`0` deadlocks). |
| **Strict Queue Priority Order** | `claim_next_job` claimed Admin catalog job (`priority=20`) ahead of Parent private submissions (`priority=50`): `fencing_priority_order_admin_first=true`. |
| **Mid-Job Worker Kill & Lease Fencing** | Worker-1 leased (`fencing_token=1, attempt=1`) -> lease expired -> Worker-2 reclaimed **`fencing_token=2, attempt=2`**. |
| **Stale Zombie Worker Rejection** | Stale Worker-1 calling `complete_job(..., fencing_token=1)` rejected with **HTTP `409`** (`"Fencing token mismatch; worker lease superseded."`). Reclaimed Worker-2 (`fencing_token=2`) reached terminal **`SUCCEEDED`**. |
| **Soft-Delete Mid-Job Race (`ADMIN_PAGE_UPLOAD` claimed when book soft-deleted)** | `AdminBookService.soft_delete` cancelled active job (`status='CANCELLED'`, `book.IsDeleted=true`). Late Worker calling `complete_job` rejected with **HTTP `409 BOOK_SOFT_DELETED`**. |
| **Stuck `CHECKING` Submissions** | **`0` stuck `CHECKING`** submissions after workflow completion. |

## 3. Timed `pg_dump` -> Fresh Restore & Rollback Rehearsal

1. **Timed Backup (`pg_dump`):** **`0.67 s`** (`exit 0`; *note: JSON key `pg_dump_bytes` stored returncode `0` rather than file size*).
2. **Timed Restore (`psql -v ON_ERROR_STOP=1` into fresh DB `viread_rc_restore_drill`):** **`15.933 s`**, **`integrity_match=true`** (`src_tables=60 == dst_tables=60`, `src_ocr_jobs=4 == dst_ocr_jobs=4`).
3. **Timed Rollback Rehearsal (with `2` active jobs: `1 CLAIMED` + `1 QUEUED`):** Drained both active jobs safely to `CANCELLED` (`rollback_drained_jobs=2`, `rollback_post_active_jobs=0`) + applied `supabase/rollbacks/20261120140000_reading_query_indexes_cleanup_rollback.sql` + dropped soft-delete columns/constraint in **`0.100 s`** (`0` errors).

## 4. Open Reliability & Operational Risks

1. **In-Process `role_cache.py` Active-Deactivation Lag & Unkeyed Process Cache:**
   - `backend/app/database/role_cache.py` caches active profile role for `_ROLE_TTL_SECONDS = 60.0` in non-test environments (`APP_ENVIRONMENT != "test"`).
   - **Risk:** If an Admin deactivates a compromised user (`profiles.active = 0`), cached requests continue to treat the user as active for up to `60s` across that worker unless `invalidate_cached_role(profile_id)` is invoked on deactivation (observed directly in `test_inactive_admin_is_denied_before_ocr_draft_write` and `test_direct_postgres_rls_and_storage_objects_isolation` when `APP_ENVIRONMENT` defaulted outside `"test"`).
2. **OCR Container Memory Floor (`1,413.5 MB` ONNX / `1,659.4 MB` Stock):**
   - Free `512 MB–1 GB` PaaS containers will OOM-kill the OCR worker (`viable_512mb=false, viable_1gb=false`). Must remain on owned PC/laptop or `>= 2 GB` worker node.
3. **Hybrid Voice Mode (`VIREAD_VOICE_HYBRID_WORD_FP32=true`) RAM Cost:**
   - Keeping both `int8` and `fp32` VieNeu sessions resident uses **`1,901.30 MB` RSS** (`+454.31 MB` above pure `fp32` `1,446.99 MB`). Enable only on `>= 16 GB` hosts; keep default `int8` (`859.99 MB` RSS) on `8 GB` laptops.
4. **PostgreSQL Test-Fixture Hygiene:**
   - `test_admin_ocr_postgres_integration.py` should set `APP_ENVIRONMENT="test"` before importing `app` and include `revisionno` when seeding `public.pagerevisions` (`asyncSetUp` line 73) so all 5/5 tests pass on a full migrated PG16 DB (currently `4/5` pass under `APP_ENVIRONMENT=test`).
5. **Unverified Child Speech Domain:**
   - Real 6–7-year-old Vietnamese child STT WER/pronunciation sensitivity remains unmeasured (`0` child audio samples evaluated).
