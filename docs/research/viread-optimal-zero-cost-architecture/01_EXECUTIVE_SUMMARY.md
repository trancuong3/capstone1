# 01. Executive Summary — ViRead Optimal Zero-Cost Architecture & Release Candidate

> **Assessment Date:** `2026-11-25`  
> **Integrated Worktree:** `F:\c1\capstone1-rc-zero-cost` (`feat/viread-rc-zero-cost-20261125` atop `d5eee4dc`, integrating `origin/main` `94fffd29` + `feat/viread-staging-release-20261124` `c42f10e3` + scoped `F:\c1\capstone1` dirty hunks)  
> **Preserved Worktrees:** `F:\c1\capstone1` and `F:\c1\capstone1-staging-release` (`c42f10e3e81079bc0a53a7313cd0bdd6b6f69a01`) preserved untouched; `backend/requirements.txt` ABI pins (`0` diff lines) and `backend/app/sever.py` preserved verbatim; Production Render/Vercel/Supabase untouched.

---

## 1. Headline Determination (Honest Hard-Gate Verdict)

1. **`NO-GO` for "100% Zero-Cost 24/7 Cloud Production with Laptop Off":** Across **11 evaluated architectures (Options 1–8)** in [15_HARD_CONSTRAINT_GATE.md](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/15_HARD_CONSTRAINT_GATE.md), **0 of 11** simultaneously satisfy all 12 Hard Gates (`G01–G12`):
   - **Physical Container RAM Wall:** Even after exporting 3-engine OCR to pure `onnxruntime` CPU (`torch=false`, `paddle=false`, `-571.5 MB` init RSS), peak 2048px inference hits **`1,413.50 MB` RSS (`2,033.34 MB` Commit)** — rendering every free `256 MB–1 GB` x86 container mathematically unviable (`viable_512mb=false, viable_1gb=false`).
   - **Free 24/7 Host Blockers:** `ClawCloud Run` terminated `2026-06-30`; `Oracle A1` (`2/12 GB`) is `BLOCKED` by VN international card rejection, chronic `ap-singapore-1` capacity exhaustion, 7-day idle reclaim, and missing PyPI `linux_aarch64` `paddlepaddle==2.6.2` wheels.
   - **Economics:** Any `0 VND` Cloud Cash option running heavy OCR + Voice relies on owned hardware incurring VN EVN electricity (`~12k–335k+ VND/mo` laptop or `~22k–120k VND/mo` Linux Mini-PC); eliminating EVN and commercial ToS limits requires paid SG cloud (`Option 8`).
   - **Unverified Child Audio & Device E2E:** Real 6–7yo child speech remains **`UNVERIFIED`** (`0` recordings), 8-voice `int8` regional TTS `P95 = 3,645.30 ms > 2,000 ms`, and physical `Honor X9d` (`MTN-NX1`, `ATSYVB6205006984`, WebView `157.0.8103.50`, `2.1 MB` `NO_NATIVE_LIBS` APK) awaits post-deploy live E2E (`BLOCKED`).
2. **`GO FOR INTEGRATED RC MERGE & STAGING` -> `CONDITIONAL GO FOR OWNER-ATTENDED CAPSTONE DEFENSE (OPTION 1-HARDENED)`:**
   - **100% Feature & Quality Preservation:** Keeps all `22` feature groups (`F-01`–`F-22`), `235` OpenAPI paths (`0` duplicate warnings), `39` static + dynamic Next.js routes, `FLOW1_EXTERNAL_TRDG` (`200edce4...`, `10/10` SHA-256 parity in ONNX), `18/18` Python 3.12 OCR/rasterizer pass (`test_scenario_3` TIFF `<pad>` fixed!), and **`5/5` PG16 Admin OCR integration pass** (after fixing `admin_ocr_service.py:2851` partial-index `ON CONFLICT` & `reading_content_service.py:1233` extra `book_by_id` lookup).
   - **Egress & Security Hardened Inside Free Tier:** Proxyless signed URLs + MP3 TTS (`11.74x` smaller, identical WER) + VAD-gated STT (`-65%` inbound) + JPEG `q=85` (`-62.0%` to `-90.4%`, improved CER `0.017001`) fit **`Defense_Day Peak`** (`4.64 GB` Supa Uncached / `1.52 GB` Render) and **`10_DAU Typical`** (`1.24 GB` Supa / `0.73 GB` Render) cleanly at **`0 VND` Cloud Cash**.
   - **Recommended Evolution Paths:** **Option 7** (Owned Linux `x86_64` Mini-PC 24/7 + Option 6 ONNX OCR) for `0 VND` Cloud 24/7 laptop-off; **Option 5** (Browser WASM `sherpa-onnx` STT `34.22 MB` + Precomputed Catalog MP3 + B2 CDN) for `50_DAU` free scaling; **Option 8** (`Hetzner SG + Vercel Pro + Supabase Pro`, `~$51.50–$60/mo`) for commercial/school production.

