# ViRead Flow 2 — Verification & Test Results

**Execution Timestamp:** `2026-11-21 21:20–21:25 +07:00` (Post-Round-3 Remediation Final Run)
**Branch:** `feat/flow2-google-drive-first-training`
**Host Environment:** Windows 11, Python `3.12.10` (`.venv`), Node/Vitest `v5.0.0`, GPU `NVIDIA GeForce GTX 1650 with Max-Q Design (4096 MiB VRAM, 3935 MiB free)`

---

## 1. Honest Status Summary Table

| Category / Suite | Executed | PASS | FAIL | SKIPPED | BLOCKED | Status |
|---|---:|---:|---:|---:|---:|---|
| **Backend Flow 2 + ViRead Training Suite** (9 test modules) | 84 | 84 | 0 | 0 | 0 | **PASS** |
| **Backend Hybrid OCR Regression Suite (Group H)** (8 test modules) | 208 | 193 | 0 | 15* | 0 | **PASS** |
| **`ai/vietocr_v2` Training & Colab Worker Suite** (3 test modules) | 23 | 23 | 0 | 0 | 0 | **PASS** |
| **Frontend Admin Flow 1 + Flow 2 Vitest Suite** (2 test files) | 8 | 8 | 0 | 0 | 0 | **PASS** |
| **Static Analysis (`ruff`, `eslint`, `prettier`, `tsc --noEmit`, FastAPI import, secret scan)** | 8 checks | 8 | 0 | 0 | 0 | **PASS** |
| **Live Google Drive OAuth & Real Folder Integration** | 0 | 0 | 0 | 0 | 1 | **BLOCKED** |
| **Live GPU Training (>= 6 GiB VRAM / Colab Free T4)** | 0 | 0 | 0 | 0 | 1 | **BLOCKED** |
| **Production Supabase DDL Migration & Prod Deploy** | 0 | 0 | 0 | 0 | 1 | **BLOCKED** |

*\*Pre-existing skips in Group H are optional heavy local model runtime tests already skipped on `main` when local model weights/binaries are not downloaded.*
**Deduplicated Automated Total:** **310 unique unit/integration/regression/UI test cases** (`295 PASS`, `15 pre-existing SKIPPED`, `0 FAIL`, `0 ERROR`) + **8/8 static & contract checks PASS** + **3 objective external items honestly `BLOCKED`**.

---

## 2. Exact Executed Commands & Observed Outputs

### 2.1. Backend Flow 2 + ViRead Training + Provenance + Flow 1 (84 tests)
```powershell
cd F:\c1\capstone1\backend
..\.venv\Scripts\python.exe -m unittest `
  test_flow2_google_drive_storage.py `
  test_flow2_admin_verified_pipeline.py `
  test_viread_ocr_outbox_worker.py `
  test_viread_ocr_training_auto_worker.py `
  test_viread_dual_training_contracts.py `
  test_viread_training_worker_claim.py `
  test_viread_checkpoint_streaming.py `
  test_ocr_runtime_provenance.py `
  test_viread_flow1_model_replacement.py -v
```
- **Observed Result:** `Ran 84 tests in 1.971s — OK`
- **Breakdown by file:**
  - `test_flow2_google_drive_storage.py`: **11 PASS** (re-verified in 0.064s after final dummy-string cleanup)
  - `test_flow2_admin_verified_pipeline.py`: **9 PASS**
  - `test_viread_ocr_outbox_worker.py`: **10 PASS**
  - `test_viread_ocr_training_auto_worker.py`: **10 PASS**
  - `test_viread_dual_training_contracts.py`: **10 PASS**
  - `test_viread_training_worker_claim.py`: **9 PASS**
  - `test_viread_checkpoint_streaming.py`: **4 PASS**
  - `test_ocr_runtime_provenance.py`: **13 PASS**
  - `test_viread_flow1_model_replacement.py`: **8 PASS**

### 2.2. Hybrid OCR Regression Suite — Group H (208 tests)
```powershell
cd F:\c1\capstone1\backend
..\.venv\Scripts\python.exe -m unittest `
  test_ocr_engine.py `
  test_ocr_adjudication.py `
  test_ocr_punctuation.py `
  test_ocr_calibration.py `
  test_ocr_color_matrix.py `
  test_ocr_false_yellow_suite.py `
  test_hybrid_ocr_evidence.py `
  test_ocr_runtime_provenance.py -v
