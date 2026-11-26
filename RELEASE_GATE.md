# RELEASE GATE � ViRead Zero-Cost Production Release (eat/viread-zero-cost-production-20261125)

> **Release Gate Status:** `READY FOR OWNER REVIEW` � Zero-Cost Production Release (Option A: Browser WASM STT + TTS Cache + Local OCR Worker with Queue). PR #202 open at https://github.com/trancuong3/capstone1/pull/202
> **Last updated:** 2026-11-25 by Antigravity agent
> **HEAD:** `ec2f9dcf` (28 commits ahead of main)
> **Tests:** 2739 frontend PASS | 1528+ backend PASS | Build: 50 routes PASS

---

## 1. Release Candidate Provenance & Exact Cryptographic Hashes

- **RC Worktree / Branch:** `F:\c1\capstone1-rc-zero-cost` / `feat/viread-rc-zero-cost-20261125`
- **GitHub `origin/main` Base SHA:** `94fffd29e3bcef81c034f4ec4db65b9120b686f2`
- **Merged Staging SHA:** `c42f10e3e81079bc0a53a7313cd0bdd6b6f69a01`
- **Pre-Fix Integration Merge SHA:** `d5eee4dc907d81b737b53da08c916b1b4ba095d3`
- **Verified RC Code + Docs Commit SHA (`CODE_RC_SHA`):** `f6d2d96ddef994c61a78df47c8fcea9ccdb83400`

### Exact Lockfile & Active Model SHA-256 Checksums
| Artifact | SHA-256 Checksum | Notes |
|---|---|---|
| `FLOW1_EXTERNAL_TRDG` VietOCR Checkpoint | `200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6` | Verified unchanged (`10/10` SHA-256 ONNX parity in Exp A) |
| `backend/requirements.txt` *(ABI pins untouched: `0` diff lines)* | `D02E7CC677895E401ADB763CE961B2DBD31D449041965C02D6C34302E97227A1` | `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13` |
| `backend/requirements-web.txt` | `77626B4FDE208869E488BD49409DC726CB55CFF3CA58547978AE025F094A287B` | Excludes Torch/Paddle/VietOCR/Tesseract for `277.6 MB` Render Free RSS |
| `frontend/package-lock.json` | `35F34DFCA8CCB9ADD3EB6AB5CC564E3A45F83AA0B188B3DD708D92784B1B4B7A` | Identical to `F:\c1\capstone1\frontend\package-lock.json` |
| `ocr_worker/requirements.txt` | `FB1FF9FC3891F459B86221455A77B9F4D1FCA29AD4AF105973DA9C5171CECDF9` | Paired with non-root `USER appuser` & `--no-deps` `paddleocr==2.7.3` |

---

## 2. Redacted Configuration Diff & Supabase Migration State

### Redacted Environment Variable Diff (`Production 94fffd29` -> `RC f6d2d96d`)
*(Zero plaintext secrets — use `openssl rand -hex 32` separately per environment)*

| Service | Variable | Value / Setting in RC | Purpose |
|---|---|---|---|
| **Render API** | *Build Command* | `pip install -r backend/requirements-web.txt` | Drops heavy ML wheels from 512 MiB web container |
| **Render API** | `VIREAD_OCR_MODE` | `remote_worker` | Enqueues async OCR to `ocr_inference_jobs` |
| **Render API** | `VIREAD_WEB_DISABLE_HEAVY_WORKERS` | `true` | Runs only lightweight post-OCR, outbox & auto-training sweepers |
| **Render API** | `VIREAD_OCR_WORKER_TOKEN` | `<REDACTED_32+_CHAR_SECRET>` | Auth for `/internal/ocr-jobs/*` |
| **Render API** | `VIREAD_VOICE_WORKER_TOKEN` | `<REDACTED_32+_CHAR_SECRET>` | Auth for proxied Voice Worker requests |
| **Render API** | `VIREAD_CRON_DISPATCH_TOKEN` | `<REDACTED_32+_CHAR_SECRET>` | Constant-time auth for `POST /internal/cron/dispatch` |
| **Render API** | `VIREAD_LOCAL_VOICE_WORKER_URL` | `https://<REDACTED_TUNNEL_HOST>` | HTTPS Cloudflare Tunnel to Windows/Mini-PC `:8010` |
| **Render API** | `VIREAD_DOCUMENT_RASTER_FORMAT` / `JPEG_QUALITY` | `jpeg` / `85` *(default in RC code)* | `-62%..-90.4%` egress/storage reduction, CER `0.017001` |
| **Render API** | `VIREAD_ROLE_CACHE_TTL_SECONDS` | `10.0` *(default in RC code)* | Bounds multi-worker deactivation lag (`60s -> 10s`) |
| **Vercel Web** | `VIREAD_SSR_AUTH_SIGNING_KEY` | `<REDACTED_32+_BYTE_SECRET>` | HMAC-signed 30s SSR role cookie + request handoff |
| **CF Cron** | `VIREAD_BACKEND_URL` / `VIREAD_CRON_DISPATCH_TOKEN` | `https://capstone1-ssd8.onrender.com` / `<SECRET>` | `*/30 * * * *`, `90,000 ms` timeout |
| **Voice Worker** | `VIREAD_VOICE_TTS_PRECISION` | `int8` *(860 MB RSS; `fp32` 1,447 MB optional on 16 GB)* | Avoid `hybrid_word_fp32` (`1,901 MB` RSS) on tight RAM |

