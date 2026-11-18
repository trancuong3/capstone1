---
name: viread-ocr-vietnamese
description: >-
  Use this skill when working on ViRead book page OCR, PaddleOCR + VietOCR dual-engine recognition, Tesseract Vietnamese fallback, normalized word bounding boxes, Vietnamese NFC diacritics, or Admin OCR review/reprocess flows.
---

# ViRead Vietnamese OCR Workflow

ViRead uses a local Dual-Engine OCR pipeline (**PaddleOCR 2.7.3** detector + **VietOCR 0.3.12** recognizer) with deterministic **Tesseract (`vie.traineddata`)** fallback. Read [backend/ADMIN_BOOKS_OCR_SETUP.md](../../../backend/ADMIN_BOOKS_OCR_SETUP.md) for full runtime diagnostics.

## 1. Key Modules

- Core OCR engine: `backend/app/services/ocr_engine.py` (`DualEngineOcrService`)
- Preprocessing & geometry: `viread_vietocr_v2_preprocessing.py`, `word_box_geometry.py`, `ocr_evidence.py`
- Vietnamese token/punctuation adjudication: `ocr_adjudication.py`, `ocr_punctuation.py`, `ocr_calibration.py`
- Admin OCR workflow & routes: `backend/app/api/routes/admin_ocr.py`, `services/admin_ocr_service.py`, `services/admin_ocr_jobs.py`
- Runtime preflight check: `backend/app/services/runtime_diagnostics.py`

## 2. Mandatory OCR Engineering Rules

1. **Lazy ML Imports Only**:
   - `torch`, `paddleocr`, `vietocr`, and `pytesseract` usage must remain lazy/guarded so lightweight unit tests and low-memory startups (e.g., 512 MiB containers) do not fail at FastAPI import time.
2. **Never Upgrade Locked OCR Dependencies**:
   - `numpy==1.26.4` (NumPy 2.x breaks PaddlePaddle/PyTorch C-API ABI).
   - `protobuf==3.20.2` (`<4.0.0` required by `paddlepaddle==2.6.2`).
   - `opencv-python-headless==4.10.0.84` (avoids GUI DLL conflicts on Windows/CI).
3. **Vietnamese Unicode & Punctuation Integrity**:
   - Always normalize strings with `unicodedata.normalize("NFC", ...)` before token comparison or persistence.
   - Preserve all 6 Vietnamese tones and `đ`/`Đ`; strip only outer punctuation via `ocr_punctuation.py` / `normalize_word` without corrupting internal hyphens or apostrophes.
   - Keep both PaddleOCR and VietOCR candidates in revision evidence metadata — selecting a winning token must not erase secondary candidate evidence.
4. **Normalized Bounding Boxes & Revision Lifecycle**:
   - Persist `pagerevisionwords.boundingbox` as normalized `[x, y, w, h]` floats in `[0.0, 1.0]`.
   - Persist `bookpages.imagepath` only as a relative Supabase Storage object path (never a signed URL).
   - New OCR output enters `pagerevisions` as `NEEDS_REVIEW`; only explicit Admin verification transitions it to `VERIFIED`.
5. **Fallback Discipline**:
   - Use Tesseract (`vie.traineddata`, `TESSDATA_PREFIX` auto-detected if `backend/tessdata/vie.traineddata` exists) when Dual-Engine is unavailable or detects zero lines. Do not silently mask mid-pipeline Dual-Engine crashes as fake `success`; surface engine status (`not_initialized` / error type) in metadata.

## 3. Safe Diagnostics & Testing

Run configuration diagnostics without leaking secrets:
```powershell
Set-Location "F:\c1\capstone1\backend"
..\.venv\Scripts\python.exe -c "from app.services.runtime_diagnostics import runtime_configuration_diagnostics; print(runtime_configuration_diagnostics())"
```

Run targeted OCR unit tests before full suite:
```powershell
Set-Location "F:\c1\capstone1\backend"
..\.venv\Scripts\python.exe -m unittest test_ocr_adjudication.py test_ocr_punctuation.py test_vietocr_v2.py test_admin_ocr_multimodel.py -v
```
