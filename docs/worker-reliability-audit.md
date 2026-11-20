# Task 06 — ViRead worker reliability audit

Baseline: `70d75fff05a86d6e114efe3bd5fc1cee7579c385` (read-only GitHub + Render workspace ViRead inspection, 20 Nov 2026). No queues, providers, email, training or real jobs were executed.

## Deployment and entrypoints

Render workspace ViRead has **one** web service `capstone1`, entrypoint `cd backend && uvicorn app.sever:app --host 0.0.0.0 --port "$PORT" --workers 1`; **no separate Render background-worker or cron service** was reported. The latest deployment of the reviewed main commit was building during the read-only inspection, so no claim is made that its workers have become live.

| Worker | Entry point | Launch mode | Existing durability / constraints | Audit conclusion |
|---|---|---|---|---|
| Book content quality | `book_quality_worker.run_worker` | FastAPI lifespan unless `BOOK_QUALITY_SCAN_WORKER_ENABLED=false` | PostgreSQL scan leases, heartbeat every 30s, page progress, recovery | Startup wired, lifecycle not proof of healthy progress |
| Admin AI proofreading / safety | `admin_ai_workflow_worker.run_worker` | FastAPI lifespan unless `ADMIN_AI_WORKFLOW_WORKER_ENABLED=false` | PostgreSQL claim/lease and progress heartbeat, bounded concurrency; cancel releases claim | Startup wired; investigate stale heartbeat and provider stalls in later focused task |
| Verified OCR outbox | `viread_ocr_outbox_worker.run_worker` | FastAPI lifespan unless `VIREAD_OCR_OUTBOX_WORKER_ENABLED=false` | SKIP LOCKED, retry/dead-letter, 10-minute stale-claim reclamation | **Fixed absent in-flight lease heartbeat** for long Storage operations |
| OCR Flow2 training auto scheduler | `viread_ocr_training_auto_worker.run_worker` | FastAPI lifespan unless `VIREAD_OCR_AUTO_TRAINING_WORKER_ENABLED=false` | DB watermark / polling / guarded dispatch, external Colab operation needed | Scheduler present ≠ training completed; no dispatch attempted |
| Active-model registry watcher | `ocr_engine.run_active_viread_model_worker` | Dedicated daemon **thread inside FastAPI** | 300s poll by default, only after OCR dependencies have loaded | Startup wired; not a Render service |
| Local OCR trainer | `viread_ocr_local_training_worker` | Optional **subprocess started by FastAPI** only with both `VIREAD_LOCAL_TRAINING_ENABLED=true` and `VIREAD_LOCAL_TRAINING_WORKER_AUTOSTART=true` | GPU/capacity guard (CUDA), disabled if unsuitable | **Fixed inconsistent defaults**: app used to spawn by default although subprocess defaults to disabled; opt-in now explicit |
| Reading-reminder email | `reading_reminder_worker.run_worker` | **Standalone CLI only** | DB schedule/claim/retry and deterministic occurrence identifier; SMTP delivery remains at-least-once | **Not** started by FastAPI; no Render worker/cron found; no emails sent |
| Karaoke processing | `karaoke_processing_worker.main` | **Standalone CLI only** | DB lease tokens, heartbeat, retry policy, external provider, checkpoint ledger; `--once` mode | **Not** started by FastAPI; no Render worker/cron found; no karaoke jobs started |
| Local Ollama correction jobs | `admin_ocr_correction_jobs` | In-process request-oriented manager | Shutdown called from FastAPI lifespan | Not a dedicated polling Render worker |

## Confirmed bug: OCR outbox claim expiry while processing

`_claim_one()` reclaims `PROCESSING` rows after `locked_at` is older than **10 minutes**. Previously, `run_worker()` awaited `_process(event)`, which may perform Storage reads and multiple sequential uploads, **without refreshing locked_at**. Concurrent replicas could therefore both materialize an event. Existing `_finish` fencing on attempt generation and `ON CONFLICT DO NOTHING` in sample insertion reduce damage but do not prevent duplicate transfers or work.

The patch adds (1) bounded claim renewal every 60s, filtered by **id + PROCESSING + attempts**, (2) concurrent lease-loss watcher that cancels further materialization, (3) fenced release on observed loss and safe diagnostic logging, (4) cleanup/cancellation and regression tests. All sample upload paths and SQL semantics are unchanged. In-flight synchronous I/O in `asyncio.to_thread` cannot be forcibly killed; durable fencing limits database finalization but a single already-started upload may complete.

A second independently confirmed startup mismatch is also fixed: `app.sever.lifespan` used to default `VIREAD_LOCAL_TRAINING_ENABLED` and autostart to `true`, while `viread_ocr_local_training_worker._run` defaults the same training flag to `false`. The web process could thus spawn an immediately failing child by default. Both API-side flags now default **false**; explicit dual opt-in still starts the dedicated subprocess. Regression tests mock the subprocess and all workers.

## Scope / non-changes

- Do not treat a running asyncio task or thread as proof of queue throughput/heartbeat freshness.
- Do not enable dedicated email/Karaoke processes without authorized SMTP/provider/configuration and separate deployment plan.
- Do not auto-deploy, merge, run real jobs, call a paid Colab dispatcher or mutate production.
- Tests mock SQL/provider behavior and validate generated SQL predicates. GitHub Actions with a disposable database is the merge gate.

## Verification

```bash
cd backend
python -m unittest -v test_viread_ocr_outbox_worker test_server_lifespan_shutdown
python -m unittest discover -v
```

Review status of GitHub Actions on the **head commit**, not only older passing commits. Further changes to production worker deployment require explicit approval.
