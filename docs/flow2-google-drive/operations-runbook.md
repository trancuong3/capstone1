# ViRead Flow 2 — Zero-Cost Operations & Recovery Runbook

This runbook covers free-tier Google Drive setup (**0 VNĐ, NO Google Cloud Billing**), daily operation, Colab Free on-demand training, incident recovery, and rollback.

---

## 1. One-Time Setup: Free Google Cloud OAuth 2.0 Credentials (0 VNĐ)

> **IMPORTANT:** Do **NOT** enable Google Cloud Billing. Google Drive API v3 with personal OAuth 2.0 (`drive.file`) is **100% free**.

1. Open [Google Cloud Console](https://console.cloud.google.com/) using the Admin Google account that owns the dedicated 15 GiB Drive.
2. Create a free project (e.g., `viread-flow2-training`). Do **not** attach a billing account.
3. Go to **APIs & Services -> Library**, search **Google Drive API**, and click **Enable**.
4. Go to **APIs & Services -> OAuth consent screen**:
   - User Type: **External** (Testing mode is completely free; add the Admin's Gmail address under **Test users**).
   - Scopes: add **ONLY** `https://www.googleapis.com/auth/drive.file` (never `drive` or `drive.readonly`).
5. Go to **APIs & Services -> Credentials -> Create Credentials -> OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs: add your exact Admin Training UI URL(s), e.g.:
     - Local: `http://localhost:3000/admin/viread-training`
     - Production: `https://<your-frontend-domain>/admin/viread-training`
6. Copy `Client ID` and `Client Secret`.

---

## 2. Backend Environment Variables (`.env` / Render Free)

Generate two separate random 32+ byte secrets (e.g., `python -c "import secrets; print(secrets.token_urlsafe(48))"`):

```dotenv
# Enable Google Drive-first storage for all NEW Flow 2 training artifacts
VIREAD_FLOW2_STORAGE_PROVIDER=google_drive

# Free Google OAuth 2.0 credentials (drive.file scope ONLY)
VIREAD_GDRIVE_OAUTH_CLIENT_ID=<your-oauth-client-id>
VIREAD_GDRIVE_OAUTH_CLIENT_SECRET=<your-oauth-client-secret>
VIREAD_GDRIVE_OAUTH_REDIRECT_URI=https://<your-frontend-domain>/admin/viread-training
VIREAD_GDRIVE_OAUTH_ALLOWED_REDIRECT_URIS=https://<your-frontend-domain>/admin/viread-training,http://localhost:3000/admin/viread-training

# Dedicated Fernet encryption key for refresh token & OAuth state at rest (>= 32 chars)
VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY=<random-48-char-secret-1>

# Dedicated server-only HMAC signing key for /worker/jobs/{id}/artifact-stream (>= 32 chars, MUST differ from VIREAD_TRAINING_WORKER_TOKEN)
VIREAD_ARTIFACT_STREAM_SIGNING_SECRET=<random-48-char-secret-2>

# Quota safety buffer (default 512 MiB)
VIREAD_GDRIVE_MIN_FREE_BYTES=536870912
```

---

## 3. Database Migration & Initial Connection

1. **Apply migration on Staging first, then Production (only with Admin approval):**
   - Run `supabase/migrations/20261121210000_flow2_google_drive_storage.sql`.
2. **Connect Google Drive in Admin UI:**
   - Open `/admin/viread-training`.
   - In the **Google Drive — Flow 2 Storage** panel, click **Kết nối Google Drive**.
   - Approve the single `drive.file` consent prompt. The UI redirects back with `?code=...&state=...`, exchanges the token server-side, encrypts the refresh token at rest, and creates `MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified/{verified-samples,datasets,locked-tests,checkpoints,resume,benchmarks,audit,_selftest}`.
3. **Verify Health & Self-Test:**
   - Click **Kiểm tra kết nối** -> confirm status `CONNECTED`, private folder verified, and quota bar `< 80%`.
   - Click **Chạy Self-Test** -> confirms real upload, private permission check, streaming download + SHA-256 verify, and cleanup.

---

## 3b. Apps Script Bridge Setup (Recommended for Render Free — No 7-Day OAuth Expiry)

When using `scripts/google-apps-script/viread_flow2_drive_bridge.gs` as the Flow 2 Drive bridge:

1. Paste `scripts/google-apps-script/viread_flow2_drive_bridge.gs` into your Apps Script project (`Code.gs`).
2. **Enable Advanced Drive Service (`Drive API`) for permanent deletion (MANDATORY to avoid 30-day Trash quota buildup):**
   - In the Apps Script editor left sidebar, click **Services (+)** -> select **Drive API** (Identifier: `Drive`) -> click **Add**.
   - Without `Drive` enabled, `deleteFilePermanentlyOrTrash_` falls back to `file.setTrashed(true)` (`delete_mode: "trash_fallback"`), which keeps deleted checkpoints/resume blobs in Drive Trash for 30 days consuming the 15 GiB quota.
3. Deploy (or **Manage deployments -> Edit -> New version**) as a Web App (`Execute as: Me`, `Who has access: Anyone`, guarded by `VIREAD_BRIDGE_SECRET` HMAC-SHA256).
4. In `/admin/viread-training`, click **Kiểm tra kết nối** and **Chạy Self-Test** and confirm `advanced_drive_enabled: true` and `delete_mode: "permanent_delete"` (no amber Trash fallback warning).

---

## 4. Running On-Demand GPU Training on Colab Free (0 VNĐ)

Colab Free provides free interactive T4 GPU (`15 GiB VRAM`) sessions and is **not** a 24/7 daemon:

1. Verify enough Admin-verified pages exist (`>= 100` samples for training; `>= 200` pairs across `>= 30` independent book groups for Production Locked Test).
2. In `/admin/viread-training`, confirm a job is in `WAITING_FOR_COLAB_WORKER` (local GPU `< 6144 MiB` like GTX 1650 is automatically skipped).
3. Open [`ai/vietocr_v2/viread_vietocr_v2_colab_worker.ipynb`](../../ai/vietocr_v2/viread_vietocr_v2_colab_worker.ipynb) in Google Colab Free, select **Runtime -> Change runtime type -> T4 GPU**.
4. Configure Colab Secrets (`VIREAD_API_BASE`, `VIREAD_TRAINING_WORKER_TOKEN`) and mount the same Google Drive (enabling local fast-path reads & zero-cost content-addressed resume under `MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified/resume/jobs/<job-id>/`).
5. Run the notebook cells. If Colab disconnects mid-epoch, simply reopen Colab later and re-run — `LocalDriveJobStateStore` restores the last atomic manifest-committed snapshot automatically.
6. After training & Production Locked Test pass (`V2_WIN`), review metrics and checkpoint SHA-256 in `/admin/viread-training` and click **Phê duyệt & Kích hoạt** (Pilot benchmarks can NEVER unlock Production approval).

---

## 5. Incident & Failure Recovery Playbook

| Symptom / Alert | Root Cause | Safe Recovery Steps |
|---|---|---|
| **Drive Quota `CRITICAL` / `EXCEEDED`; Outbox events in `RETRY` (`DRIVE_QUOTA_EXCEEDED`)** | Personal 15 GiB Drive approached `limit - 512 MiB`. Flow 2 blocked uploads safely without spilling into Supabase. | Free space in Google Drive (empty Trash, prune archived non-active/non-rollback candidate runs), click **Kiểm tra kết nối**. Outbox `RETRY` events will automatically resume and sync with zero data loss. |
| **Drive Status `TOKEN_REVOKED` (`DRIVE_TOKEN_REVOKED`)** | Refresh token revoked by user or expired in OAuth Testing mode (7-day expiry if app is in Testing status). | In `/admin/viread-training`, click **Kết nối Google Drive** to re-authorize (`drive.file`). Existing folder IDs and files are reused; outbox `RETRY` events resume automatically. |
| **Desired Model vs Loaded Model Mismatch Alert** | DB `viread_ocr_active_model` points to a newly approved V2 model, but running backend worker still holds `ORIGINAL` or previous model (or Drive was unreachable during reload). | Check Drive Health Check, confirm checkpoint Drive manifest exists, trigger a health scan or restart the backend worker cleanly. Warm-loaded verified models never evict during transient Drive blips. |
| **Outbox Event `BLOCKED` (`CONFLICTING_LABEL_FOR_IMAGE_HASH`)** | Two revisions produced the exact same line crop SHA-256 with different Admin-verified labels. | Inspect the conflicting page revisions in Admin OCR Review, correct the mistaken label, and re-verify. |
| **Outbox Event `SKIPPED` (`AI_AUTO_VERIFIED_NOT_ELIGIBLE` or `PARENT_PRIVATE_BOOK_EXCLUDED`)** | Expected guardrail: AI-only auto-verified pages and parent private books are excluded from Flow 2 training. | For catalog books needing training inclusion, an Admin must explicitly review and verify the page. |
| **Public Permission Error (`DRIVE_PUBLIC_PERMISSION_DETECTED`)** | Parent folder in My Drive was accidentally shared publicly ("Anyone with link"). | Remove link sharing from `MyDrive/ViRead` in Google Drive web UI, then run **Kiểm tra kết nối** + **Chạy Self-Test**. |

---

## 6. Emergency Rollback

1. **Instant Model Rollback (No Downtime):** In `/admin/viread-training`, click rollback to `ORIGINAL` (or prior active checkpoint). OCR runtime immediately verifies and restores the previous weights.
2. **Pause Google Drive Writes:** Set `VIREAD_FLOW2_STORAGE_PROVIDER=supabase_legacy` and restart backend. Existing `gdrive://` artifacts remain readable while new writes pause.
3. **Full Schema Rollback (Only After Retiring All Drive Pointers):** Execute [`docs/flow2-google-drive/rollback-20261121210000.sql`](./rollback-20261121210000.sql). Its built-in `DO $$` guard refuses execution if any active model, run, dataset, or sample still points to Google Drive.
