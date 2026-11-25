# 04. AI Quality Baseline (ViRead RC — Zero-Cost Architecture)

**Commit baseline:** `d5eee4dc907d81b737b53da08c916b1b4ba095d3` (working tree `feat/viread-rc-zero-cost-20261125`)  
**Host:** `Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz` (6C/12T), `15.83 GB` RAM, Windows + WSL2 Ubuntu `26.04.1 LTS` (`x86_64`)  
**Evidence:** [exp_a_onnx_vs_stock.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_a_onnx_vs_stock.json), [exp_c_jpeg85_vs_png.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_c_jpeg85_vs_png.json), [exp_d_voice_and_topologies.json](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/benchmarks/exp_d_voice_and_topologies.json)

## 1. OCR Quality Baseline (3-Engine Fusion: PaddleOCR + VietOCR FLOW1 + Tesseract)

Evaluated on the 10-case Vietnamese children's book evaluation set (`clean`, `childrens_font`, `small_text`, `rotated`, `low_light`, `perspective`, `shadow`, `noise`, `compressed`, `mixed_background`; private source text withheld per privacy policy) plus the 24-page repo-resident [ocr_word_box_iou](file:///F:/c1/capstone1-rc-zero-cost/backend/scripts/ocr_word_box_iou.py) fixture suite (`489` reference word boxes across 8 visual conditions).

| Metric | Stock PyTorch + Paddle (`threads=2`) | Pure ONNXRuntime (`threads=2`, 0 PyTorch/Paddle) | Paired PNG -> JPEG `q=85` (Stock, Exp C) |
|---|---:|---:|---:|
| **10-Case Micro CER** | `0.020644` | `0.020644` (`10/10` SHA-256 exact match) | `0.020644` -> **`0.017001`** |
| **10-Case Micro WER** | `0.082418` | `0.082418` | `0.082418` -> **`0.074176`** |
| **10-Case Exact Word** | `348/364 (95.60%)` | `348/364 (95.60%)` | `348/364 (95.60%)` -> **`349/364 (95.88%)`** |
| **10-Case Diacritic Word** | `295/311 (94.86%)` (`15` errs) | `295/311 (94.86%)` (`15` errs) | `295/311 (94.86%)` -> **`296/311 (95.18%)`** (`14` errs) |
| **Tone / Vowel / Đ-đ Acc.** | `94.53%` / `100.0%` / `100.0%` | `94.53%` / `100.0%` / `100.0%` | Non-regressed |
| **Strict Reading Order / Valid Boxes** | `9/10` / `367/367` | `9/10` / `367/367` | Non-regressed |
| **24-Page IoU@0.50 (Geom / Strict F1)** | `0.977505` / `0.895706` | `0.977505` / `0.895706` | `0.977505 / 0.895706` -> **`0.988741 / 0.912999`** |
| **24-Page IoU@0.75 (Geom / Strict F1)** | `0.899796` / `0.856851` | `0.899796` / `0.856851` | `0.899796 / 0.856851` -> **`0.929376 / 0.886387`** |

**Worst-condition observation (both Stock and ONNX):** `low_light` remains the hardest 24-page IoU condition (`mean_matched_iou=0.7802`, `@0.50 strict F1=0.576923`), followed by `childrens_font` (`mean_matched_iou=0.8157`, `@0.50 strict F1=0.722222`), while `clean`, `small_text`, `shadow`, and `compressed` achieve `1.000` geometry F1 at `@0.50`.

**Active VietOCR Model & TIFF `<pad>` Fix:** `FLOW1_EXTERNAL_TRDG` (`200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6`). Special token filtering in `ocr_engine.py` (`_sanitize_vietocr_prediction`, `is_vietocr_reliable`) and `ocr_adjudication.py` (`adjudication_token`) eliminates `<pad>` leakage on noisy TIFF/BMP crops (`test_document_rasterizer_and_upload.py` passed `14/14`).

## 2. Voice Quality Baseline (Sherpa-ONNX Zipformer `int8` STT + VieNeu TTS)

- **Models tested (`F:\c1\tools\voice-runtime`):**
  - STT: `sherpa-onnx-zipformer-vi-30m-int8-2026-02-09`
  - TTS: `vieneu-v3-turbo-onnx-int8-3.8.5` (`int8`), `vieneu-v3-turbo-onnx-fp32-3.8.5` (`fp32`), and hybrid (`VIREAD_VOICE_HYBRID_WORD_FP32=true`).
- **Minimal-Pair Roundtrip (`17` words: `"mốt/một/mót"`, `"ma/má/mà/mả/mã/mạ"`, `"bò/bó/bỏ/bõ/bọ"`, `"tươi/tưới/tười"`):**
  - `int8`: isolated `7/17`, carrier (`"chữ <word>."`) `12/17`; `"mốt"` collapsed to `"một"` in both isolated and carrier forms.
  - `fp32`: isolated `7/17`, carrier `13/17`; carrier `"chữ mốt"` recovered cleanly (`"chữ mốt"`).
  - `hybrid_int8_word_fp32`: isolated `10/17` (`+3` over both standalone baselines), verified `X-TTS-Precision: int8` on sentence TTS and `fp32` on `word_sample=true`.
  - Canonical phonics `"mốt"` (`5` steps, `/tts/phonics`): `int8` `5.7s` (`547,244 B` WAV, STT `"ô từ út mút mốt sắc mốt mốt hai mươi mốt"`); `fp32` `5.86s` (`562,604 B` WAV, STT `"ô tở ốt mốt mốt sắc mốt mốt hai mươi mốt"`).
- **8 Regional Voices (`"Trên cành cây xanh, đàn chim hót vang chào buổi sáng."`):**
  - `int8`: `0.0` WER on `local_north_thien_minh`, `local_south_my_duyen`, `local_south_thai_son`; `0.0909` on `truc_ly`, `ngoc_linh`, `thuc_doan`; `0.4545` / `0.6364` on Central voices (`ngoc_tran`, `quang_son`) due to North-accented Zipformer STT bias.
  - `fp32`: `0.0` WER on `5/8` voices (`truc_ly`, `thien_minh`, `thuc_doan`, `my_duyen`, `thai_son`), `0.0909` on `ngoc_linh`, `0.6364` / `0.4545` on Central voices.
- **Compressed Audio Roundtrip (`Accept: audio/mpeg` / `audio/ogg`):**
  - Across all 8 voices (`int8`), MP3 64 kbps (`11.74x–11.82x` smaller) and Ogg/Opus 32 kbps (`23.63x–26.33x` smaller) preserved **identical STT WER on 8/8 clips** vs 48 kHz WAV.
- **Explicit Corpus Limitation:** `audio_corpus_manifest.json` (`18` evaluated clips: `mean_wer=0.2624`, dominated by `2` noisy/mismatched `human_recording` rows at `1.3` and `2.0`, while `15/18` clips scored `0.0–0.25`) contains **adult / synthetic speech only**. Real 6–7-year-old Vietnamese child speech remains **UNVERIFIED** (`0` child recordings tested for child privacy).
