# ViRead Flow 2 — Security Review & Threat Model

**Scope:** Google Drive OAuth 2.0 integration, refresh token storage, worker artifact streaming proxy, Admin RBAC, dataset & artifact integrity, and secret hygiene.

---

## 1. Security Controls Implemented

| Control Area | Enforcement Mechanism | Code Location |
|---|---|---|
| **Least-Privilege OAuth Scope** | Strict exact-set allowlist: `granted_scopes == {"https://www.googleapis.com/auth/drive.file"}`. Requests with missing `drive.file` OR any broader scope (e.g., `drive`, `drive.readonly`, `userinfo.email`) are rejected and the newly minted token is immediately revoked via Google OAuth revoke endpoint. | `backend/app/services/training_storage/google_drive_oauth.py` |
| **PKCE + Anti-Replay State** | OAuth 2.0 Authorization Code flow with PKCE `S256` (`code_verifier` stored inside encrypted state, never sent to client). State token is bound to `actor_id` (Admin UUID), expires after 10 minutes, and is single-use via consumed-nonce tracking. | `backend/app/services/training_storage/google_drive_oauth.py` |
| **Redirect URI Allowlist (H1)** | Client-supplied `redirect_uri` is validated strictly against server-configured `VIREAD_GDRIVE_OAUTH_REDIRECT_URI` / `VIREAD_GDRIVE_OAUTH_ALLOWED_REDIRECT_URIS`. Arbitrary redirect targets are rejected before authorization URL generation or token exchange. | `backend/app/services/training_storage/google_drive_oauth.py`, `backend/app/services/viread_drive_connection_service.py` |
| **Token Encryption at Rest** | Refresh tokens are encrypted with Fernet using a **domain-separated** SHA-256 derived key (`viread-gdrive:refresh-token-v1`), completely separate from the OAuth state key (`viread-gdrive:oauth-state-v1`). Plaintext refresh tokens are never persisted, never returned in API responses, never logged, and never shared with Colab workers. | `backend/app/services/training_storage/google_drive_oauth.py`, `backend/app/repositories/viread_drive_connection_repository.py` |
| **Database RLS & Least Privilege** | `public.viread_ocr_drive_connections` has `ENABLE ROW LEVEL SECURITY` and `REVOKE ALL FROM PUBLIC, anon, authenticated;`. No PostgREST anonymous/authenticated user can query encrypted tokens or Drive metadata. | `supabase/migrations/20261121210000_flow2_google_drive_storage.sql` |
| **Admin RBAC** | All 6 `/admin/viread-training/drive/*` routes require `Depends(get_current_admin)`. Non-admin / parent tokens receive HTTP `403`. | `backend/app/api/routes/admin_viread_training.py` |
| **4-Layer Worker Artifact Stream Defense (C1)** | `GET /admin/viread-training/worker/jobs/{job_id}/artifact-stream` enforces: (1) valid worker bearer token (`hmac.compare_digest`), (2) server-only HMAC signature derived from `VIREAD_ARTIFACT_STREAM_SIGNING_SECRET` (fallback `VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY` -> `SUPABASE_SECRET_KEY`, **never** `VIREAD_TRAINING_WORKER_TOKEN`), bound to `(job_id, ref, exp)`, (3) active worker lease on `job_id`, and (4) `is_gdrive_ref(ref)` + DB authorization query proving `ref` belongs to `job_id`'s dataset/locked-test/candidate/base-checkpoint. Prevents IDOR, legacy Supabase proxy abuse, and URL forgery. | `backend/app/api/routes/admin_viread_training.py`, `backend/app/services/training_storage/router.py`, `backend/app/services/viread_ocr_training_service.py` |
| **Private-Only Artifact Guard** | After every upload (and during `health_check()` / `self_test()`), Drive permissions are inspected. Any `type in {"anyone", "domain"}` permission triggers immediate best-effort deletion of the uploaded file and raises `DrivePermissionError("DRIVE_PUBLIC_PERMISSION_DETECTED")`. | `backend/app/services/training_storage/google_drive_store.py` |
| **Trusted Upload Session Host (CRIT-05)** | Resumable upload `Location` URI is validated to require `https` and a trusted Google APIs host (`*.googleapis.com` / `googleapis.com`), preventing SSRF / token exfiltration to untrusted hosts. 401 refresh retries are capped to prevent infinite loops. | `backend/app/services/training_storage/google_drive_store.py` |
| **Reference & Input Hardening** | `parse_gdrive_ref()` validates Drive file IDs (`^[A-Za-z0-9_-]{8,128}$`), blocks `..`, slashes, whitespace, null bytes, and scheme spoofing. Outbox rejects control characters, invalid bounding boxes, corrupt images, and `AI_AUTO_VERIFIED` / `PARENT_PRIVATE` inputs. | `backend/app/services/training_storage/references.py`, `backend/app/jobs/viread_ocr_outbox_worker.py` |
| **Log & Error Sanitization** | Diagnostic logs emit only structured error codes, IDs, byte counts, and exception class names — never refresh tokens, access tokens, client secrets, or private book text. `health_check()` strips raw exception strings before returning to UI. | `backend/app/services/training_storage/google_drive_store.py`, `backend/app/services/viread_drive_connection_service.py` |

