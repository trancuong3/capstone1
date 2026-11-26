# 08. Consolidated Benchmark Results (Experiments A, B, C, D & PostgreSQL 16)

**Host:** `Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz` (`6C/12T`), `15.83 GB` RAM, Windows 11 + WSL2 Ubuntu `26.04.1 LTS` (`x86_64`)  
**Artifacts:** [exp_a_onnx_vs_stock.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_a_onnx_vs_stock.json), [exp_c_jpeg85_vs_png.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_c_jpeg85_vs_png.json), [exp_d_voice_and_topologies.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_d_voice_and_topologies.json), [pg16_contention_and_drills.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/pg16_contention_and_drills.json), [summary_metrics.csv](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/summary_metrics.csv)

## 1. Experiment A — ONNX Runtime CPU OCR vs Stock PyTorch+Paddle (`threads=2`)

VietOCR `FLOW1_EXTERNAL_TRDG` was exported with dynamic-shape `OnnxSafeMHA` (`split`+`stack`+`flatten` eliminating static `Reshape_4` sequence-length baking) + dynamic causal mask (`vietocr_flow1_encoder.onnx` `113.37 MB`, `decoder` `39.67 MB`), paired with `paddle2onnx` DBNet (`2.42 MB`) and Latin CRNN (`8.98 MB`), running in an isolated Python `3.12.10` subprocess where `torch`, `torchvision`, `paddle`, `paddleocr`, and `vietocr` were blocked in `sys.modules`.

| Metric | Stock (`torch=true, paddle=true`) | ONNXRuntime (`torch=false, paddle=false`) | Delta / Speedup |
|---|---:|---:|---:|
| Import time | `10,459.51 ms` | `4,855.94 ms` | `2.15x` faster |
| Engine init time | `19,674.17 ms` | `3,075.73 ms` | **`6.40x` faster** |
| Cold Page 0 latency | `33,394.28 ms` | `18,137.12 ms` | `-45.7%` |
| Warm P50 latency (10-case) | `26,289.99 ms` | **`13,189.54 ms`** | **`-49.8%` (`2.0x`)** |
| Warm P95 latency (10-case) | `41,557.53 ms` | `22,512.02 ms` | `-45.8%` |
| Warm Mean latency (10-case) | `26,065.28 ms` | `14,229.84 ms` | `-45.4%` |
| OS Peak RSS | `1,659.41 MB` | `1,413.50 MB` | **`-245.91 MB` (`-14.82%`)** |
| OS Peak Commit | `3,094.76 MB` | `2,033.34 MB` | **`-1,061.42 MB` (`-34.30%`)** |
| 10-Case Text SHA-256 Parity | Baseline | **`10/10` exact matches** | `0` drift (`CER=0.020644`, `WER=0.082418`) |
| 24-Page IoU@0.50 (Geom / Strict F1) | `0.977505` / `0.895706` | `0.977505` / `0.895706` | `0.000000` drift |

## 2. Experiment B — WSL2 Linux `x86_64` `ocr_worker` Parity

