# 11. Offline, WAN-Off, Worker-Kill & Laptop-Off Test Results (Section 3D)

**Evidence:** [exp_d_voice_and_topologies.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_d_voice_and_topologies.json), `MainActivity.java`, `scripts/windows/voice_worker.py`, ADB (`ATSYVB6205006984`)

## 1. Five-Mode Section 3D Topology Matrix

| Topology Mode | Measured Result | Evidence & Exact Behavior |
|---|---|---|
| **Mode 1: Online Local-Only** (`provider=local`, cloud fallback disabled) | **PASS** | `X-Voice-Provider: local`, `X-Voice-Fallback: 0`, `google_fallback_disabled: true`. Zero cloud TTS/STT egress. |
| **Mode 2: Laptop WAN-Off Loopback** (`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, negative-control WAN block, fresh temp `tts-cache`, unseen text) | **PASS** | Negative control verified: outbound `https://huggingface.co` blocked (`WAN_BLOCKED_NEGATIVE_CONTROL: refused outbound connection`). Unseen sentence `"Con mèo mướp trèo cây cau buổi sớm mai."` succeeded offline: `/tts` **`200`**, `/tts/timed` **`200`** (`9` word timings), `/stt` roundtrip `"con mèo mướp trèo cây cao buổi sớm mai"` (**`WER=0.1111`**, `2,307.20 ms` cold / `340 ms` warm P50). |
| **Mode 3: Phone Airplane Mode (Honor X9d `MTN-NX1` Audit + ADB Check)** | **UNSUPPORTED / FAIL Offline AI** *(Hardware Connected)* | **Device Verified via ADB (`ATSYVB6205006984`):** Model `MTN-NX1`, Android `16`, ABI `arm64-v8a`, `MemTotal: 7,646,768 kB` (`7.29 GiB` RAM), `airplane_mode_on: 0` (kept untouched). Installed `vn.viread.android` `0.1.0` (`versionCode=1`, `minSdk=26`, `targetSdk=35`) `base.apk` is **`2.1 MB`** with **`NO_NATIVE_LIBS`**. `MainActivity.java` is a pure WebView shell with zero JS AI bridge and zero bundled Sherpa-ONNX / VieNeu / OCR `.so` runtimes -> local AI fails in airplane mode without a post-capstone JNI bridge. Hardware (`arm64-v8a`, `7.29 GiB`) has headroom for a future `~34 MB` Sherpa-ONNX STT + precomputed MP3 bridge (documented in `android/OFFLINE_POC_ARCHITECTURE.md`). |
| **Mode 4: Mid-Reading Voice Worker Kill & Recovery** | **PASS** | Killed live `voice_worker.py` (`proc.kill()`) mid-session -> client request failed fast in **`4.15 ms`** (`ReadError`, no 30s hang) -> clean restart recovered `/tts` **`200`** (`"Bé đọc lại bình thường."`) + `/stt` roundtrip **`"bé đọc lại bình thường"`** (`0` errors). |
| **Mode 5: Laptop-Off Per-Feature Matrix** | **VERIFIED DEGRADATION** | See Section 2 table below. |

## 2. Mode 5: Laptop-Off Per-Feature Availability Matrix

When the user's laptop/PC (`voice_worker.py` on `:8010`, `ocr_worker`, local Ollama `:11434`) is powered off while cloud Web/API (Render) and PostgreSQL/Storage (Supabase) remain online:

| Feature | State When Laptop Off | Observed / Enforced Mechanism |
|---|---|---|
| **Catalog browsing, parent book list, reading progress & reports** | **UP (Cloud only)** | Served purely from Render + Supabase PostgreSQL + proxyless short-TTL (`300s`) signed Storage URLs. |
| **Voice TTS (`/tts`, `/tts/timed`, `/tts/phonics`) & Voice STT (`/stt`)** | **DOWN (`503` Fail-Fast)** | Local voice worker unreachable -> `503` without false-green fallback or cloud TTS leak. Client `local-segment-speech-recognition.ts` circuit breaker prevents infinite retry loops. |
| **Admin / Parent OCR Queue (`ocr_inference_jobs`)** | **QUEUED (Durable until laptop resumes)** | Jobs remain `QUEUED` in Supabase PostgreSQL; `/system/admin/health` honestly reports `ocr_worker` unavailable and non-zero `queue_depth` + `oldest_pending_job_age_seconds` (false-green `remote_ocr_ready` override removed). |
| **Parent Submission Proofreading / Child Safety (Local Ollama)** | **SKIPPED / PROVISIONAL FALLBACK** | Decoupled `parent_book_submission_worker` advances remote/post-OCR checks with deterministic provisional fallback when Ollama is unreachable (`test_provider_errors_last_chunk_failure_stage_retry_and_temp_ttl_cleanup` passed). |
| **Background Cron Dispatch (`POST /internal/cron/dispatch`)** | **UP (Cloudflare Worker)** | Cloud-resident cron runs reminder/presence sweeps with `pg_advisory_lock` independent of laptop power. |
