# Backend invariants

- Entrypoint is `backend/app/sever.py` (`app.sever:app`); never rename it to `server.py`.
- For new or deliberately refactored backend flow, follow `BACKEND_FLOW_STANDARD.md`: Router → Schema → Service → Repository → Model/ORM → PostgreSQL. First trace the actual imports/calls. Do not widen a focused fix into an unrelated architecture refactor merely to enforce the standard; preserve existing API behavior unless the task asks for architectural change.
- Preserve locked OCR ABI pins in `requirements.txt` unless the task explicitly changes them: `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`.
- Keep heavy OCR imports lazy/guarded in `app/services/ocr_engine.py`; map external-provider failures to safe application errors.
- Supabase service-role/secret keys stay backend-only; store relative object paths, not signed URLs. Never send `Authorization: Bearer <sb_secret_*>` on raw Supabase HTTP calls (`app.database.config.supabase_admin_headers()` omits Bearer for opaque `sb_secret_` keys and keeps it only for legacy JWTs).
- Flow 2 Admin-verified training data must pass `app/services/viread_flow2_hygiene.py` (exact 229-char locked VietOCR vocab, NFC + `Cf` strip, typographic punctuation normalization, EXIF-safe crops, contrast/sharpness/density/geometry bounds, strict human-admin provenance).
- Cloud/Render deployments must use Apps Script Bridge (`apps_script_bridge`) rather than `drive_desktop_sync` (`G:\`), and `VIREAD_LOCAL_TRAINING_ENABLED` defaults to `false`.
- Do not use session-level `pg_try_advisory_lock` over Supavisor transaction pooling (`port 6543`); coordinate workers in a single `AsyncSessionLocal` with `FOR UPDATE SKIP LOCKED` / `ON CONFLICT DO NOTHING`, and pass `statement_cache_size=0` in ad-hoc asyncpg engines.
- Snapshot ORM scalar fields into plain objects/variables and release read transactions (`rollback()` / `_release_db()`) before external HTTP/SMTP/Auth calls to prevent `MissingGreenlet` and `QueuePool` exhaustion.
- In `cron_dispatch_service.py` and `parent_email_notification_service.py`, run fast DB sweeps before slow outbound sweeps, batch worker heartbeats (`persist_worker_heartbeats_batch`), and run `expire_stale_retries` before quiet-hours gating so superseded `INACTIVITY_ALERT` retries expire to `SKIPPED` (`CHILD_ACTIVITY_RESUMED`).
