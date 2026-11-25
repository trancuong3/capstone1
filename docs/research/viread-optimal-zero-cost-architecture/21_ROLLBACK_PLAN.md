# 21. Zero-Data-Loss Rollback Plan & Verified Drill Evidence

> **Cutover Candidate:** `F:\c1\capstone1-rc-zero-cost` (`feat/viread-rc-zero-cost-20261125`)  
> **Rollback Baseline:** `origin/main` (`94fffd29e3bcef81c034f4ec4db65b9120b686f2` — already has catalog soft-delete `books.deleted_at`)

---

## 1. Empirically Verified Database & Queue Rollback Drills (`PG 16.4`)

Executed against an isolated 60-table migrated PG 16.4 cluster in [pg16_contention_and_drills.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/pg16_contention_and_drills.json):

| Drill Metric | Measured Value | Significance |
|---|---:|---|
| **`pg_dump` full backup** | **`0.67 s`** | Fast pre-cutover snapshot of full ViRead schema & seed |
| **`psql` full restore & table verification** | **`15.933 s`** (`60/60` tables, `4/4` `ocr_inference_jobs`, `integrity_match=true`) | Deterministic clean disaster recovery within `~16s` locally |
| **Active OCR job drain + rollback DDL (`2 -> 0` active jobs)** | **`0.100 s`** (`stuck_checking_count=0`) | Immediate fencing prevents split-brain writes on worker halt |

**Honest Unverified Cloud Timing Warning:** Live **Render Free rebuild timing** back to `backend/requirements.txt` (`~1.9 GB` unpacked Torch/Paddle wheels) and live **Vercel Instant Rollback** remain **`UNVERIFIED`** until executed on a staging/live cloud target (`"total rollback < 5 min"` is NOT assumed guaranteed if Render must reinstall `requirements.txt`). Keep a pre-built rollback branch or `requirements-web.txt`-compatible maintenance mode ready.

---

## 2. Immediate Rollback Triggers

Trigger rollback without hesitation if ANY occurs after approved cutover:
1. Supabase `/health` returns `database.status != healthy` (`> 3` checks) or migration `20261124010000_ocr_inference_jobs.sql` reports partial failure.
2. Parent/Admin authentication (`401`/`5xx`) or cross-family `404` / RLS ownership fails (`Parent B` accesses `Parent A` data).
3. Admin verify / OCR publish throws `5xx` (e.g., constraint/outbox error).
4. Voice `/voice/text-to-speech` or `/voice/speech-to-text` returns `503` while local `voice_worker.py` and `cloudflared` tunnel are confirmed running.
5. `ocr_inference_jobs` queue grows (`QUEUED` > 5m) while remote `ocr_worker` shows `ONLINE` heartbeat in `/admin/health`.

---

## 3. Ordered Zero-Data-Loss Rollback Steps (`1 -> 5`)

1. **Freeze Remote Workers & External Cron (Zero Split-Brain):**
   - Stop remote OCR worker cleanly via `scripts\windows\Stop-ViReadOcrWorker.ps1` and close tunnel via `scripts\windows\Stop-ViReadTunnels.ps1` (do **not** kill unrelated dev Voice Worker if separate).
   - Disable Cloudflare Workers Cron (`wrangler delete` or pause schedule in Cloudflare dashboard) so `/internal/cron/dispatch` stops firing.
2. **Instant-Rollback Vercel Frontend:**
   - **Vercel Dashboard -> `viread-frontend` -> Deployments -> Instant Rollback / Promote** prior production deployment (`94fffd29...`). Wait until `GET https://viread-frontend.vercel.app/login` returns `200`. (`viread_role_cache` HMAC cookies are cleanly ignored by older Next.js builds.)
3. **Rollback Render Backend (`capstone1-ssd8`):**
   - **Fastest (`~15–45s`):** Revert Render service setting (`VIREAD_OCR_MODE=local_inprocess`, `VIREAD_WEB_DISABLE_HEAVY_WORKERS=false`) **ONLY** if previous container still contains full `requirements.txt`; otherwise trigger Render **Rollback / Redeploy `94fffd29...`** with `pip install -r backend/requirements.txt` (`> 2–5 min` build hazard — watch health logs until `GET /health` returns `200`).
4. **Preserve Additive Supabase Schema & Drain In-Flight Jobs (NO Destructive Drop):**
   - `20261124010000_ocr_inference_jobs.sql` ONLY adds `public.ocr_inference_jobs` and `public.ocr_worker_heartbeats`; existing tables (`books`, `bookpages`, `pagerevisions`, `readingsessions`, `profiles`) are untouched.
   - Do **not** blindly run `DROP TABLE` during an incident. Cancel any stranded `QUEUED`/`CLAIMED` jobs cleanly:
     ```sql
     UPDATE public.ocr_inference_jobs
     SET status = 'CANCELLED', cancelled_reason = 'CUTOVER_ROLLBACK', updated_at = now()
     WHERE status IN ('QUEUED', 'CLAIMED', 'RUNNING', 'FAILED_RETRYABLE');
     ```
   - Export diagnostics before ever running `DROP TABLE IF EXISTS public.ocr_worker_heartbeats, public.ocr_inference_jobs;` after an incident postmortem.
5. **Preserve Local Worktrees & Dev Environments:**
   - Never run `git reset --hard` on `F:\c1\capstone1`; if `main` was merged on GitHub, revert via clean `git revert -m 1 <merge_sha>` on an isolated clone.