```
- **Observed Result:** `Ran 208 tests in 36.632s — OK (skipped=15)`

### 2.3. `ai/vietocr_v2` Training & Colab Worker Suite (23 tests)
```powershell
cd F:\c1\capstone1
.\.venv\Scripts\python.exe -m unittest discover -s ai/vietocr_v2 -t . -p "test_*.py" -v
```
- **Observed Result:** `Ran 23 tests in 0.571s — OK`
  - `test_colab_state_store.py`: **4 PASS**
  - `test_colab_worker.py`: **14 PASS**
  - `test_flow2_drive_worker.py`: **5 PASS**

### 2.4. Frontend Formatting, ESLint, TypeScript & Vitest (8 tests)
```powershell
cd F:\c1\capstone1\frontend
npx.cmd eslint components/admin/admin-viread-drive-panel.tsx components/admin/admin-viread-training-screen.tsx lib/api/viread-training-service.ts test/admin-viread-drive-flow2.test.tsx
npx.cmd prettier --check components/admin/admin-viread-drive-panel.tsx components/admin/admin-viread-training-screen.tsx lib/api/viread-training-service.ts test/admin-viread-drive-flow2.test.tsx
npx.cmd tsc --noEmit
npx.cmd vitest run test/admin-viread-training-flow1.test.tsx test/admin-viread-drive-flow2.test.tsx
```
- **Observed Results:**
  - ESLint: `0 errors, 0 warnings`
  - Prettier: `All matched files use Prettier code style!`
  - `tsc --noEmit`: `exit code 0`
  - Vitest: `Test Files 2 passed (2) | Tests 8 passed (8) | Duration 6.90s`

### 2.5. Static Checks, App Import, Notebook & Security Scan
- `ruff check --select F,E9 <all Flow 2 Python files>`: `All checks passed!`
- `from app.sever import app`: `viread_training_routes: 38` (exit code 0)
- Notebook JSON parse (`ai/vietocr_v2/viread_vietocr_v2_colab_worker.ipynb`): valid JSON (`2` cells).
- `git diff main -- backend/requirements.txt`: **empty (0 lines changed)**.
- Secret & paid-GCP endpoint regex scan across all Flow 2 files: **0 hits**.

---

## 3. Explicitly `BLOCKED` Items (Honest Live Verification Boundaries)

| Blocked Item | Empirical Evidence | Minimal Admin Action Required to Unblock |
|---|---|---|
| **1. Live Google Drive OAuth & Real Folder Self-Test** | `VIREAD_GDRIVE_env_count: 0` on local machine; requires Admin Google Cloud OAuth 2.0 Web Client credentials (0 VNĐ, no billing) and interactive browser consent (`drive.file`). | Create free OAuth 2.0 Client in Google Cloud Console (no billing), set `VIREAD_GDRIVE_*` env vars, click **Kết nối Google Drive** -> **Chạy Self-Test** in `/admin/viread-training`. |
| **2. Live GPU Training & Real VietOCR Checkpoint** | `nvidia-smi` reports `NVIDIA GeForce GTX 1650 with Max-Q Design, 4096 MiB` (< `6144 MiB` safe VRAM threshold; verified safely rejected by `test_gtx1650_4gib_vram_is_safely_rejected_for_local_training`). | Open `ai/vietocr_v2/viread_vietocr_v2_colab_worker.ipynb` in Google Colab Free with T4 GPU (`15 GiB VRAM`) once >= 100 Admin-verified samples (+ >= 200 pairs / >= 30 book groups for Locked Test) exist. |
| **3. Production Supabase DDL Migration & Deployment** | Rule I.3 strictly prohibits applying DDL migrations or deploying to production without explicit Admin approval. | Review PR & `supabase/migrations/20261121210000_flow2_google_drive_storage.sql`, apply on staging first, then approve production rollout. |

---

## 4. Defects Found During Testing & Self-Healing Fixes

1. **`colab_worker.py:578` pre-existing `gate_status` bug:** Checked `report.get("gate_status")` (always `None`) instead of `report["gate"]["status"]`, causing passing `V2_WIN` benchmarks to report `REJECTED`. Fixed + regression test added (`test_v2_win_benchmark_reports_benchmarked_status_not_rejected`).
2. **`colab_state_store.py:384` Windows `os.fsync` on read-only fd (`Errno 9`):** Copying then reopening `"rb"` for `fsync` failed on Windows. Fixed by streaming into `"wb"` (`shutil.copyfileobj` -> `flush()` -> `os.fsync()`).
3. **`viread_ocr_outbox_worker.py` `main`-schema compatibility:** Concurrent WIP added `b.visibility_scope` which does not yet exist on `main`. Converted to `LEFT JOIN public.books` + `to_jsonb(b) ->> 'visibility_scope'`, preserving `PARENT_PRIVATE_BOOK_EXCLUDED` when the column exists while remaining 100% compatible with `main` when absent. Verified by `test_outbox_visibility_scope_supports_main_schema_and_blocks_parent_private`.
4. **Round 3 Red-Team CRITICAL/HIGH defects (`C1`, `H1`, `H2`, `CRIT-01..05`, `HIGH-01..09`):** All fixed and re-verified green in this final run (detailed in [`final-audit.md`](./final-audit.md)).
