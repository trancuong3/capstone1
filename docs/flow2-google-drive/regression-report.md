# ViRead Flow 2 — Hybrid OCR & Flow 1 Regression Report

**Highest Priority Invariant (Rule I.1 & Test Group H):** Zero behavioral modification to the existing Hybrid OCR algorithm, detection, recognition, fallback, calibration, reading order, adjudication, or Flow 1 manual model replacement.

---

## 1. Exact Scope of Changes to `backend/app/services/ocr_engine.py`

A full line-by-line `git diff main -- backend/app/services/ocr_engine.py` confirms **ONLY 3 surgical additions** (all strictly inside model artifact loading & read-only status reporting):

1. **Module state tracking (`_vietocr_active_storage_path`):** Tracks the active model's storage reference alongside `_vietocr_active_checkpoint_sha` and `_vietocr_active_profile`.
2. **`_v2_artifact_from_storage(active)`:** Adds `is_gdrive_ref(ref)` branching to stream `gdrive://` manifest/shard/config bytes through `get_runtime_artifact_router().open_stream(...)` while performing the exact same per-shard byte-length check, per-shard SHA-256 verification, assembled checkpoint SHA-256 verification, and atomic `os.replace`. Legacy Supabase paths continue calling `storage_service.download_object(ref)` identically.
3. **`_get_ocr_engines()` warm-load guard + read-only `get_loaded_vietocr_runtime_status()`:**
   - When `_vietocr_engine` is already initialized and `(active_sha, active_profile, storage_path)` match the loaded verified instance, skips re-downloading from Google Drive (zero Drive calls on warm scans; transient Drive outages cannot evict an already-loaded verified model).
   - `get_loaded_vietocr_runtime_status()` reads in-memory state only and never triggers model initialization.

**Untouched Components (0 lines changed):**
- PaddleOCR / DBNet detection pipeline & line/box extraction
- VietOCR recognition inference, beam search, hallucination guard (`_is_vietocr_reliable`)
- Tesseract fallback & binary discovery
- Dual-engine sequence alignment, Vietnamese NFC/diacritics normalization, punctuation cleaning
- Confidence calibration, Platt scaling, color matrix classification, adjudication & false-yellow guardrails
- Reading order, word boxes, response schemas, and child book reading flows
- Locked ABI pins in `backend/requirements.txt` (`numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`) — **0 diff**

---

## 2. Regression Suite Results (Post-Round-3 Final Run)

### 2.1. Hybrid OCR Regression Suite (Group H)
| Test Module | Scope Verified | Result |
|---|---|---|
| `test_ocr_engine.py` | Dual-engine contract, PaddleOCR + VietOCR + Tesseract fallback, hallucination filter, punctuation, alignment, concurrency lock | **PASS** |
| `test_ocr_adjudication.py` | Adjudication rules, split/merge candidates, evidence selection | **PASS** |
| `test_ocr_punctuation.py` | Deterministic Vietnamese punctuation normalization | **PASS** |
| `test_ocr_calibration.py` | Platt scaling, book-disjoint calibration splits | **PASS** |
| `test_ocr_color_matrix.py` | Reference-decided invariants, red/yellow/green stability | **PASS** |
| `test_ocr_false_yellow_suite.py` | Vietnamese tone mark & Unicode precision, red precision | **PASS** |
| `test_hybrid_ocr_evidence.py` | BBox validation, blank-crop guard, selective crop evidence, NFC alignment | **PASS** |
| `test_ocr_runtime_provenance.py` | Verified Predictor provenance, corrupt chunk retry, fallback to verified original, concurrent registry switch | **PASS** |
| **Group H Total** | **208 tests executed (`36.632s`)** | **193 PASS, 15 pre-existing SKIPPED, 0 FAIL** |

### 2.2. Flow 1 Model Replacement & Existing ViRead Training Regression
| Test Module | Tests | Result |
|---|---:|---|
| `backend/test_viread_flow1_model_replacement.py` | 8 | **8 PASS** |
| `backend/test_viread_ocr_outbox_worker.py` | 10 | **10 PASS** |
| `backend/test_viread_ocr_training_auto_worker.py` | 10 | **10 PASS** |
| `backend/test_viread_dual_training_contracts.py` | 10 | **10 PASS** |
| `backend/test_viread_training_worker_claim.py` | 9 | **9 PASS** |
| `backend/test_viread_checkpoint_streaming.py` | 4 | **4 PASS** |
| `ai/vietocr_v2/test_colab_state_store.py` | 4 | **4 PASS** |
| `ai/vietocr_v2/test_colab_worker.py` | 14 | **14 PASS** |
| `frontend/test/admin-viread-training-flow1.test.tsx` | 4 | **4 PASS** |
| **Existing ViRead Total** | **73** | **73 PASS, 0 FAIL** |

---

## 3. Conclusion

There is **zero regression** in Hybrid OCR behavior, Flow 1 manual model replacement, existing outbox/worker contracts, or Python ABI dependencies.
