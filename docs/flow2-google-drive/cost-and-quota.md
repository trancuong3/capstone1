# ViRead Flow 2 — Zero-Cost & Quota Engineering Report

**Additional Monthly / One-Time Cloud Cost:** **0 VNĐ**
**Google Cloud Billing Enabled:** **No (NOT required for Google Drive API v3 OAuth `drive.file` on personal Drive)**
**New Paid Subscriptions / Dependencies:** **None** (`backend/requirements.txt` has 0 diff; locked ABI pins untouched)

---

## 1. Service-by-Service Zero-Cost Inventory

| Component | Tier Used | Cost | Free-Tier Constraints & Engineering Guardrails |
|---|---|---|---|
| **Google Drive Storage** | Personal Google Drive (15 GiB shared quota) | **0 VNĐ** | Pre-upload quota guard enforces `VIREAD_GDRIVE_MIN_FREE_BYTES` (default 512 MiB buffer), warns at `>= 80%`, alerts critical at `>= 90%`, and strictly blocks uploads on `EXCEEDED` with retryable outbox backoff and **zero silent fallback to Supabase**. |
| **Google Drive API v3** | Free Google Cloud Project OAuth 2.0 (no billing) | **0 VNĐ** | Warm in-process `GoogleDriveTrainingStore` cache reuses access tokens + folder IDs across calls; `appProperties.sha256` deduplicates repeated uploads; warm-loaded VietOCR V2 predictor makes **0 Drive calls** during OCR scans. |
| **Supabase PostgreSQL** | Free Tier (500 MB DB) | **0 VNĐ** | Stores metadata pointers, SHA-256 digests, status, metrics, and one encrypted Drive refresh token only. Zero image or model blobs in PostgreSQL. Existing `ensure_database_capacity()` guard preserved. |
| **Supabase Storage** | Free Tier (1 GB Storage) | **0 VNĐ** | Reserved strictly for original book pages, reading assets, and pre-existing legacy checkpoints. Flow 2 writes **0 new training blobs** into Supabase Storage when `VIREAD_FLOW2_STORAGE_PROVIDER=google_drive`. |
| **Render Web Service** | Free Tier (512 MiB RAM) | **0 VNĐ** | Checkpoints (`~150 MB` sharded into `<= 40 MB` chunks) are streamed end-to-end: 256 KiB-aligned resumable uploads to Drive, streaming `Range` downloads (`iter_content`), `StreamingResponse` on `/artifact-stream`, and streaming shard assembly in `ocr_engine.py`. Never buffers full checkpoints in RAM. |
| **GPU Training Worker** | Google Colab Free (T4 15 GiB VRAM, interactive) | **0 VNĐ** | Explicitly modeled as interactive, time-bounded sessions (never assumes 24/7 uptime). Crash-safe content-addressed Drive resume (`blobs/<sha256>` + atomic `state_manifest.json`) lets Admin resume cleanly across Colab disconnects. Local GPU (`GTX 1650 4096 MiB < 6144 MiB`) is safely rejected (`INSUFFICIENT_VRAM`). |
| **Python & JS Dependencies** | Existing packages only | **0 VNĐ** | Uses existing `requests==2.32.5` and `cryptography==46.0.3` for Google Drive API v3 + Fernet/PKCE. No `google-api-python-client` or paid SDKs added. |

---

## 2. Estimated Storage Footprint on 15 GiB Personal Google Drive

| Artifact Type | Typical Size per Unit | Estimated Usage (10,000 Verified Lines + 10 Runs) |
|---|---|---|
| Verified line crop PNG (`verified-samples/<rev>/line-XXXX.png`) | ~15–35 KiB | ~250 MiB |
| Label provenance JSON (`verified-samples/<rev>/line-XXXX.json`) | ~0.5–1.0 KiB | ~8 MiB |
| Immutable dataset manifest + `train/validation/holdout.jsonl` | ~2–5 MiB / snapshot | ~50 MiB (10 versions) |
| Locked Test / Pilot Test manifest | ~0.2–1 MiB | ~5 MiB |
| Candidate VietOCR checkpoint (`vgg_transformer` shards + manifest + YAML) | ~150 MiB / run | ~1.5 GiB (10 runs) |
| Colab resume snapshot (`resume/<job-id>/blobs/<sha256>`) | ~150–300 MiB active run (old blobs pruned on commit) | ~300 MiB |
| Detailed benchmark report JSON | ~0.2–2 MiB / run | ~20 MiB |
| **Total Projected Footprint** | — | **~2.13 GiB (~14.2% of 15 GiB)** |

This leaves **> 12 GiB** headroom well below the 80% warning threshold (`12 GiB`) and 512 MiB hard upload safety buffer.

---

## 3. Quota Guard Behavior & Failure Policy

1. **Before any Drive upload (`upload_file` / `upload_bytes` / outbox batch / checkpoint chunk):**
   - Queries Drive `about?fields=storageQuota` (cached briefly on warm store and refreshed on write checks).
   - Evaluates `projected_used = usage + incoming_bytes` against `limit - min_free_buffer_bytes` (default `512 MiB` buffer).
   - Status levels surfaced in Admin UI (`admin-viread-drive-panel.tsx`):
     - `OK` (`< 80%`)
     - `WARNING` (`>= 80%` and `< 90%`)
     - `CRITICAL` (`>= 90%`, upload still allowed if buffer remains)
     - `EXCEEDED` (projected usage exceeds `limit - buffer` -> **upload blocked** with `DriveQuotaExceededError`).
2. **No Silent Fallback to Supabase:**
   - Verified by `test_quota_guard_blocks_upload_and_router_never_falls_back_to_supabase` and `test_outbox_worker_retries_on_drive_quota_full_and_never_marks_done`.
   - When Drive quota is full, outbox events transition cleanly to `RETRY` (with bounded exponential backoff, never `DONE`, never `DEAD` prematurely) and **never** spill blobs into Supabase Storage.
3. **API Call Efficiency:**
   - `VireadDriveConnectionService` maintains a warm in-process store cache keyed by `(connection_id, updated_at)` so consecutive outbox uploads and shard reads reuse the same OAuth access token and Drive subfolder IDs instead of re-authenticating or re-listing folders per file.
   - `ocr_engine._get_ocr_engines()` caches `_vietocr_active_storage_path` alongside `_vietocr_active_checkpoint_sha`, making **0 Drive API calls** on warm requests.
   - Colab worker supports a mounted-Drive local fast-path (`--drive-root`) before falling back to authenticated backend streaming proxy, saving both Render bandwidth and Drive API calls during training.