Inside WSL2 Ubuntu `26.04.1 LTS` (`/home/cuong/ocr_worker_wsl_venv`, Python `3.12`):
- **Dependency & ABI Verification:** `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84` (sole `cv2` owner; `extra_cv2: []`), `pytesseract==0.3.13`, `torch==2.14.1+cpu`, `paddlepaddle==2.6.2`, `paddleocr==2.7.3`, `vietocr==0.3.12`. Reported transitive `imgaug`->`opencv-python` collision fixed in [ocr_worker/Dockerfile](file:///F:/c1/capstone1-rc-zero-cost/ocr_worker/Dockerfile).
- **3-Engine Smoke & Canary:** `warmup_s=22.433`, `smoke_s=4.604`, `maxrss_mb=1259.38`, `engine_statuses={'paddleocr': 'success', 'vietocr': 'success', 'tesseract': 'success'}`, output `"Bé mèo đi học buổi sáng."` (`6` words). 3-page OCR canary: `5,465.99 ms` / `7,111.47 ms` / `7,488.23 ms`, `maxrss_mb=1438.39`.
- **Final RC `ocr_worker` Suite Re-run (`task-1006`):** `unittest discover -s ocr_worker -p "test_*.py" -v` -> **`Ran 5 tests in 34.945s — OK`**, exit `0`.

## 3. Experiment C — Paired PNG vs JPEG `q=85` OCR A/B

*Note: Latency in Exp C ran concurrently with background host processes (`PID 29464` & `18848`), whereas payload bytes, CER/WER, and IoU are deterministic.*

| Dataset / Metric | PNG | JPEG `q=85` | Delta |
|---|---:|---:|---:|
| **10-Case Total Payload** | `28,673,377 B` | **`2,746,362 B`** | **`-90.42%`** |
| **10-Case Micro CER / WER** | `0.020644` / `0.082418` | **`0.017001`** / **`0.074176`** | `-0.003643` CER / `-0.008242` WER |
| **10-Case Exact / Diacritic** | `348/364 (95.6%)` / `295/311 (94.86%)` | **`349/364 (95.88%)`** / **`296/311 (95.18%)`** | `+1` word / `-1` diacritic error |
| **10-Case Latency (P50 / P95)** | `34,467.87 ms` / `59,258.76 ms` | `21,316.83 ms` / `46,221.75 ms` | `-38.2%` P50 |
| **24-Page Total Payload** | `1,540,411 B` | **`585,126 B`** | **`-62.01%`** |
| **24-Page IoU@0.50 (Geom / Strict F1)** | `0.977505` / `0.895706` | **`0.988741`** / **`0.912999`** | `+0.0112` / `+0.0173` F1 |
| **24-Page IoU@0.75 (Geom / Strict F1)** | `0.899796` / `0.856851` | **`0.929376`** / **`0.886387`** | `+0.0296` / `+0.0295` F1 |

## 4. Experiment D — Voice Precision, Codec Negotiation & STT Benchmarks

| Mode | Startup (s) | Peak Tree RSS (MB) | Peak Commit (MB) | Minimal Pairs (Iso / Carrier) | 8-Voice TTS P50 / P95 (ms) | Adult STT P50 / P95 (ms) |
|---|---:|---:|---:|---|---:|---:|
| **`int8`** | `26.39` | **`859.99`** | **`1,634.41`** | `7/17` / `12/17` | `2,921.89` / `3,645.30` | `340.37` / `546.55` |
| **`fp32`** | `20.63` | `1,446.99` | `2,223.75` | `7/17` / `13/17` | `3,623.50` / `4,642.37` | `307.70` / `604.00` |
| **`hybrid` (`int8` + word `fp32`)** | — | `1,901.30` | `2,678.90` | **`10/17`** / — | — | — |

- **Real `voice_worker.py` `Accept` Negotiation (`local_north_truc_ly`):** `audio/wav` `275,564 B` (`WER=0.0909`) vs `Accept: audio/mpeg` **`23,468 B`** (`11.74x` reduction, `WER=0.0909`) vs `Accept: audio/ogg` **`24,459 B`** (`11.27x` reduction, `WER=0.0909`). Direct PyAV `ogg_opus` 32 kbps across 8 voices: `11,121–15,328 B` (`23.63x–26.33x` smaller).
- **Adult-Only Caveat:** `18` manifest clips evaluated (`mean_wer=0.2624`); **0 real 6–7yo child recordings tested (UNVERIFIED)**.

## 5. PostgreSQL 16 Contention, Backup/Restore & Rollback Drills (`127.0.0.1:55432`)

- **All `40` `supabase/migrations/*.sql`:** Applied cleanly (`0` errors, `60` public tables); `20261124120000_soft_delete_catalog_books.sql` idempotent re-apply **`6.99 ms`**.
- **Live Contention + Kill + Soft-Delete Race:** 2 Parents + 1 Admin concurrent OCR enqueue (`1,287.63 ms`) + Child `ReadingSession`/`ReadingEvent` (`WORD_RETRY`), priority claim (`admin` first), worker kill -> reclaim at **`fencing_token=2, attempt=2`**, stale worker-1 rejected **`409`**, soft-delete mid-job cancels job and late worker rejected **`409 BOOK_SOFT_DELETED`**, **`0` stuck `CHECKING`**.
- **Backup / Restore / Rollback Drills:** `pg_dump` **`0.67 s`** -> fresh DB `psql` restore **`15.933 s`** (`60/60` tables, `4/4` `ocr_inference_jobs`, `integrity_match=true`) -> rollback drill draining `2` live (`CLAIMED`+`QUEUED`) jobs to `0` + executing rollback DDL in **`0.100 s`**. *(Note: `pg_dump_bytes` field in JSON recorded exit code `0` instead of byte length).*
