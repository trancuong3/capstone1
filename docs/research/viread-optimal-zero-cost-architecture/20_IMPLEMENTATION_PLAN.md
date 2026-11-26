# 20. Implementation & Cutover Plan (Staging Verified -> Approved Production Release)

> **Rule of Execution:** Staging infrastructure and isolated checks run freely under 0-VND budgets. **Production changes (`git push` / `main` merge / Vercel / Render / Supabase DDL / DNS / APK distribution) MUST WAIT FOR EXPLICIT OWNER APPROVAL** of the exact RC SHA and `RELEASE_GATE.md` checklist.

---

## Phase 0 — Completed in `F:\c1\capstone1-rc-zero-cost` (`feat/viread-rc-zero-cost-20261125`)

1. Cleanly integrated `origin/main` (`94fffd29`, soft-delete catalog books + PR #196/#197) + `feat/viread-staging-release-20261124` (`c42f10e3`) -> baseline `d5eee4dc`, then ported clean hunks from `F:\c1\capstone1` (`0` edits to `capstone1` / `capstone1-staging-release`, `requirements.txt` ABI pins untouched, `app.sever:app` preserved).
2. Implemented all zero-cost egress, decoupling, worker, and security hardening:
   - Proxyless signed URLs (`book_access.py`, `sub.SourceStoragePath` fix), JPEG `q=85` rasterizer default, `audio/mpeg` + `audio/ogg` TTS negotiation (`500 MB` LRU), VAD-gated STT throttling.
   - Rate limiting (`429`), `12 MB` `413` `match-page` bound, `Active==1` enforcement on `/voice/*` & `/support/feedback` (`10s` `role_cache` + deactivation invalidation), Next.js security headers + CSP, `auth/callback` origin allowlist, `0` duplicate OpenAPI routes (`235` paths).
   - Decoupled `parent_book_submission`, `outbox`, and `auto_training` workers from `remote_ocr_mode`; added `/internal/cron/dispatch` + cardless `infra/cloudflare-cron/` (`*/30`, `90s` timeout); fixed `admin_ocr_service.py:2851` `ON CONFLICT ... WHERE event_type = 'VERIFIED_REVISION'` bug on live PG16 (`5/5 PASS`).
   - Hardened `ocr_worker/Dockerfile` (`USER appuser`, CPU PyTorch, `--no-deps`, sole `cv2` owner verified in WSL2).

---

## Phase 1 — Pre-Cutover Owner Actions (Staging Verification -> Approval Sign-Off)

1. **Inspect Production Supabase Read-Only Schema Diff (`akjxbkakbbabpblmsktm`):**
   - Already present: `20261124120000_soft_delete_catalog_books.sql` (`books.deleted_at = true`).
   - **Pending migration:** `supabase/migrations/20261124010000_ocr_inference_jobs.sql` (additive `ocr_inference_jobs` & `ocr_worker_heartbeats`). Also confirm `20261122120000_parent_private_book_flow2_contribution.sql` (`uq_viread_ocr_outbox_verified_revision`) is applied cleanly alongside `admin_ocr_service.py:2851`.
2. **Collect Backup Snapshot:** Run `pg_dump` before applying Production DDL (baseline drill: `0.67 s` dump / `15.933 s` restore verified locally).
3. **Provision Staging/Canary Secrets (Zero Overlap with Production):**
   - Dedicated `VIREAD_OCR_WORKER_TOKEN` (`>= 32 chars`)
   - Dedicated `VIREAD_VOICE_WORKER_TOKEN` (`>= 32 chars`)
   - Dedicated `VIREAD_CRON_DISPATCH_TOKEN` (`>= 32 chars`)
   - Dedicated `VIREAD_SSR_AUTH_SIGNING_KEY` (`>= 32 bytes`)
4. **Decide Tunnel Strategy for Defense:**
   - Default `0 VND` ephemeral: `scripts\windows\Start-ViReadTunnels.ps1` (`*.trycloudflare.com` Quick Tunnel; update `VIREAD_LOCAL_VOICE_WORKER_URL` on Render whenever restarted).
   - Optional stability upgrade (`$0` Student Pack Year 1 / `~25k/mo` domain): Cloudflare **Named Tunnel + Access/Origin Token**.

---

## Phase 2 — Approved Production Cutover Sequence

1. **Database First (`Additive Only`):** Apply `20261124010000_ocr_inference_jobs.sql` to Production Supabase (`akjxbkakbbabpblmsktm`) via reviewed SQL Editor/CLI and confirm both tables + RLS policies exist.
2. **Backend (Render `capstone1-ssd8`):**
   - Switch Build Command to `pip install -r backend/requirements-web.txt`.
   - Configure env vars: `VIREAD_OCR_MODE=remote_worker`, `VIREAD_WEB_DISABLE_HEAVY_WORKERS=true`, `VIREAD_OCR_WORKER_TOKEN=<secret>`, `VIREAD_VOICE_WORKER_TOKEN=<secret>`, `VIREAD_CRON_DISPATCH_TOKEN=<secret>`, `VIREAD_LOCAL_VOICE_WORKER_URL=<https://...>`, `VIREAD_DOCUMENT_RASTER_FORMAT=jpeg`, `VIREAD_DOCUMENT_RASTER_JPEG_QUALITY=85`.
   - Trigger Render deploy from approved RC SHA and verify `GET /health` returns HTTP `200`.
3. **Frontend (Vercel `viread-frontend`):**
   - Verify `vercel.json` pins `regions: ["sin1"]` and configure `VIREAD_SSR_AUTH_SIGNING_KEY`.
   - Deploy approved RC SHA and verify `HEAD /login` returns HTTP `200` + all 5 security headers (`CSP`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`).
4. **Cardless Cloudflare Cron (`infra/cloudflare-cron/`):**
   - `npx wrangler secret put VIREAD_CRON_DISPATCH_TOKEN` -> `npx wrangler deploy` (with `VIREAD_BACKEND_URL=https://capstone1-ssd8.onrender.com`).
5. **Compute Workers (Owner Laptop or Option 7 Linux Mini-PC):**
   - Start `voice_worker.py :8010` (`int8` default; `fp32` optional on `16 GB`; verify TTS MP3/Opus `Accept` works).
   - Start `ocr_worker :8020` (`--backend-url https://capstone1-ssd8.onrender.com`, Python 3.12, `VIREAD_OCR_CPU_THREADS=2`, `BelowNormal`) -> confirm `win-ocr-...` appears `Bình thường` in `/admin/health`.
6. **Canary Smoke Check (`15 Minutes`):** Admin `/admin/health` (`200`), catalog browse + reading start + MP3 TTS (`200 audio/mpeg`), 1 parent private-book page OCR (`SUCCEEDED`), cross-family `404` isolation, and **live `Honor X9d` (`vn.viread.android`) E2E** against `https://viread-frontend.vercel.app`.

---

## Phase 3 — Post-Defense Evolution Paths

- **Path A (`0 VND` Cloud 24/7 -> Option 7):** Move `ocr_worker` (`ocr_worker/docker-compose.yml` + Option 6 ONNX export `-49.8%` latency) + `voice_worker` + Ollama CPU onto an always-on Linux `x86_64` Mini-PC (`22k–120k VND/mo` EVN).
- **Path B (`50_DAU` Scale -> Option 5):** Implement browser `sherpa-onnx` WASM STT (`34.22 MB` opt-in Web Worker), batch precompute catalog `audio/mpeg`, and move static catalog assets to public/Backblaze B2 CDN (`37.8x` Render bandwidth savings).
- **Path C (Commercial Launch -> Option 8):** Upgrade to Vercel Pro (`$20/mo`) + Supabase Pro (`$25/mo`, LPP + daily backups) + Hetzner SG `4–8 GB` (`$6.50–$15/mo`).
