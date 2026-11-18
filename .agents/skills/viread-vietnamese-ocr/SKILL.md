---
name: viread-vietnamese-ocr
description: >-
  Use this skill when developing, benchmarking, or debugging Vietnamese OCR accuracy in ViRead: 3-color word adjudication (Green/Yellow/Red), VietOCR v2 preprocessing/training, Tesseract vie.traineddata setup, and CER/WER evaluation.
---

# ViRead Vietnamese OCR Development, Adjudication & Benchmarking

Complement [viread-ocr-vietnamese](../viread-ocr-vietnamese/SKILL.md) with ViRead's Vietnamese diacritic accuracy contracts, 3-color word adjudication rules, and offline training/benchmark checks. Full empirical root-cause notes live in [docs/ocr-three-color-contract.md](../../../docs/ocr-three-color-contract.md) and [docs/ocr-color-benchmark.md](../../../docs/ocr-color-benchmark.md).

## 1. Three-Color Word Evidence Contract (`classify_word_evidence` & `adjudicate_word`)

Admin OCR Review colors represent **evidence conclusions**, never raw confidence thresholds:

| Color | Meaning | Exact Invariant (`backend/app/services/ocr_adjudication.py`) |
| :--- | :--- | :--- |
| **Green** | Confirmed correct | 1-to-1 match against a trusted reference (`admin` / `verified_revision`), explicit per-word Admin verification, **or** (when unreferenced) **VietOCR + Tesseract (`vie`)** agree on the exact NFC token with zero base-letter tone conflict and net positive votes. |
| **Red** | Confirmed mismatch | **Strictly** when a trusted reference exists, aligns 1-to-1 (`match`/`substitute`), and the stored token still matches original OCR output while differing from reference. Unreferenced engine adjudication **never** outputs Red. |
| **Yellow** | Insufficient evidence | All remaining cases (`insert`, `unmatched`, `ambiguous`, edited unverified draft tokens, or VietOCR/Tesseract disagreement). |

- **PaddleOCR Latin Caveat**: PaddleOCR `2.7.3` (`lang="vi"`) uses a Latin recognizer that mangles Vietnamese diacritics (`Hôm` -> `Höm`, `BỮA` -> `BU'A`). Use PaddleOCR for line/word geometry detection, **never** to veto a Vietnamese reading from VietOCR or Tesseract.
- **Frontend/Backend Color Parity**: `getWordReviewColorGroup` must stay 100% consistent with backend classification across all 706 cases in `frontend/tests/admin/fixtures/ocr-color-parity.json`.

## 2. VietOCR v2 Preprocessing, Offline Weights & Tesseract `vie`

1. **Line/Word Crop Fidelity** (`backend/app/services/viread_vietocr_v2_preprocessing.py`):
   - Do **not** stretch crops `1.3x` with extra white padding before VietOCR's `32px` height resize — doing so blurs `hỏi`/`huyền`/`ngã` tone marks.
   - Compute ink coverage cleanly for both dark-on-light and light-on-dark children's book pages.
2. **Offline Checkpoint Initialization** (`ocr_engine.py`, `ai/vietocr_v2/`, `viread_ocr_training_service.py`):
   - Prevent implicit VGG19 ImageNet backbone downloads (~550 MB) when loading self-contained VietOCR checkpoints so air-gapped/CI environments initialize deterministically.
3. **Windows Tesseract 5 `TESSDATA_PREFIX`**:
   - Point `TESSDATA_PREFIX` directly to `backend/tessdata` (containing `vie.traineddata`), **not** its parent directory.
4. **Locked ABI & Lazy Imports**:
   - Never upgrade `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, or `jiwer==4.0.0`. Keep `torch`, `paddleocr`, `vietocr`, and `pytesseract` lazy-imported.

## 3. Targeted OCR Verification Commands

```powershell
Set-Location "F:\c1\capstone1\backend"
..\.venv\Scripts\python.exe -m unittest test_admin_ocr_confidence.py test_ocr_adjudication.py test_ocr_punctuation.py test_vietocr_v2.py -v

Set-Location "F:\c1\capstone1\frontend"
npx.cmd vitest run tests/admin
```