---

## 2. Final Verification Scorecard (Executed Directly on RC Code)

| Gate / Runtime | Command & Exact Scope | Result | Timing |
|---|---|---|---|
| **OpenAPI & ABI Invariants** | `app.openapi()` (`-W error:Duplicate Operation ID`) + `requirements.txt` 0-diff + `app/sever.py` | **235 paths, 0 warnings** | `<2s` |
| **Backend Clean-Process Security & Workers** | `.venv` `unittest test_rc_security_cron_and_voice test_web_lightweight_startup` | **16 passed, 0 failed** | `19.94s` |
| **Backend Full DB-Free Suite** | `.venv` `pytest -q` (excl. 6 PG-fixture, 2 `test_url` karaoke PG, Py3.12 OCR & clean-process tests) | **1,486 passed, 82 skipped, 6,997 subtests, 0 failed** | `125.44s` |
| **PG16 Admin OCR Integration** | PG16 `55433` `pytest test_admin_ocr_postgres_integration.py -v` (post `:2851` fix) | **5 passed, 0 failed** | `32.71s` |
| **PG16 Core, Phase7, Karaoke, Contention & Drills** | Isolated PG16 `55432/55439/55447` + `40/40` migrations (`09`, `13`) | **155 passed (`0` skips)**; `pg_dump 0.67s`, restore `15.93s`, drain `0.10s` | `~778s` |
| **Python 3.12 Real OCR & Worker** | `ocr_worker.test_ocr_worker` + `test_mobile_camera_ocr_parity` + `test_document_rasterizer_and_upload` | **5/5 OK** (`31.29s`) + **18/18 OK** (`99.75s`) | `131.03s` |
| **WSL2 Ubuntu `x86_64` `ocr_worker`** | Non-root Dockerfile dependency parity (`opencv-python-headless` sole `cv2` owner) | **5/5 OK** (`1,259–1,438 MB ru_maxrss`) | `34.95s` |
| **Frontend Next.js 16 + Vitest** | `typecheck` + `lint` + `vitest --maxWorkers=2` + `next build` (`tsconfig.json` clean) | **tsc 0, lint 0 errs, 184/184 files (`2,614 passed \| 1 skipped`), 39/39 pages** | `~515s` |
| **Android Scripts & Gradle** | `android/scripts` `unittest` + `:app:testDebugUnitTest :app:lintDebug` | **18/18 OK** (`0.05s`) + **BUILD SUCCESSFUL (`37` tasks)** | `105s` |
| **Live Local Staging (`13000/18000`)** | Browser + HTTP/API against PG16 `55433` + Voice `18010` + OCR `18020` | Admin `/health` (21 cards) + `/books` + `/my-books` browser `200`; `5/5` headers; Parent B `404`; MP3 TTS `200` (`Browser UI mid-run host drop` -> Reading/Mobile UI interrupted) | Live |
| **Real Child Speech & Honor X9d Live RC** | `audio_corpus_manifest.json` (adult only) / ADB read-only inspect `ATSYVB6205006984` | **`UNVERIFIED`** (0 child clips) / **`BLOCKED`** (awaits HTTPS deploy URL) | N/A |

---

## 3. Deliverable Index (`01`–`23`)

All 23 numbered reports + 2 datasets + `benchmarks/` reside under `F:\c1\capstone1-rc-zero-cost\docs\research\viread-optimal-zero-cost-architecture\`, paired with root [RELEASE_GATE.md](file:///F:/c1/capstone1-rc-zero-cost/RELEASE_GATE.md) and [DEPLOYMENT_PROGRESS.md](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/DEPLOYMENT_PROGRESS.md).
