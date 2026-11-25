# 10. AI Quality Non-Regression Results (OCR + Voice)

**Evidence:** [exp_a_onnx_vs_stock.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_a_onnx_vs_stock.json), [exp_c_jpeg85_vs_png.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_c_jpeg85_vs_png.json), [exp_d_voice_and_topologies.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_d_voice_and_topologies.json)

## 1. OCR Non-Regression Verdict (TIFF `<pad>` Fix, ONNX Export & JPEG `q=85`)

### A. Paired PNG vs JPEG `q=85` Non-Regression (10-Case Eval — Private Text Redacted)

| Sample ID | Condition | PNG Bytes | JPEG `q=85` Bytes | PNG CER / WER | JPEG `q=85` CER / WER | Exact SHA-256 Same? |
|---|---|---:|---:|---:|---:|:---:|
| `case_01` | `clean` | `2,501,128` | `221,457` | `0.006536` / `0.027778` | **`0.000000` / `0.000000`** | Improved (`-1` diacritic err) |
| `case_02` | `childrens_font` | `2,582,214` | `210,888` | `0.029630` / `0.121212` | `0.029630` / `0.121212` | Yes (`702fc072...`) |
| `case_03` | `small_text` | `2,574,960` | `214,837` | `0.010753` / `0.050000` | `0.010753` / `0.050000` | Yes (`a236b59e...`) |
| `case_04` | `rotated` | `2,619,600` | `232,553` | `0.007042` / `0.029412` | `0.007042` / `0.029412` | Minor non-char diff (`CER/WER` equal) |
| `case_05` | `low_light` | `1,723,546` | `229,786` | `0.041420` / `0.097561` | **`0.005917` / `0.024390`** | Improved (`-7` chars) |
| `case_06` | `perspective` | `2,754,297` | `237,474` | `0.013072` / `0.055556` | `0.013072` / `0.055556` | Yes (`b58de96d...`) |
| `case_07` | `shadow` | `2,528,065` | `215,016` | `0.007353` / `0.029412` | `0.007353` / `0.029412` | Yes (`9373d42e...`) |
| `case_08` | `noise` | `8,167,474` | `819,762` | `0.013699` / `0.060606` | `0.013699` / `0.060606` | Yes (`bcd3264e...`) |
| `case_09` | `compressed` | `678,501` | `139,051` | `0.010695` / `0.048780` | `0.010695` / `0.048780` | Yes (`4ccbd1b2...`) |
| `case_10` | `mixed_background` | `2,543,592` | `225,538` | `0.000000` / `0.000000` | `0.000000` / `0.000000` | Yes (`16e7da9b...`) |
| **Total** | **10 cases** | **`28,673,377`** | **`2,746,362` (`-90.42%`)** | **`0.020644` / `0.082418`** | **`0.017001` / `0.074176`** | **Zero regressions** |

### B. 24-Page Word Box IoU Non-Regression (`backend/tests/fixtures/ocr/`, `489` ref words)

- **ONNXRuntime vs Stock PyTorch+Paddle (Exp A):** `0.000000` drift across all metrics (`10/10` exact SHA-256 text matches; `@0.50` `geometry F1=0.977505`, `strict F1=0.895706`; `@0.75` `geometry F1=0.899796`, `strict F1=0.856851`).
- **JPEG `q=85` vs PNG (Exp C):** Payload shrunk **`-62.01%`** (`1,540,411 B` -> `585,126 B`) while `@0.50` improved (`geometry F1: 0.977505 -> 0.988741`, `strict F1: 0.895706 -> 0.912999`) and `@0.75` improved (`geometry F1: 0.899796 -> 0.929376`, `strict F1: 0.856851 -> 0.886387`).
- **TIFF `<pad>` Non-Regression:** `test_document_rasterizer_and_upload.py` Scenarios 1–5 (`14/14` tests) passed cleanly (`176.184s` on Python 3.12).

## 2. Voice Non-Regression Verdict (`int8`, `fp32`, `hybrid`, `MP3`/`Opus`, VAD)

- **TTS Minimal Pairs (`17` Vietnamese tone/vowel pairs):**
  - `int8` isolated `7/17`, carrier `12/17`; `fp32` isolated `7/17`, carrier `13/17`; `hybrid_int8_word_fp32` isolated **`10/17`**.
  - Tone risk observed in standalone `int8`: isolated & carrier `"mốt"` collapsed to `"một"`, whereas `fp32` recovered `"chữ mốt"` in carrier context and `hybrid` raised isolated score `+3`.
- **8 Regional Voices (`int8` & `fp32`):** Full 8-voice coverage across North (`truc_ly`, `ngoc_linh`, `thien_minh`), Central (`ngoc_tran`, `quang_son`), and South (`thuc_doan`, `my_duyen`, `thai_son`). North/South voices reached `0.0` WER on `5/6` voices under `fp32` and `3/6` under `int8`.
- **Compression Non-Regression (`Accept: audio/mpeg` & `audio/ogg`):**
  - `8/8` regional voices transcoded cleanly via PyAV (`mp3` 64 kbps `11.74x–11.82x` reduction; `ogg_opus` 32 kbps `23.63x–26.33x` reduction) with **identical STT WER on 8/8 clips**.
  - Live `voice_worker.py` `Accept` negotiation verified `200 OK`: `audio/mpeg` (`23,468 B`, `WER=0.0909`), `audio/ogg` (`24,459 B`, `WER=0.0909`), matching `audio/wav` (`275,564 B`, `WER=0.0909`).
- **Known Limitation:** Adult-only TTS/manifest evaluation (`18` manifest clips, `mean_wer=0.2624`); **real 6–7-year-old child speech remains UNVERIFIED (`0` child recordings tested)**.
