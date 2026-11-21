# ViRead Flow 2 — Final Audit & 3-Round Red-Team Summary

**Branch:** `feat/flow2-google-drive-first-training`
**Audit Date:** `2026-11-21`

---

## 1. Three-Round Red-Team & Independent Code Review

### Round 1 — Architecture Review
Audited design invariants against Sections I–IX:
- **Storage abstraction separated from business logic?** YES (`backend/app/services/training_storage/` isolates Google Drive API v3, OAuth PKCE, Fernet crypto, quota guards, and Supabase Legacy behind `TrainingArtifactStore` + `TrainingArtifactStoreRouter`).
- **Any unintended Hybrid OCR modification?** NO (`git diff main -- backend/app/services/ocr_engine.py` touches ONLY `_v2_artifact_from_storage`, warm `_vietocr_active_storage_path` check, and read-only `get_loaded_vietocr_runtime_status`; 208 Group H tests pass with 0 failures).
- **Any false assumption that Colab Free runs 24/7?** NO (explicitly modeled as interactive on-demand T4 execution with crash-safe content-addressed Drive resume).
- **Any risk of losing verified training data when Drive is unavailable/full?** NO (outbox transitions to bounded retryable `RETRY` on Drive quota/auth/transient errors, never `DONE`, never prematurely `DEAD`, and never silently spills blobs into Supabase Storage).
- **Can checkpoints survive runtime restart?** YES (local atomic SHA-verified cache + streaming `gdrive://` re-assembly from Drive on cold start + warm-loaded RAM retention during transient Drive blips).

### Round 2 — Adversarial Failure Testing
Explicitly simulated and asserted in automated tests (`test_flow2_google_drive_storage.py`, `test_flow2_admin_verified_pipeline.py`, `test_flow2_drive_worker.py`):
- Mid-upload network drop + `308 Resume Incomplete` offset recovery & duplicate upload dedup.
- Crash / cancellation during outbox ACK & DB commit shielding.
- Google Drive quota full (`DriveQuotaExceededError`) -> upload blocked, zero Supabase fallback, outbox retries safely.
- Token revocation (`invalid_grant`) -> marks DB `TOKEN_REVOKED`, outbox retries instead of dead-lettering.
- HTTP `401`/`403`/`404`/`429`/`5xx` matrix with exponential backoff + jitter and capped `401` refresh.
- Corrupted/tampered artifact SHA-256 mismatch, deleted/trashed file, accidentally public file auto-deletion.
- Duplicate line image hash with conflicting labels -> advisory-locked detection -> `BLOCKED`.
- Corrupt/orphan resume files without atomic manifest -> rejected; cross-lineage resume -> rejected.
- Local GTX 1650 (4096 MiB VRAM < 6144 MiB) -> safely rejected (`INSUFFICIENT_VRAM`).

### Round 3 — Independent Multi-Agent Code Review & Remediations
Two independent read-only subagents audited the complete diff, code paths, and test coverage:

#### A. Independent Security & Architecture Reviewer
| ID | Severity | Finding | Resolution | Status |
|---|---|---|---|---|
| **C1** | CRITICAL | `/artifact-stream` HMAC fell back to `VIREAD_TRAINING_WORKER_TOKEN` and lacked DB ownership check + allowed legacy paths. | Dedicated server-only HMAC key (`VIREAD_ARTIFACT_STREAM_SIGNING_SECRET` -> `VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY` -> `SUPABASE_SECRET_KEY`), restricted to `is_gdrive_ref(ref)`, plus DB ownership query `authorize_worker_artifact_ref(job_id, ref)`. | **FIXED & TESTED** |
| **H1** | HIGH | Client could supply arbitrary `redirect_uri` in OAuth start/callback. | Enforced exact match against server-configured env allowlist (`resolve_allowed_redirect_uri`). | **FIXED & TESTED** |
| **H2** | HIGH | Sync `requests` Drive calls blocked FastAPI async event loop. | Wrapped all sync Drive/OAuth calls in `asyncio.to_thread()`. | **FIXED & TESTED** |
| **M1–M6** | MEDIUM | Folder privacy on `health_check()`, domain-separated Fernet keys, strict `drive.file`-only scope allowlist, StrictMode-safe OAuth callback, auto-delete on public upload, rollback SQL safety guard. | All 6 remediated in code + rollback SQL `DO $$ RAISE EXCEPTION $$` guard. | **FIXED & TESTED** |