---

## 2. Independent Red-Team Security Findings & Remediations (Round 3)

An independent Security & Architecture Reviewer audited the full diff and identified the following security findings — **all CRITICAL and HIGH findings were remediated and covered by regression tests**:

| ID | Severity | Finding | Fix Applied & Verified Test |
|---|---|---|---|
| **C1** | CRITICAL | Worker artifact stream HMAC fell back to `VIREAD_TRAINING_WORKER_TOKEN` (known by worker) and `/artifact-stream` lacked DB ownership check + allowed legacy paths. | Switched HMAC key strictly to server-only secret (`VIREAD_ARTIFACT_STREAM_SIGNING_SECRET` -> `VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY` -> `SUPABASE_SECRET_KEY`), restricted route to `is_gdrive_ref(ref)`, and added `authorize_worker_artifact_ref(job_id, ref)` DB check. Verified by `test_worker_artifact_stream_hmac_uses_server_only_key_and_prevents_idor_and_expiry` and `test_artifact_stream_route_blocks_legacy_paths_and_unauthorized_drive_ids`. |
| **H1** | HIGH | OAuth start/callback accepted arbitrary client-supplied `redirect_uri`. | Added `resolve_allowed_redirect_uri()` enforcing exact match against server-configured env allowlist. Verified by `test_oauth_pkce_state_fernet_encryption_scope_and_anti_replay`. |
| **H2** | HIGH | Synchronous `requests` Drive I/O executed directly on FastAPI async event loop. | Wrapped all sync Drive/OAuth calls in `asyncio.to_thread()` across `VireadDriveConnectionService`, `VireadOcrTrainingService`, `viread_ocr_outbox_worker`, and `/artifact-stream`. |
| **M1** | MEDIUM | Folder privacy not checked on `health_check()`. | Added `_assert_file_is_private()` check on root folder during `health_check()` + sanitized error output. |
| **M2** | MEDIUM | Same Fernet key used for OAuth state and refresh tokens. | Added domain separation (`refresh-token-v1` vs `oauth-state-v1`). |
| **M5** | MEDIUM | `self_test()` left behind public file if Drive folder inherited public sharing. | `_assert_file_is_private()` now deletes the accidentally public object before raising `DrivePermissionError`. |

---

## 3. Secret & Paid-Cloud Static Scan Evidence

Automated regex scan across all 28 created/modified Flow 2 source, migration, notebook, test, and env-example files for:
- Google API keys (`AIza...`), OAuth client secrets (`GOCSPX-...`), access/refresh tokens (`ya29...`, `1//...`), private keys (`BEGIN ... PRIVATE KEY`), OpenAI/API keys (`sk-...`), and paid Google Cloud endpoints (`storage.googleapis.com`, `run.googleapis.com`, `aiplatform.googleapis.com`).

**Result:** `ZERO_SECRET_OR_PAID_CLOUD_HITS` (0 secrets, 0 paid GCP endpoints).