### Production Supabase (`akjxbkakbbabpblmsktm`, PG `17.12`) Migration Diff
- **Already Present on Production (`94fffd29`):** `20261124120000_soft_delete_catalog_books.sql` (`has_books_deleted_at = true`; `11` active books, `1` deleted book, `3` private books, `0` checking submissions).
- **Fixed Migration in RC (`40/40` Verified on Clean PG16):** `20261105072703_add_profile_avatar_storage.sql` (escaped `'parent''s'`).
- **Pending Production Apply (Requires Gate Sign-Off):**
  - `supabase/migrations/20261124010000_ocr_inference_jobs.sql` (strictly additive: creates `public.ocr_inference_jobs` and `public.ocr_worker_heartbeats` with `service_role` RLS).
  - Verify `20261122120000_parent_private_book_flow2_contribution.sql` (`uq_viread_ocr_outbox_verified_revision`) is active in sync with `backend/app/services/admin_ocr_service.py:2851`.

---

## 3. Exact Final Verification Evidence Ledger

| Check | Exact Scope & Conditions | Latest Observed Outcome | Date / Run Ref |
|---|---|---|---|
| **OpenAPI & ABI Guard** | `app.openapi()` (`-W error:Duplicate Operation ID`) + `requirements.txt` 0-diff + `sever.py` | **235 paths, 0 duplicate warnings, ABI untouched** | `task-873` (`post-final-edit`) |
| **Clean-Process Security/Workers** | `.venv` `unittest test_rc_security_cron_and_voice test_web_lightweight_startup` | **16 tests in 19.94s — OK (`torch` not imported)** | `task-873` (`post-final-edit`) |
| **Backend DB-Free Suite** | `.venv` `pytest -q` (excl. 6 PG-fixture, 2 `test_url` karaoke PG, Py3.12 OCR, clean-process tests) | **1,486 passed, 82 skipped, 6,997 subtests, 0 failed (`125.44s`)** | `task-873` (`post-final-edit`) |
| **PG16 Admin OCR Integration** | Live PG16 `55433` `pytest test_admin_ocr_postgres_integration.py -v` | **5 passed, 0 failed (`32.71s`)** *(only `reading_content_service.py` edited after)* | `task-637` |
| **PG16 Core / Phase7 / Karaoke / Drills** | Isolated PG16 `55432/55439/55447` (`40/40` migrations) | **155 passed (`0` skips)**; `pg_dump 0.67s`, restore `15.933s`, drain `0.100s` | `09`, `13` (pre-Step A docs) |
| **Python 3.12 Real OCR & Worker** | `ocr_worker.test_ocr_worker` + `test_mobile_camera_ocr_parity` + `test_document_rasterizer_and_upload` | **5/5 OK (`31.29s`)** + **18/18 OK (`99.75s`)** *(incl. TIFF `<pad>` fix)* | `task-652` (no OCR code edit after) |
| **WSL2 Ubuntu `x86_64` `ocr_worker`** | Hardened `Dockerfile` deps (`opencv-python-headless==4.10.0.84` sole `cv2` owner) | **5/5 OK (`34.95s`)**; `1,259–1,438 MB ru_maxrss` | `08`, `09` |
| **Frontend Next.js 16 + Vitest** | `tsc` + `eslint` + `vitest --maxWorkers=2` + `next build` (`tsconfig.json` clean) | **tsc 0 (`8.22s`), lint 0 errs (`101.66s`), 184/184 files (`2,614 passed \| 1 skipped`), 39/39 static pages** | `task-652`, `task-809`, `task-873` |
| **Android Scripts & Gradle** | `android/scripts` (`unittest`) + `:app:testDebugUnitTest :app:lintDebug` | **18/18 OK (`0.047s`)** + **BUILD SUCCESSFUL in 1m 45s (`37` tasks)** | `task-833`, `task-873` |
| **Live Local Staging (`13000/18000`)** | PG16 `55433` + Voice `18010` + OCR `18020` + Next `13000` | Browser (`BROWSER_HOST_FACTS`): Admin `/login`, `/admin/health` (21 cards), `/admin/books`, Parent A `/my-books`, `/books` **`PASS`** *(Reading/Parent B/390x844 UI interrupted by `BROWSER_HOST_UNAVAILABLE`)*. HTTP/API: `5/5` security headers, Parent B `404` isolation, session persist `200`, MP3 TTS `200 (12,524 B)` **`PASS`**. | `BROWSER_HOST_FACTS`, `staging_harness` |
| **Honor X9d (`ATSYVB6205006984`)** | Read-only ADB check (`dumpsys package` & `webviewupdate`) | `MTN-NX1`, Android `16`, `arm64-v8a`, `vn.viread.android 0.1.0` (`2.1 MB`, `NO_NATIVE_LIBS`), WebView `157.0.8103.50`. Live RC origin E2E **`BLOCKED`** pending deploy URL. | ADB output |
| **Secret Hygiene Regex Scan** | Regex scan across `git diff d5eee4dc`, untracked files & all 23 docs | **`0` matches** (`AIza`, `sk-`, `gsk_`, `eyJ`, `sb_secret_`, `AKIA`, `PRIVATE KEY`) | Automated scan |

