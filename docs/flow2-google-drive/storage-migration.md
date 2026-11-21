# ViRead Flow 2 — Storage Migration & Rollback Plan

**Migration SQL:** [`supabase/migrations/20261121210000_flow2_google_drive_storage.sql`](../../supabase/migrations/20261121210000_flow2_google_drive_storage.sql)
**Rollback SQL:** [`docs/flow2-google-drive/rollback-20261121210000.sql`](./rollback-20261121210000.sql)
**Production DDL Execution Status:** `BLOCKED` (per Rule I.3 — awaiting explicit Admin review and staging verification before applying to production).

---

## 1. Storage Ownership Boundary

| Data Category | Storage Target | Notes |
|---|---|---|
| Original uploaded book pages, covers, audio | **Supabase Storage (existing)** | Untouched. Essential for child reading & OCR production. |
| Flow 1 manual uploaded checkpoints (legacy/manual) | **Supabase Storage (existing)** | Untouched. Protected from Flow 2 cleanup; rollback preserved. |
| Flow 2 legacy samples/datasets/checkpoints already in DB | **Supabase Storage (read-only legacy)** | Automatically readable via `TrainingArtifactStoreRouter` (`storage_provider = 'supabase_legacy'`). No risky bulk copy required. |
| **New Flow 2 verified line crop PNGs & label JSONs** | **Google Drive (`verified-samples/<revision-id>/`)** | Written exclusively to private Drive folder. |
| **New Flow 2 immutable dataset manifests & JSONL splits** | **Google Drive (`datasets/<dataset-version>/`)** | Contains `manifest.json`, `train.jsonl`, `validation.jsonl`, `holdout.jsonl`. |
| **New Flow 2 Locked Test & Pilot Test manifests** | **Google Drive (`locked-tests/<version>/`)** | Immutable snapshots independent of training split. |
| **New Flow 2 candidate checkpoints & config YAML** | **Google Drive (`checkpoints/<run-id>/`)** | Sharded (`<= 40 MB`) with per-shard and whole-file SHA-256. |
| **Colab Free training resume snapshots** | **Google Drive (`resume/<job-id>/blobs/<sha256>`)** | Content-addressed blobs + atomic `state_manifest.json`. |
| **Detailed benchmark reports** | **Google Drive (`benchmarks/<run-id>/<benchmark-id>/`)** | Summary metrics remain in PostgreSQL `viread_ocr_benchmarks`. |
| Metadata, hashes, pointers, outbox, decisions, encrypted Drive token | **Supabase PostgreSQL** | Metadata-only; zero image/checkpoint binary blobs in DB. |

---

## 2. Additive Schema Changes (`20261121210000_flow2_google_drive_storage.sql`)

The migration is **100% additive and idempotent** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`):

1. **New table `public.viread_ocr_drive_connections`:**
   - Stores non-secret connection metadata (`account_email`, `root_folder_id`, `subfolder_ids`, `granted_scope`, `status`, quota counters, health/self-test timestamps) and **Fernet-encrypted** `refresh_token_ciphertext` + `refresh_token_fingerprint`.
   - RLS enabled + `REVOKE ALL ON public.viread_ocr_drive_connections FROM PUBLIC, anon, authenticated;` — only backend `service_role` / DB owner can access it.
2. **Additive columns across 7 existing Flow 2 tables** (all defaulting to `'supabase_legacy'` so existing production rows stay 100% valid with zero backfill downtime):
   - `viread_ocr_samples`: `storage_provider`, `drive_file_id`, `label_storage_path`, `label_drive_file_id`, `label_sha256`, `sync_status` + indexes.
   - `viread_ocr_dataset_versions`: `storage_provider`, `drive_file_id`, `drive_folder_id`, `split_manifests`.
   - `viread_ocr_training_runs`: `storage_provider`, `checkpoint_drive_file_id`, `resume_storage_path`.
   - `viread_ocr_checkpoint_chunks`: `storage_provider`, `drive_file_id`.
   - `viread_ocr_benchmarks`: `storage_provider`, `report_storage_path`, `report_drive_file_id`.
   - `viread_ocr_active_model`: `storage_provider`, `drive_file_id`.
   - `viread_ocr_model_decisions`: `candidate_storage_provider`, `previous_storage_provider`.
3. **Widened outbox status constraint (`viread_ocr_outbox_status_check`):**
   - Adds `'SKIPPED'` (for `AI_AUTO_VERIFIED` / `PARENT_PRIVATE`) and `'BLOCKED'` (for duplicate image hash label conflicts) alongside `'PENDING'`, `'PROCESSING'`, `'RETRY'`, `'DONE'`, `'DEAD'`.
4. **Pre-migration runtime safety:**
   - All backend optional additive-column `UPDATE` statements run inside PostgreSQL `SAVEPOINT` (`async with self.db.begin_nested():`) via `_exec_optional_column_update()`, so deploying backend code before running DDL never aborts an open transaction.

---

## 3. Cutover Procedure (Staging First, Then Production With Admin Approval)

1. **Pre-flight backup:** Take a Supabase database snapshot / logical dump of `public.viread_ocr_*` tables.
2. **Apply migration on Staging:** Execute `supabase/migrations/20261121210000_flow2_google_drive_storage.sql`.
3. **Configure Backend Environment Variables (0 VNĐ):**
   - `VIREAD_FLOW2_STORAGE_PROVIDER=google_drive`
   - `VIREAD_GDRIVE_OAUTH_CLIENT_ID`, `VIREAD_GDRIVE_OAUTH_CLIENT_SECRET`
   - `VIREAD_GDRIVE_OAUTH_REDIRECT_URI` (and optional `VIREAD_GDRIVE_OAUTH_ALLOWED_REDIRECT_URIS`)
   - `VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY` (>= 32-char random secret)
   - `VIREAD_ARTIFACT_STREAM_SIGNING_SECRET` (dedicated >= 32-char random secret, separate from worker bearer token)
4. **Connect & Verify in Admin UI (`/admin/viread-training`):**
   - Click **Kết nối Google Drive** -> complete OAuth consent (`drive.file` only).
   - Click **Kiểm tra kết nối** (Health Check) and **Chạy Self-Test** (upload -> private check -> download SHA-256 -> cleanup).
5. **Verify Legacy Read Compatibility:** Confirm existing active model and prior runs/samples still read cleanly with zero regressions.
6. **Verify New Flow 2 Write Path:** Explicitly Admin-verify one test book page -> confirm outbox marks `DONE`, line PNG + label JSON appear under `MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified/verified-samples/<revision-id>/`, and Supabase Storage bucket size does **not** increase.

---

## 4. Safe Rollback Procedure

1. **Runtime Model Rollback (Zero Downtime, No DDL Needed):**
   - In `/admin/viread-training`, roll back `viread_ocr_active_model` to `ORIGINAL` or a previous Supabase-legacy checkpoint.
   - Optionally set `VIREAD_FLOW2_STORAGE_PROVIDER=supabase_legacy` if pausing Drive writes while keeping existing Drive artifacts readable.
2. **Database Schema Rollback (Guarded):**
   - [`docs/flow2-google-drive/rollback-20261121210000.sql`](./rollback-20261121210000.sql) contains an automated `DO $$ ... RAISE EXCEPTION $$` safety guard at the top.
   - It **automatically refuses to drop columns or tables** if ANY row in `viread_ocr_active_model`, `viread_ocr_training_runs`, `viread_ocr_dataset_versions`, or `viread_ocr_samples` still references `'google_drive'` or `'gdrive://%'`.
   - Only after all Drive references are retired/migrated can the rollback SQL remove additive columns and `viread_ocr_drive_connections`.
