# 22 — Research Limitations, Unverified Boundaries & Blocked Scope

> **Author:** `@independent-red-team`  
> **Audit Date:** `2026-11-25`  
> **Scope:** Explicit, honest inventory of every limitation, unexecuted check, corpus boundary, and hardware/tier block in `F:\c1\capstone1-rc-zero-cost`.

---

## 1. Human & Child Evaluation Limitations

1. **Zero Real 6–7-Year-Old Child Speech Samples (`G07 UNVERIFIED`):**
   - `exp_d_voice_and_topologies.json` evaluated `18` clips from `audio_corpus_manifest.json` (`mean_wer=0.2624`) plus synthetic VieNeu TTS roundtrips across 8 regional voices and 17 minimal pairs.
   - **Zero** live child recordings (soft volume, hesitation, disfluencies, Northern/Central/Southern child accents, classroom/living-room background noise) were tested due to child privacy constraints. Actual Grade-1 child WER may be materially higher than adult `0.09–0.18` (and Central synthetic voices already hit `0.45–0.64` WER).

---

## 2. Hardware, Device & Runtime Environment Limitations

2. **Physical `Honor X9d` (`MTN-NX1`) Live RC Origin E2E Not Executed (`G12 BLOCKED`):**
   - Device **was** physically detected via ADB (`ATSYVB6205006984`, Android `16`, `arm64-v8a`, `7.29 GiB` RAM), and the installed APK (`vn.viread.android 0.1.0`, `2.1 MB`, `NO_NATIVE_LIBS`) was audited (`exp_d_voice_and_topologies.json`).
   - However, **live end-to-end reading, mic `getUserMedia`, `audio/mpeg` WebView playback, camera scan, and OAuth `viread://auth/callback` on the RC origin were NOT executed on the device** during this RC audit.
3. **Docker Build & `aarch64` Runtime Not Executed Directly (`G08 Partial`):**
   - Windows laptop lacks Docker Desktop, so `ocr_worker/Dockerfile` (`USER appuser`, `read_only`, `cap_drop: [ALL]`, `--no-deps`, sole `opencv-python-headless`) was **inspected in source and parity-tested in WSL2 Ubuntu `26.04.1` `x86_64` venv** (`Ran 5 tests in 34.945s — OK`, `maxrss=1,438.39 MB`), **not** via `docker compose up --build`.
   - `linux_aarch64` (`Oracle A1`) remains **UNVERIFIED** for `ocr_worker` (`paddlepaddle==2.6.2` missing on PyPI) and `voice_worker` (`VieNeu` / `sherpa-onnx` NEON latency).
4. **Option 7 (`Owned Linux Mini-PC`) & Option 6B (`Leapcell 4 GB`) Not Physically Deployed:**
   - Option 7 is grounded in WSL2 Ubuntu `x86_64` OCR measurements and PG16 drills, not a 72-hour soak on a physical mini-PC with `systemd` + mini-UPS + Named Tunnel.
   - Option 6 ONNXRuntime OCR (`1,413.50 MB` peak RSS) was measured in local Python 3.12 (`exp_a_onnx_vs_stock.json`), not packaged into a Leapcell `4 GB` serverless HTTP service.
5. **Option 5 (`Browser WASM sherpa-onnx STT + Precomputed MP3 + Catalog CDN`) Not Implemented in RC:**
   - Browser WASM RAM (`~100–200 MB`), `45 MB` model cache UX, `'wasm-unsafe-eval'` / `COOP` / `COEP` headers, batch catalog MP3 pre-synthesis, and switching `book_service.py` / `reading_content_service.py` away from `?token=` signed URLs are **design/cost projections (`DOCUMENTED BUT NOT TESTED`)**, not runnable RC features.

---

## 3. Test, Database & Staging Deployment Limitations

6. **Remaining PG16 Test-Fixture Failure (`test_admin_ocr_postgres_integration.py` `4/5`):**
   - While `159` isolated PG16 tests passed with `0` DB skips, `test_api_supports_two_edit_cycles_and_history_remains_immutable` in `test_admin_ocr_postgres_integration.py` failed (`NotNullViolationError: null value in column "revisionno"`) against a full migrated PG16 DB (`09_FUNCTIONAL_REGRESSION_RESULTS.md:18`), and `test_admin_ocr_postgres_integration.py` relies on `APP_ENVIRONMENT="test"` being set before import to avoid `role_cache.py`'s `60s` TTL interference.
7. **Live Cloud RC Deployment & Browser E2E Pending:**
   - All RC code checks ran locally against isolated mocks, Python 3.12 runtimes, WSL2, and disposable local PG 16.4 (`55432`/`55439`/`55447`).
   - Production Supabase (`akjxbkakbbabpblmsktm`) does **not** yet have `20261124010000_ocr_inference_jobs.sql` applied, Render (`capstone1-ssd8.onrender.com/health`) timed out at baseline, and **live `/browser` E2E on the isolated RC staging stack has not yet completed** at the time of this report.
8. **Host Contention Caveats in Timing Benchmarks:**
   - Experiment C (`JPEG q=85` vs `PNG`) latency (`21.3s` vs `34.5s` P50) ran concurrently with background host workloads, and auditor re-verification hit transient Windows `FreeVirtualMemory = 561 MiB` exhaustion (`MemoryError` / `cv::OutOfMemoryError`) during peak parallel swarm execution before passing cleanly once memory freed. Size (`-90.42%` / `-62.01%`), CER/IoU, and RAM measurements remain deterministic.
9. **Supabase Free Tier Platform Hard Limits:**
   - Leaked Password Protection remains `BLOCKED` (Pro plan required); zero automated PITR/daily backups exist on Supabase Free (`pg_dump` drill `0.67s` / restore `15.933s` proves external backup mechanics only).