---

## 4. Honest Unverified / Blocked Boundaries

1. **Real 6–7-Year-Old Vietnamese Child Speech (`UNVERIFIED`):** Zero child audio recordings tested; 8-voice `int8` regional TTS `P95 = 3,645.30 ms` exceeds `<= 2,000 ms`, `int8` isolated minimal pairs score `7/17`, and Central voices score `0.45–0.64` WER on Zipformer STT.
2. **Simultaneous 0-VND 24/7 Laptop-Off Cloud (`NO-GO`):** `0/11` architectures pass all 12 Hard Gates simultaneously (`1,413.5 MB` ONNX OCR RAM wall vs `512 MB–1 GB` free cloud, EVN cost `~12k–335k+ VND/mo` laptop / `~22k–120k VND/mo` Mini-PC, commercial Vercel Pro `$20/mo` ToS).
3. **Physical Honor X9d Live RC E2E & Mobile `390x844` DOM (`BLOCKED` / `INTERRUPTED`):** `webview_browser` host dropped mid-run before Reading & `390x844` DOM measurement (prior `c42f10e3` staging verified `maxRight=359.2px <= 392px` on unchanged layout); physical `Honor X9d` HTTPS test awaits approved deploy URL.
4. **Live Cloud Rollback Timing (`UNVERIFIED`):** Local PG16 drills are fast (`0.67s` dump, `15.933s` restore, `0.100s` drain), whereas Render Free rebuild back to full `requirements.txt` (`~1.9 GB` ML wheels) is unmeasured (`> 2–5 min` risk).

---

## 5. Production Cutover Canary & Owner Approval Gate

**Deployment Sequence (Execute ONLY After All Sign-Off Boxes Checked):**
1. Backup Prod Supabase `akjxbkakbbabpblmsktm` (`pg_dump`) -> apply `20261124010000_ocr_inference_jobs.sql`.
2. Deploy Render (`requirements-web.txt`, `VIREAD_OCR_MODE=remote_worker`, `JPEG_QUALITY=85`) -> verify `GET /health` `200`.
3. Deploy Vercel (`sin1`, `VIREAD_SSR_AUTH_SIGNING_KEY`) -> verify `HEAD /login` `200` + all 5 headers.
4. Deploy `infra/cloudflare-cron/` (`*/30`, `90s` timeout) with `VIREAD_CRON_DISPATCH_TOKEN`.
5. Start Windows/Mini-PC `voice_worker.py` (`int8` + tunnel) and `ocr_worker` (`threads=2`) -> run 15-minute Canary (`/admin/health`, 1 private-book OCR, cross-family `404`, MP3 TTS `200`, and live `Honor X9d` check).

### Explicit Production Approval Sign-Off (Owner Required)
- [ ] **Architecture Mode Approved:** Option 1-Hardened (Owner-Attended Capstone Defense) / Option 7 (Mini-PC 24/7) / Option 8 (Paid SG Cloud)
- [ ] **Approved Target Commit SHA:** `f6d2d96ddef994c61a78df47c8fcea9ccdb83400` *(or final Commit 2 RC SHA after docs)*
- [ ] **Approved Scope:** Merge to `main` / Apply Supabase DDL (`20261124010000_ocr_inference_jobs.sql`) / Configure Render & Vercel Env / Deploy CF Cron
- [ ] **Accepted Risk Disclosure:** Laptop-off returns `503` on Voice & queues OCR (under Option 1-Hardened); Supabase Free LPP disabled; real 6–7yo child voice accuracy unverified until live pilot; `Honor X9d` verification required in 15m canary.

