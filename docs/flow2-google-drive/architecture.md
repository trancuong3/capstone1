# ViRead Flow 2 — Google Drive-First AI Training Architecture

**Branch:** `feat/flow2-google-drive-first-training`
**Base Reference:** `main` (`aafa3966`)
**Profile:** `FLOW2_ADMIN_VERIFIED` (historical `source_flow = 'FLOW1_VERIFIED'` preserved for backward compatibility with existing rows)
**Cost Posture:** **0 VNĐ** additional infrastructure cost

---

## 1. Pre-Edit System Audit (Section II — 10 Mandatory Questions)

Before modifying any source file, the codebase on `main` (`aafa3966`) was audited end-to-end across `ai/vietocr_v2/`, `backend/app/`, `frontend/`, and `supabase/migrations/`.

| # | Audit Question | Ground-Truth Finding on `main` (Pre-Edit) | Impact & Resolution in Flow 2 |
|---|---|---|---|
| 1 | **What data is stored in Supabase Database?** | PostgreSQL stores catalog books (`books`, `bookpages`, `pagerevisions`, `pagerevisionwords`), reading telemetry, plus Flow 2 training tables (`viread_ocr_outbox`, `viread_ocr_samples`, `viread_ocr_dataset_versions`, `viread_ocr_training_runs`, `viread_ocr_checkpoint_chunks`, `viread_ocr_benchmarks`, `viread_ocr_active_model`, `viread_ocr_model_decisions`). No binary blobs are stored in PostgreSQL. | Kept metadata-only in PostgreSQL. Added additive Drive pointer/provider columns and RLS-locked `viread_ocr_drive_connections` table (`20261121210000_flow2_google_drive_storage.sql`). |
| 2 | **What data occupies Supabase Storage?** | Original uploaded book page images, book covers/audio (production reading), PLUS Flow 1 manual checkpoints AND all Flow 2 line crop PNGs, dataset manifests, Locked/Pilot test manifests, training checkpoint shards, and benchmark artifacts inside the single 1 GB free-tier bucket. | Original book assets and existing legacy checkpoints remain untouched in Supabase Storage. All **new** Flow 2 training blobs (line PNGs, label JSONs, dataset JSONLs/manifests, Locked/Pilot manifests, checkpoints, resume snapshots, detailed benchmark reports) now write exclusively to Google Drive when `VIREAD_FLOW2_STORAGE_PROVIDER=google_drive`. |
| 3 | **What data is essential for books and OCR production?** | `books`, `bookpages`, `pagerevisions`, `pagerevisionwords`, book page images in Supabase Storage, `viread_ocr_active_model` pointer, and the active/rollback VietOCR checkpoint artifacts referenced by `viread_ocr_active_model` / `viread_ocr_model_decisions`. | Untouched. Zero migration or deletion of original book images or active/rollback weights. |
| 4 | **What data serves training only?** | Verified line crops (`viread_ocr_samples`), label provenance JSONs, immutable dataset manifests & split JSONLs (`train.jsonl`, `validation.jsonl`, `holdout.jsonl`), Locked/Pilot test manifests, training checkpoint candidate shards, Colab resume states, and detailed benchmark reports. | Moved to dedicated private Google Drive folder `MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified/`. |
| 5 | **Path of a `VERIFIED` revision?** | Admin verifies page -> `pagerevisions.verificationstatus = 'VERIFIED'` + transactional insert into `viread_ocr_outbox` -> `viread_ocr_outbox_worker.py` claims event, downloads source page image, crops lines, writes PNG to storage, inserts `viread_ocr_samples` (`source_flow='FLOW1_VERIFIED'`). **Pre-edit gaps found:** `AI_AUTO_VERIFIED` could pass status checks; `p.imagepath` was not pinned to `r.processingmeta ->> 'source_image_path'`; duplicate image hashes with conflicting labels were silently overwritten/duplicated. | Hardened at all 3 layers (outbox eligibility filter, dataset/locked/pilot SQL filters, advisory-locked duplicate-hash conflict check `BLOCKED`, pinned `source_image_path`, NFC Vietnamese normalization, Drive-first PNG + JSON upload). |
| 6 | **Conditions for scheduler to create a job?** | `viread_ocr_training_auto_worker.py` checks eligible verified samples (`>= 100` train + validation samples, valid split, no active training run, cooldown satisfied), creates immutable dataset snapshot, creates `viread_ocr_training_runs` row (`QUEUED` -> `WAITING_FOR_COLAB_WORKER` when local GPU < 6144 MiB VRAM or local training disabled). | Preserved strict readiness & Locked Test gates (`>= 200` pairs, `>= 30` groups; never lowered). Excluded `AI_AUTO_VERIFIED` and `LOCKED_TEST` leakage. |
| 7 | **Path of a checkpoint after training completes?** | `colab_worker.py` trains VietOCR V2, shards checkpoint into `<= 40 MB` chunks with SHA-256, uploads via `/admin/viread-training/worker/jobs/{job_id}/checkpoint-chunks`, registers candidate, runs Locked/Pilot benchmark, submits report. **Pre-edit bug found:** `colab_worker.py:578` checked `report.get("gate_status")` (always `None`) instead of `report["gate"]["status"]`, misreporting passing `V2_WIN` benchmarks! | Fixed `colab_worker.py` `gate_status` extraction, persisted Flow 2 candidate chunks/manifests/reports on Google Drive, added crash-safe content-addressed `LocalDriveJobStateStore` (`blobs/<sha256>`), and enforced Drive manifest existence check in `decide(APPROVE)`. |
| 8 | **How does OCR runtime load the active model?** | `backend/app/services/ocr_engine.py` reads `viread_ocr_active_model` singleton (`_active_viread_model()`), calls `_v2_artifact_from_storage()`, downloads manifest + shards, verifies per-shard and assembled SHA-256, writes atomic local cache, loads `Predictor`, attaches verified provenance in WeakKeyDictionary. | Minimal surgical addition ONLY inside `_v2_artifact_from_storage()` (streaming `gdrive://` shard download via `TrainingArtifactStoreRouter`) + warm-loaded `_vietocr_active_storage_path` guard (zero Drive traffic when exact V2 model is already loaded in RAM) + read-only `get_loaded_vietocr_runtime_status()`. Zero changes to Hybrid OCR inference. |
| 9 | **Risks of moving Flow 2 storage to Google Drive?** | Token revocation/expiry, 15 GiB quota exhaustion, mid-upload network drops, Render Free 512 MiB RAM exhaustion if buffering shards, accidental public folder inheritance, Drive API rate limits (429/5xx), and silent fallback to Supabase polluting the 1 GB free bucket. | Mitigated via PKCE `drive.file`-only OAuth, domain-separated Fernet refresh token encryption, 256 KiB resumable upload with `308` recovery, streaming Range download, strict quota guard (zero silent Supabase fallback), private-permission check + auto-delete, warm store caching, and retryable outbox backoff. |
| 10 | **What cannot be fully automated in a 0 VNĐ environment?** | (a) Initial Google OAuth 2.0 browser consent by the Admin owning the Google account; (b) 24/7 unattended GPU training on Colab Free (sessions are interactive and time-bounded); (c) Production Supabase DDL migration & production deployment (forbidden without Admin approval). | Explicitly modeled as Admin-assisted actions: one-time Admin OAuth connect in `/admin/viread-training`, on-demand Colab Free notebook execution with resumable Drive snapshots, and reviewed PR + SQL migration scripts for Admin deployment. |

