# ViRead: real-photo OCR acceptance and remote worker rollout

**Status:** Stage A benchmark runner prepared; no photographed-book acceptance and no remote worker deployed. This change is non-production and does not alter OCR models, database schema, API, RLS, or frontend.

## Observed baseline (21 November 2026)

- On a Windows 64-bit laptop with GTX 1650 Max-Q, PyTorch 2.14.1+cu126, PaddlePaddle 2.6.2 CPU, PaddleOCR 2.7.3 and VietOCR 0.3.12 can run the existing dual-engine OCR pipeline.
- Local 2-line smoke test: paddleocr=success, vietocr=success, tesseract=success, VietOCR profile FLOW1_EXTERNAL_TRDG, checkpoint SHA256 200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6, PyTorch max allocated 292.6 MiB. This is not the machine's total GPU memory.
- VIREAD_REAL_OCR_GATE=1 completed 14/14 mandatory **synthetic** real-engine tests without skips in 389.687 seconds. No real book photographs were supplied or approved. Do not represent the synthetic gate as acceptance for real-world photography.
- Import PyTorch before Paddle on this Windows system to avoid the observed shm.dll error. Do not disable Windows Smart App Control to force the separate Paddle GPU 2.6.2 wheel to load.

## Stage A: privately benchmark photographs with independently verified ground truth

1. Store 10–30 diverse real book page photographs **outside the Git repository** (permissions/ownership checked): clean, slanted, low light, illustrated, small Vietnamese diacritics, dialogue, children's fonts.
2. Type exact ground truth by hand from the source images. Never derive ground truth from the model's OCR output. Double-check marks and punctuation. One JSONL row per distinct photograph, referenced by a relative image path:

    {"image":"images/page-001.png","ground_truth":"Bé An đang đọc sách.\nHôm nay trời rất đẹp.","condition":"clean"}

3. Example PowerShell, from F:\c1\capstone1\backend:

    $py = "F:\c1\capstone1\.venv\Scripts\python.exe"
    & $py scripts\ocr_real_photo_benchmark.py "F:\c1\ocr-private-eval\pages.jsonl" --env-file "F:\c1\capstone1\backend\.env" --min-pages 10 --expected-profile FLOW1_EXTERNAL_TRDG --expected-sha 200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6 --output "F:\c1\ocr-private-eval\aggregate-result.json"

4. The --env-file flag is optional but useful for Git worktrees because a separate checkout does not inherit the original local backend .env. If backend/.env does not exist, check F:\c1\capstone1\.env or F:\c1\.env; use an existing file containing your own valid development credentials. Do not print keys, place secrets in commands, copy .env into the repository, or use fabricated credentials when testing the active FLOW1 model. The script performs local OCR and may read model registry/weights; it does not upload pages or write revisions.\n5. If objective CER/WER acceptance limits have been set **before** looking at this dataset, additionally pass --max-cer and --max-wer. Otherwise the script reports measured values but explicitly leaves the quality gate unset. It will still fail if images/ground truth are invalid, any OCR engine reports failure, the model provenance falls back or differs, or some pages fail.
6. Reports contain **aggregated measurements only**: normalized NFC micro CER/WER without accent folding, exact page matches, timings, and PyTorch GPU allocator peaks, plus engine/model provenance counts. Reports do **not** include OCR text, ground truth, images, or file paths. Local model initialization may download/cache authorized weights and may contact configured model registry; it does not call the upload endpoint or write book revisions.
7. Human verification of photograph provenance, ground truth, word bounding boxes, RED/GREEN/YELLOW accuracy and per-condition behavior remains **separate and required**. An aggregate CER/WER report cannot on its own certify those gates.

Run helper tests (do not require a GPU):

    cd F:\c1\capstone1\backend
    & ..\.venv\Scripts\python.exe -m unittest test_ocr_real_photo_benchmark -v

## Stage B: durable OCR inference jobs on Render + Supabase + Windows worker (design, NOT implemented)

- Preserve existing synchronous upload behavior until a distinct, feature-flagged OCR inference queue is fully tested. The existing admin_ocr_jobs.py queue handles **AI correction**, not initial OCR inference. viread_ocr_outbox_worker.py handles training/outbox, also not initial inference.
- **Upload:** authorized Admin uploads an image into the existing *private* Supabase Storage path; backend validates MIME, bytes, dimensions, book rights, and deduplicates with an idempotency key. A durable database job and associated page reservation are persisted atomically, with status QUEUED; frontend receives 202 with a job ID and polls the authorized status endpoint. Retain synchronous route compatibility until frontend is ready.
- **Worker:** Windows host initiates **outbound HTTPS** polling to Render; no inbound laptop port, exposed Ollama service, Supabase service-role key or child data in URLs. Backend authenticates a dedicated restricted worker identity and grants a short-lived signed URL for the claimed image. Do not give the worker general database owner privileges.
- **Leases:** one atomic claim transaction (QUEUED or expired lease) sets RUNNING, worker ID, fencing token, expiry; heartbeat renews if token still matches. Use a bounded retry policy, exponential delay, dead-letter state, cancellation, explicit offline status and safe late-completion rejection. Treat worker crash and Render restart as first-class tests.
- **Result:** worker uses *unchanged* extract_text_and_boxes pipeline and records model SHA, configuration SHA, all engine statuses, processing evidence and normalized boxes. Backend validates schema, ownership, image digest, claim fencing token, word ordering, numeric bounds, immutable provenance, and revision semantics before committing PageRevision(NEEDS_REVIEW) and transitioning page lifecycle. No direct DB writes from the laptop worker.
- **Resource control:** one OCR job concurrently on GTX 1650 4 GB, enforce image size cap, process timeouts and memory monitoring. Benchmark before raising concurrency or moving PaddleOCR to GPU/WSL2.
- **Security/correctness gates:** RLS and role separation, scoped authentication, private image access, 401/403/404 tests, replay/lease expiry, duplicate upload and retries, no plaintext or tokens in logs, safe worker shutdown, preserve previously verified revisions and never overwrite an Admin's edits.
- **Offline behavior:** with laptop off, new uploads remain QUEUED, old book reading continues, and work resumes after worker reconnects. If worker never returns, jobs remain visibly pending or end in an actionable timed-out state. No silent CPU fallback onto Render Free's 512 MiB instance.
- **Deployment:** release behind OCR_REMOTE_WORKER_ENABLED=false by default. Implement DB migration, backend, worker CLI, frontend polling and tests in separate reviewed PR(s). **No Supabase production DDL, Render deploy, or merge** is authorized by this document.

## Synthetic image dataset caution

Computer-generated pages (including the ten illustrated/modified examples supplied for initial testing) may be run through this command as a **synthetic smoke/performance set only**. A passing result **must not** be interpreted as photographed-book acceptance. Use an independently reviewed set of actual photos for Gate E.