#### B. Independent QA & Failure-Mode Auditor
| ID | Severity | Finding | Resolution | Status |
|---|---|---|---|---|
| **CRIT-01** | CRITICAL | `register_dataset` shared a single `AsyncSession` across concurrent `asyncio.gather` tasks. | Resolved `TrainingArtifactStoreRouter` once before `asyncio.gather`. | **FIXED & TESTED** |
| **CRIT-02** | CRITICAL | `BENCHMARK_ONLY` job with newly pinned Locked Test failed training resume manifest identity check. | Skipped training `state_store` when `operation == "BENCHMARK_ONLY"`. | **FIXED & TESTED** |
| **CRIT-03** | CRITICAL | `_get_ocr_engines()` re-called `_v2_artifact_from_storage()` on every scan even when exact V2 model was already loaded in RAM, risking Drive eviction during blips. | Tracked `_vietocr_active_storage_path`; skipped Drive when `(sha, profile, storage_path)` match. | **FIXED & TESTED** |
| **CRIT-04** | CRITICAL | Optional additive-column `UPDATE` on pre-migration DB could abort open PostgreSQL transaction without `SAVEPOINT`. | Added `_exec_optional_column_update()` wrapped in `self.db.begin_nested()`. | **FIXED & TESTED** |
| **CRIT-05** | CRITICAL | Uncapped `401` retry loop in `_upload_resumable_chunks` + unvalidated `Location` host. | Capped `401` refresh retries and enforced `https://*.googleapis.com` upload session host validation. | **FIXED & TESTED** |
| **HIGH-01..09** | HIGH | Missing `storage_provider`/`drive_file_id` on snapshot/locked/pilot samples; unpinned `source_image_path`; advisory lock on conflict check; content-addressed Drive resume `blobs/<sha256>` (plus Windows `wb` `fsync` fix); mounted-Drive fast-path + stale `.download` cleanup; warm Drive store token reuse; `decide(APPROVE)` Drive manifest check + `activate_flow1_model` metadata reset; `LOCKED_TEST` leakage exclusion; `main`-schema `to_jsonb(b) ->> 'visibility_scope'` compatibility. | All 9 remediated and verified in final post-remediation test run (310 unique tests, 0 failures). | **FIXED & TESTED** |

---

## 2. Section XVII — Definition of Done (Honest Checklist)

- [x] Luồng 2 lấy đúng revision Admin `VERIFIED` (verified in outbox, dataset manifest, Locked/Pilot tests).
- [x] Không lấy AI-only OCR (`AI_AUTO_VERIFIED`) làm ground truth (blocked across all 3 layers + regression tests).
- [x] Ảnh crop và nhãn khớp chính xác (pinned `source_image_path`, NFC Vietnamese, reading order, SHA-256 image & label, duplicate-hash conflict `BLOCKED`).
- [x] Training artifacts mới được lưu vào Google Drive (`verified-samples`, `datasets`, `locked-tests`, `checkpoints`, `resume`, `benchmarks`).
- [x] Supabase không chứa bản sao training blob mới không cần thiết (zero silent fallback to Supabase; PostgreSQL metadata-only).
- [x] Dataset immutable và có integrity verification (`manifest.json`, `train/validation/holdout.jsonl`, SHA-256 hashes).
- [x] Không tồn tại leakage giữa các tập dữ liệu (book-group disjoint splits + `LOCKED_TEST` images/groups strictly excluded from training snapshots).
- [x] Scheduler nhận đúng dataset (`viread_ocr_training_auto_worker` + `viread_ocr_training_service`).
- [x] Training worker có thể đọc dữ liệu từ Drive (4-layer secured `/artifact-stream` proxy + mounted Drive fast-path + SHA-256 verify).
- [x] Candidate checkpoint có thể lưu và tải lại (sharded Drive upload, manifest verification, streaming Range download).
- [x] Model activation cần quality gate và Admin approval (Pilot blocked from Production approval; Drive manifest verified on Approve).
- [x] Runtime hỗ trợ checkpoint trên Drive (`ocr_engine._v2_artifact_from_storage` streams `gdrive://` + SHA-256 verify + warm-loaded RAM retention).
- [x] Hybrid OCR không bị thay đổi hành vi ngoài ý muốn (208 Group H tests PASS, 0 FAIL; minimal surgical diff in `ocr_engine.py`).
- [x] Các unit/integration/regression tests bắt buộc đạt (310 unique automated tests: 295 PASS, 15 pre-existing SKIPPED, 0 FAIL; ruff/eslint/prettier/tsc all PASS).
- [x] Live tests được ghi nhận trung thực (3 objective blockers clearly marked `BLOCKED`, never falsely marked `PASS`).
- [x] Không có critical/high security defect chưa xử lý (all Round 3 CRITICAL & HIGH findings fixed and regression-tested).
- [x] Không có lỗi có thể tái hiện chưa được giải quyết trong phạm vi.
- [x] Không phát sinh dịch vụ trả phí (0 VNĐ; zero billing, zero paid APIs, 0 diff in `backend/requirements.txt`).
- [x] Có tài liệu recovery/rollback (`operations-runbook.md`, `storage-migration.md`, guarded `rollback-20261121210000.sql`).
- [x] Có PR trên nhánh `feat/flow2-google-drive-first-training` và bộ báo cáo đầy đủ trong `docs/flow2-google-drive/`.

### Items Honestly Remaining `BLOCKED` (Requiring Admin Action / External Hardware)
- [ ] **BLOCKED — Live Google Drive OAuth & real-folder self-test:** Requires Admin to supply free Google Cloud OAuth 2.0 Web Client credentials (`VIREAD_GDRIVE_*`) and complete interactive browser consent (`drive.file`).
- [ ] **BLOCKED — Live >= 6 GiB GPU training & real fine-tuned checkpoint:** Local machine has GTX 1650 (4096 MiB < 6144 MiB minimum); requires running `ai/vietocr_v2/viread_vietocr_v2_colab_worker.ipynb` on Colab Free T4 GPU once sufficient real Admin-verified books exist.
- [ ] **BLOCKED — Production Supabase DDL migration & production deploy:** Requires explicit Admin approval after staging review (Rule I.3).