---

## 2. End-to-End Flow 2 Architecture

```text
ADMIN UPLOAD BOOK (original page images stay in existing Supabase Storage)
        |
        v
HYBRID OCR ENGINE (PaddleOCR/DBNet + VietOCR + Tesseract fallback — UNCHANGED)
        |
        v
AI-ASSISTED PROOFREAD SUGGESTIONS (never auto-eligible for training)
        |
        v
EXPLICIT ADMIN VERIFICATION & COMMIT (Immutable VERIFIED pagerevisions)
        |
        v
TRANSACTIONAL OUTBOX (public.viread_ocr_outbox)
        |-- Rejects/Skips: AI_AUTO_VERIFIED, REVISION_NOT_VERIFIED, PARENT_PRIVATE
        |-- Blocks: duplicate image_sha256 with conflicting NFC label (advisory-locked)
        |-- Retries (never dead-letters): Drive quota full / disconnected / token revoked
        v
VERIFIED LINE CROPPER (NFC Vietnamese, pinned source_image_path, SHA-256 image & label)
        |
        v
TrainingArtifactStoreRouter (provider-explicit refs: gdrive://<file_id> | legacy path)
        |
        +---> GOOGLE DRIVE PRIVATE STORAGE (MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified/)
        |       ├── verified-samples/<revision-id>/line-XXXX.png + line-XXXX.json
        |       ├── datasets/<dataset-version>/manifest.json + train/validation/holdout.jsonl
        |       ├── locked-tests/<locked-or-pilot-version>/manifest.json
        |       ├── checkpoints/<run-id>/manifest.json + shard-XXXX.part + config.yml
        |       ├── resume/<job-id>/blobs/<sha256> + state_manifest.json
        |       ├── benchmarks/<run-id>/<benchmark-id>/report.json
        |       └── audit/ & _selftest/
        |
        +---> SUPABASE POSTGRESQL (Metadata pointers, SHA-256 hashes, status, audit trail ONLY)
        v
SCHEDULER & COLAB FREE GPU WORKER (on-demand T4, >= 6 GiB VRAM gate; local GTX 1650 4 GiB rejected safely)
        |-- Streams artifacts via 4-layer secured backend proxy (/worker/jobs/{id}/artifact-stream)
        |-- Optional mounted-Drive local fast-path with SHA-256 verification & proxy fallback
        |-- Content-addressed Drive resume store (survives mid-sync Colab disconnect)
        v
LOCKED TEST (>= 200 pairs, >= 30 book groups) + QUALITY GATE (Pilot cannot replace Production)
        |
        v
EXPLICIT ADMIN APPROVAL (verifies Drive manifest exists, updates active pointer)
        |
        v
HYBRID OCR RUNTIME (streams gdrive:// shards with SHA-256 verify, caches in RAM, Desired vs Loaded visibility)
```

