# DEPLOYMENT PROGRESS — ViRead Zero-Cost Optimal Architecture & Release Candidate

- **Target Worktree:** `F:\c1\capstone1-rc-zero-cost`
- **Branch:** `feat/viread-rc-zero-cost-20261125`
- **Remote Base (`origin/main`):** `94fffd29e3bcef81c034f4ec4db65b9120b686f2`
- **Merged Staging (`feat/viread-staging-release-20261124`):** `c42f10e3e81079bc0a53a7313cd0bdd6b6f69a01`
- **Pre-Fix Integration Baseline SHA:** `d5eee4dc907d81b737b53da08c916b1b4ba095d3`
- **Committed RC Code & Research SHA (`Commit 1`):** `f6d2d96ddef994c61a78df47c8fcea9ccdb83400`
- **Preserved Worktrees:**
  - `F:\c1\capstone1` (`HEAD=33d12e2d3f4bce05edff1e1d53a70d466c398d8f`, dirty local worktree preserved untouched)
  - `F:\c1\capstone1-staging-release` (`HEAD=c42f10e3e81079bc0a53a7313cd0bdd6b6f69a01` preserved untouched)
- **Production Targets (UNMODIFIED — Awaiting Owner Gate Approval):**
  - Frontend: `https://viread-frontend.vercel.app`
  - Backend: `https://capstone1-ssd8.onrender.com`
  - Supabase (`akjxbkakbbabpblmsktm`, `ap-south-1`, PG `17.12`): `33.57 MB / 500 MB` DB, `231.6 MB` Storage (`887` objects across `4` private buckets), `books.deleted_at = true`, `ocr_inference_jobs = false` (`pending`), `active_books = 11`, `deleted_books = 1`, `private_books = 3`, `checking_submissions = 0`.

## Completed Milestones (`2026-11-25`)
1. **Isolated Integration & Scoped Porting (`d5eee4dc`):** Merged `origin/main` (`94fffd29`) + `c42f10e3` (`0` conflicts) and ported scoped clean hunks from `F:\c1\capstone1` (`local_voice_worker_bootstrap.py`, `/my-books/paged`, `voice` pooling, `pagination-bar.tsx`, `responsive-table.tsx`, `use-reading-auto-scroll.ts`) with `0` diff to `backend/requirements.txt` and `backend/app/sever.py` filename preserved.
2. **Backend, Worker & Security Hardening:** Decoupled `parent_book_submission`, `viread_ocr_outbox`, and `viread_ocr_training` from `remote_ocr_mode`; added `worker_telemetry.py` (`queue_depth`, `last_success_at`) & removed false-green health checks; added soft-delete `409` fencing & tenant-safe OCR cache; added `--once` + advisory locks + `/internal/cron/dispatch` + cardless `infra/cloudflare-cron/`; stripped `<pad>`/`<sos>`/`<eos>`/`<unk>` in OCR; added `rate_limiter.py` (`429`), `12 MB` `413` `match-page` limit, `Active==1` on `/voice/*` & `/support/feedback` (`10s` `role_cache` + deactivation invalidation), deduplicated OpenAPI (`235` paths, `0` warnings), proxyless signed URLs (`SourceStoragePath` fix), MP3/Opus audio negotiation (`500 MB` LRU), JPEG `q=85` rasterizer default, and hardened `ocr_worker/Dockerfile`.
3. **Frontend & Android Hardening:** Added Next.js security headers + CSP, `auth/callback` origin allowlist, `/admin/health` worker cards, VAD/pause-gated interim STT throttling, `tts-audio-format.ts` MP3/Ogg client preference, and `android/OFFLINE_POC_ARCHITECTURE.md`.
4. **Empirical Benchmarks & Live PG16 Drills:** Completed ONNX OCR Experiment A (`1,413.5 MB` peak RSS -> `viable_1gb=false`, `10/10` SHA parity, `-49.8%` latency), WSL2 Linux `ocr_worker` Experiment B (`5/5 OK`, `1,259–1,438 MB`), JPEG `q=85` Experiment C (`-62%..-90.4%` bytes, CER `0.017001`), Voice Experiment D (`int8`/`fp32`/`hybrid`/MP3/Opus + 5 Topologies), and PG16 `40/40` migrations (`0.67s` dump, `15.933s` restore, `0.100s` job drain).
5. **Post-Red-Team Fixes & Final Verification Gate:** Fixed `admin_ocr_service.py:2851` `ON CONFLICT ... WHERE event_type = 'VERIFIED_REVISION'` (`5/5` PG16 pass), `test_admin_ocr_postgres_integration.py` stub setup, `infra/cloudflare-cron/` `*/30` + `90s` timeout, `role_cache.py` `10s` TTL, and `reading_content_service.py:1233` extra `book_by_id` query -> verified **`1,486 passed` DB-free pytest**, **`16/16` clean-process security/worker**, **`5/5` Py3.12 `ocr_worker`**, **`18/18` Py3.12 rasterizer/camera OCR**, **Vitest `184/184` (`2,614 passed | 1 skipped`)**, **`next build` `39/39`**, **`android/scripts` `18/18`**, **Gradle `BUILD SUCCESSFUL (37 tasks)`**, and **`0` secrets** across all 23 deliverables (`01`..`23`) + [RELEASE_GATE.md](file:///F:/c1/capstone1-rc-zero-cost/RELEASE_GATE.md).
6. **Live Isolated Staging & Hardware Inspection:** Verified live staging stack (`13000`/`18000`/`18010`/`18020`/`55433`) via `/browser` (Admin `/health`, `/admin/books`, Parent A `/my-books`, `/books` — interrupted before reading/mobile UI by `BROWSER_HOST_UNAVAILABLE`) + direct HTTP/API checks (5 security headers, Parent B `404` isolation, session start/reload, MP3 TTS `200`). Read-only ADB inspected `Honor X9d` (`MTN-NX1`, `ATSYVB6205006984`, Android 16, `vn.viread.android 0.1.0`, WebView `157.0.8103.50`).

## Pending Owner Approval Gate
- Production migration `20261124010000_ocr_inference_jobs.sql`, Render/Vercel/Cloudflare Cron deploy, and live `Honor X9d` RC acceptance await explicit Owner sign-off in [RELEASE_GATE.md](file:///F:/c1/capstone1-rc-zero-cost/RELEASE_GATE.md).
