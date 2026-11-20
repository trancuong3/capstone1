# Task 05 — Admin Health & Runtime Diagnostics

## Baseline

- Base `main`: `29a67b597893850719a98e4e18e8d6fd5e711d3b`.
- `runtime_configuration_diagnostics()` previously derived Tesseract and Vietnamese readiness from `find_spec("paddleocr") and find_spec("vietocr")`. This could report a missing binary/language pack as present.
- Admin Health only reported the API, PostgreSQL, local Ollama OCR, ElevenLabs TTS/STT. No independent Paddle/Viet/Tesseract or worker lifecycle evidence was shown.

## Changes

- Independent lightweight OCR runtime snapshot: `installed` (package exists), `initialized`, `loaded`, `failed`, `unknown`. **Never load PaddleOCR, PyTorch, VietOCR or checkpoint weights merely to open Health.**
- Tesseract executable resolved separately with `shutil.which()`; `--list-langs` subprocess (2-second timeout, 30-second cache) checks the `vie` language code rather than inferring it.
- Required response health `status` remains backward-compatible; optional `detail_status` communicates technical state. A cold but installed engine is `DEGRADED`, **not** `HEALTHY`.
- Added an admin-only snapshot of worker tasks/threads/process from the existing FastAPI lifespan application state. Disabled, failed and unknown states are explicitly distinguished. This is **not** proof that a worker is making progress or processing jobs.
- Bound OCR inspections, local Ollama, STT and TTS probes. Generic safe diagnostic messages never reveal env values, file paths or secrets.
- Supabase Storage has a separate **read-only HEAD /storage/v1/bucket/{bucketId}** metadata probe with a 2.5-second HTTP timeout and a 3-second caller limit. Status codes 401/403/404 and network errors do not leak keys, URLs or bucket identifiers. It never downloads, lists or changes Storage objects.
- Frontend now renders the technical state and explains its lightweight scope. Older API responses without `detail_status` remain accepted.
- Added backend regression tests for binary missing, language missing, subprocess timeout, lazy model uninitialized, worker states and safe errors, plus frontend tests for response contract and UI.

## Limits

- **Loaded does not prove inference correctness.** Scanned-page provenance and exact loaded SHA are handled by the separate OCR provenance task.
- Tesseract `--list-langs` demonstrates language pack discovery, not actual Vietnamese OCR accuracy.
- A Storage HEAD response validates access to bucket metadata only, not object-level read/write permissions or performance.
- Worker `running` is a process/task lifecycle state, not job freshness or database lease validation; Task 06 covers heartbeat and lease health.
- No production Supabase writes or Render deployments by this task. After PR approval/deployment, Admin Health may perform a metadata-only read request against the configured Storage bucket; no object content or secrets are returned.
- No branch merge or production deploy by this task.

## Suggested reproducible commands

```bash
cd backend
python -m unittest -v test_runtime_diagnostics test_admin_health_local_ocr
python -m unittest discover -v
cd ../frontend
npm ci
npx vitest run test/real-admin-services.test.ts test/real-admin-ui.test.tsx
npm run verify
npm run build
```

The PR's GitHub Actions must provide the authoritative pass/fail evidence; missing checks must be reported as blocked, not claimed as passed.
