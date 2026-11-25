# 05. Resource Requirements & Free-Container Viability Analysis

**Evidence:** [exp_a_onnx_vs_stock.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_a_onnx_vs_stock.json), [exp_d_voice_and_topologies.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_d_voice_and_topologies.json), [summary_metrics.csv](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/summary_metrics.csv)

## 1. OCR Worker Memory Profile (Stock PyTorch+Paddle vs Pure ONNXRuntime)

Measured in isolated Python 3.12 (`threads=2`, Windows PSAPI `GetProcessMemoryInfo` + Linux `ru_maxrss`):

| Runtime & Environment | Before Init RSS / Commit (MB) | After Init RSS / Peak (MB) | After Cold P0 RSS / Peak (MB) | End OS Peak RSS (MB) | End OS Peak Commit (MB) | 512 MB Free Tier | 1 GB Free Tier |
|---|---:|---:|---:|---:|---:|:---:|:---:|
| **Stock PyTorch+Paddle** (`PID 21736`, Win x64, `t=2`) | `381.56` / `691.39` | `875.77` / `1,187.39` | `1,386.83` / `1,526.32` | **`1,659.41`** | **`3,094.76`** | FAIL | FAIL |
| **Pure ONNXRuntime** (`PID 1748`, `torch=false, paddle=false`, `t=2`) | `126.75` / `449.70` | `304.32` / `366.50` | `854.50` / `896.27` | **`1,413.50`** | **`2,033.34`** | **FAIL** | **FAIL** |
| **Delta (ONNX vs Stock)** | `-254.81` RSS | `-571.45` RSS | `-532.33` RSS | **`-245.91 MB (-14.82%)`** | **`-1,061.42 MB (-34.30%)`** | `viable_512mb=false` | `viable_1gb=false` |
| **WSL2 Ubuntu `ocr_worker` (Stock, `t=2`, 3-engine smoke)** | — | — | — | `1,259.38` (`ru_maxrss`) | — | FAIL | FAIL |
| **WSL2 Ubuntu `ocr_worker` (Stock, `t=2`, 3-page canary)** | — | — | — | `1,438.39` (`ru_maxrss`) | — | FAIL | FAIL |

**First-Principles Conclusion (Experiment A):** Exporting VietOCR (`vietocr_flow1_encoder.onnx` `113.37 MB` + `decoder` `39.67 MB`) and PaddleOCR DBNet+Latin (`det` `2.42 MB` + `rec` `8.98 MB`, total ONNX footprint `164.44 MB`) into `onnxruntime` CPU with zero `torch`/`paddle` imported slashes import+init RAM by **`-571 MB`** (`304 MB` steady after init) and cuts Peak Commit by **`-1,061.42 MB`**. However, **during 2048px+ multi-box page inference + DBNet post-processing + VietOCR line decoding, OS Peak RSS still reaches `896.27 MB` on Page 0 and `1,413.50 MB` over 34 pages**. Therefore, **`512 MB–1 GB` free containers (Render Free `512 MB`, SnapDeploy `512 MB`, Back4App `256 MB`) are empirically non-viable (`viable_512mb=false`, `viable_1gb=false`)** without dropping accuracy or downscaling pages; a `>= 2 GB` worker/container (e.g., Leapcell Hobby `3 vCPU / 4 GB` experimental or user's owned laptop/PC) is required.

## 2. Voice Worker Child-Process Memory Profile

Measured across the full Windows process tree (`measure_voice_child_mem.py`: launcher + `voice_worker.py` child `python.exe` with both Sherpa-ONNX `int8` STT and VieNeu TTS resident):

| Voice Worker Mode | Idle Tree RSS / Commit (MB) | After Sentence TTS RSS / Commit (MB) | End Peak RSS (MB) | End Peak Commit (MB) | 8 GB Laptop Co-Residency Verdict |
|---|---:|---:|---:|---:|---|
| **`int8`** (`VIREAD_VOICE_TTS_PRECISION=int8`) | `731.30` / `1,432.66` | `799.89` / `1,575.95` | **`859.99`** | **`1,634.41`** | **Recommended default** (`+1,414–1,659 MB` OCR fits `8 GB` / `16 GB` hosts) |
| **`fp32`** (`VIREAD_VOICE_TTS_PRECISION=fp32`) | — | — | **`1,446.99`** | **`2,223.75`** | `+587.0 MB` RSS over `int8`; viable on `16 GB` hosts |
| **`hybrid_int8_word_fp32`** (`int8` + lazy `fp32`) | `1,759.10` / `2,462.51` | — | **`1,901.30`** | **`2,678.90`** | **Avoid on RAM-tight hosts:** keeping both `int8` and `fp32` ONNX sessions resident uses **`+454.31 MB` MORE RSS than pure `fp32`**. |

## 3. Storage, Bandwidth & Client Device Footprint

- **OCR Upload Payload (Exp C):** Switching rasterizer output from PNG to JPEG `quality=85` shrinks payload bytes by **`-90.42%`** on the 10-case benchmark (`28,673,377 B` -> `2,746,362 B`) and **`-62.01%`** on the 24-page fixture set (`1,540,411 B` -> `585,126 B`), saving Supabase Storage & egress proportionally.
- **TTS Network Payload (Exp D):** Negotiating `Accept: audio/mpeg` (`23,468 B` vs `275,564 B` WAV = `11.74x` smaller, `voice_worker.py`) or `ogg_opus` 32 kbps (`11,121–15,328 B` = `23.63x–26.33x` smaller; `Accept: audio/ogg` on `voice_worker.py` = `24,459 B`, `11.27x` smaller) eliminates ~91% of TTS audio egress. `tts-cache` is bounded to `524,288,000 B` (`500 MB`) LRU via `prune_tts_cache_dir()`.
- **Mobile Client (`Honor X9d` `MTN-NX1` via ADB):** Android `16`, `arm64-v8a`, `MemTotal: 7,646,768 kB` (`7.29 GiB`). Installed `vn.viread.android` (`0.1.0`) `base.apk` is **`2.1 MB`** with **`NO_NATIVE_LIBS`**. On-device AI runtime is currently absent; host laptop/PC provides compute.