---

## 3. Storage Abstraction & Provider-Explicit References

Implemented in `backend/app/services/training_storage/`:

- [`references.py`](../../backend/app/services/training_storage/references.py): Canonical reference parser/validator.
  - Google Drive references use `gdrive://<file_id>` (strict character allowlist, rejects path traversal `..`, slashes, whitespace, query fragments).
  - Legacy Supabase Storage paths remain plain relative paths (never prefixed with `gdrive://`).
- [`base.py`](../../backend/app/services/training_storage/base.py): Provider-agnostic `TrainingArtifactStore` protocol, typed exceptions (`DriveAuthError`, `DriveQuotaExceededError`, `DrivePermissionError`, `DriveIntegrityError`, `DriveNotFoundError`, `DriveTransientError`), `QuotaStatus`, `HealthReport`, `SelfTestReport`.
- [`google_drive_oauth.py`](../../backend/app/services/training_storage/google_drive_oauth.py): OAuth 2.0 Authorization Code + PKCE (`S256`), strict allowlist scope `https://www.googleapis.com/auth/drive.file`, domain-separated Fernet keys (`refresh-token-v1`, `oauth-state-v1`), anti-replay actor-bound OAuth state, server-configured `redirect_uri` allowlist.
- [`google_drive_store.py`](../../backend/app/services/training_storage/google_drive_store.py): Google Drive API v3 client using existing `requests==2.32.5` (zero new dependencies). Features 256 KiB-aligned resumable upload, `308` resume & mid-drop offset query, capped `401` refresh retry, trusted `https://*.googleapis.com` upload session host validation, SHA-256 dedup via `appProperties`, streaming Range download, pre-upload quota guard, private-only permission verification (auto-deletes on accidental public inheritance), `health_check()`, and `self_test()`.
- [`supabase_legacy_store.py`](../../backend/app/services/training_storage/supabase_legacy_store.py): Read-compatible wrapper around existing `storage_service.py` for legacy checkpoints/datasets and Flow 1 assets.
- [`router.py`](../../backend/app/services/training_storage/router.py): `TrainingArtifactStoreRouter` routes reads by explicit reference scheme (`gdrive://` -> Drive, otherwise -> Supabase Legacy) and routes new Flow 2 writes strictly to the configured provider (`google_drive` default) with **zero silent fallback** to Supabase when Drive is full, disconnected, or revoked. Also provides server-only HMAC signing/verification for `/worker/jobs/{job_id}/artifact-stream`.

---

## 4. Minimal Hybrid OCR Runtime Integration

Only three surgical additions were made in [`backend/app/services/ocr_engine.py`](../../backend/app/services/ocr_engine.py):
1. `_v2_artifact_from_storage()`: Streams `gdrive://` shard manifests, shards, and configs through `get_runtime_artifact_router().open_stream(...)` while verifying per-shard byte count, per-shard SHA-256, and assembled checkpoint SHA-256 before atomic `os.replace`.
2. `_get_ocr_engines()`: Tracks `_vietocr_active_storage_path` so an already-loaded, verified VietOCR V2 predictor matching `(active_sha, active_profile, storage_path)` performs **zero Google Drive calls** and is never evicted by transient Drive outages.
3. `get_loaded_vietocr_runtime_status()`: Read-only snapshot exposing the actual in-RAM loaded profile/SHA to Admin Overview so the UI clearly distinguishes **Desired Model (DB)** vs **Loaded Model (Runtime)**.

No detection, recognition, alignment, adjudication, confidence calibration, reading order, or Tesseract fallback logic was modified.
