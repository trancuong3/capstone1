# OCR Confidence Audit

## Scope and baseline

This audit records the implementation found on `main` at baseline commit
`784939c09b711c05dd845f58e79344e1f84dcad4` (2026-11-04), then distinguishes
the fixes introduced on branch
`fix/ocr-confidence-calibration-20261104`.

This is a source-code audit, not a claim that OCR accuracy or calibration has
been measured on a labeled production dataset.

## 1. Actual OCR execution flow on the baseline

### Engine selection

Entry point:

- `backend/app/services/ocr_engine.py::extract_text_and_boxes`
- `backend/app/services/ocr_engine.py::_get_ocr_engines`

The primary path initializes PaddleOCR and VietOCR. If engine initialization or
the dual-engine execution raises an exception, `extract_text_and_boxes`
attempts the local Tesseract path.

### Primary PaddleOCR + VietOCR path

Actual path:

1. Decode the original page image with OpenCV.
2. Call `paddle_engine.ocr(image, cls=False)`.
3. Extract detected quadrilateral line regions and PaddleOCR's returned
   (recognized line text, score) pair.
4. Sort detected regions using `sort_reading_order_adaptive`.
5. Crop, perspective-correct and dewarp detected lines through the line/layout
   helpers in `ocr_engine.py`.
6. Run `vietocr_engine.predict(line_img_pil)` for each dewarped line.
7. Accept VietOCR text when `is_vietocr_reliable` allows it; otherwise retain
   PaddleOCR line text.
8. Segment each chosen line into estimated word spans with
   `_segment_words_optically_1d` and map those spans to normalized page
   coordinates with `_map_curved_word_boxes`.
9. Persist words and bounding boxes in the page revision.

Baseline confidence defects:

- When VietOCR text was accepted, the code assigned `chosen_conf = 0.95`.
  The predictor integration returns a string, not a measured word probability.
  The reliability predicate is a text-selection heuristic and does not produce
  a 95% probability.
- If PaddleOCR text was retained, its line score was copied to every word
  produced from that line. The score granularity was therefore line-level,
  not independent word-level.
- A second fallback value of `0.90` was used when the selected score was
  unavailable. This manufactured confidence where there was no score.

### Tesseract fallback path

Actual path:

1. Validate the local Tesseract binary, version and Vietnamese language data.
2. Decode and optionally upscale the image.
3. Create grayscale, CLAHE, Otsu and (when applicable) adaptive-threshold
   preprocessing candidates.
4. Run `pytesseract.image_to_data` with the configured or default PSM values.
5. Rank candidate preprocessings with `_candidate_quality_score`.
6. Select the highest-ranked usable candidate.
7. Read each token's Tesseract `conf` entry and its own `left/top/width/height`
   rectangle.

Tesseract does provide a per-token engine score in its TSV/data output. The
baseline divided valid values in the 0..100 range by 100 and stored that scalar.
That conversion is a range normalization only; it does not calibrate the score
as the probability that the Vietnamese token is exactly correct.

### Candidate selection score is not word confidence

`_candidate_quality_score` combines average available Tesseract confidence
with word-count, line-count, alphanumeric, symbol and noise signals. It ranks
preprocessing candidates. Its output is not a confidence for a specific word
and must not be exposed as one.

## 2. Persistence and API path

Relevant models:

- `backend/app/models/book.py::PageRevision`
  - `ProcessingMeta` is JSONB and can retain processing provenance.
- `backend/app/models/book.py::PageRevisionWord`
  - `OCRConfidence` is a nullable Float.
  - `BoundingBox` is JSONB.

Actual persistence path:

`AdminOcrService.upload_page / replace_page_image`
→ `extract_text_and_boxes`
→ `AdminOcrService._word_data`
→ `AdminOcrRepository.stage_page_revision_bundle / stage_revision_bundle`
→ `PageRevision` and `PageRevisionWord`
→ PostgreSQL.

Read path:

`AdminOcrService.revision_detail`
→ `AdminRevisionDetailRead` in `backend/app/schemas/book.py`
→ Admin revision API
→ `frontend/lib/api/ocr-review-service.ts`
→ `AdminOcrReviewScreen`.

The baseline response included `ocr_confidence` for each word and revision-wide
`ocr_metadata`. It did not expose explicit per-word score provenance or
calibration status.

## 3. Baseline Admin UI behavior

File: `frontend/components/admin/admin-ocr-review-screen.tsx`.

The baseline categorized the stored scalar with fixed thresholds:

- High: >= 0.90.
- Medium: >= 0.70.
- Low: < 0.70.
- Unknown: null or invalid.

The UI then colored the bounding box green, yellow, red or orange. Those
thresholds were applied to heterogeneous values: Tesseract per-word raw scores
and dual-engine scores that had been copied from line-level output or
hard-coded. The same numeric threshold therefore did not have a consistent
meaning across engines or score scopes.

The old UI disclaimer said the score was not a guaranteed probability, but the
color labels still implied a common high/medium/low interpretation. The
thresholds were not supported by a labeled Vietnamese calibration evaluation.

## 4. Why correct words can look low-confidence and wrong words can look high

These are distinct failure modes:

- A correct token may have a low native engine score because the scan is blurry,
  curved, low contrast, small, compressed or affected by preprocessing.
- An incorrect token can receive a high native score when the model is
  confidently wrong, especially for visually similar Vietnamese characters,
  vowel marks and tone marks.
- Reusing one line score for every word hides within-line differences and makes
  each token appear to have the same certainty.
- The hard-coded VietOCR value and 0.90 fallback made some words appear highly
  confident without a matching word-level model output.
- Applying one threshold to distinct engines ignores score-distribution and
  calibration differences.
- A stale or misaligned bounding box may highlight a neighboring token even if
  the recognized text itself is correct. That is a localization/alignment defect,
  not necessarily a recognition defect.

## 5. Bounding-box quality is separate

The dual-engine path uses estimated word segmentation:

- `_segment_words_optically_1d` estimates word spans from ink projection,
  expected character-width weights and whitespace valleys.
- `_map_curved_word_boxes` maps those estimated spans back to the original
  image coordinates.
- `AdminOcrService._word_data` validates that a box is normalized and remains
  within the image.

The current validation proves that a box is structurally in range; it does not
prove that the box tightly encloses the corresponding printed word. There is no
ground-truth box IoU or per-word localization metric in the baseline code.
Recognition confidence must not be increased because a box is valid.

## 6. Reading feedback is a different subsystem

Child Reading colors are not OCR-confidence colors.

Relevant files:

- `frontend/lib/reading/realtime-alignment.ts`
- `frontend/components/reading/book-page-content.tsx`
- `frontend/components/reading/word-highlight-overlay.tsx`
- `frontend/components/reading/reading-screen.tsx`

The baseline uses yellow for the active reading cursor, green for matched
words, orange for substitutions, red for skipped words, blue for hesitation
and purple for repeated words.

A separate baseline concern was
`normalizeRealtimeWord`: it removed all combining Vietnamese marks and mapped
`đ` to `d`. Consequently, words such as `ma` and `má`, or `d` and `đ`,
could collapse to the same comparison token and be marked as a match even
though they are distinct spellings. This is speech/transcript alignment
behavior, not OCR confidence.

## 7. Page confidence was not independently calibrated

Baseline `ReadingContentService._build_page_dto` averaged available
`PageRevisionWord.OCRConfidence` scalars into `ReadingPageDTO.confidence`
when every returned word had a valid number. That arithmetic mean did not
establish a calibrated page probability, particularly when the inputs came
from different engine granularities.

## 8. Changes on this branch

The following changes have been made on this branch:

- Dual-engine output no longer assigns a hard-coded 0.95 to accepted VietOCR
  text.
- Dual-engine output no longer copies PaddleOCR's line score into each word's
  `ocr_confidence`, nor substitutes 0.90 when a score is absent.
- Dual-engine per-word confidence is null. Its per-word evidence metadata
  records the selected engine, recognized token, line/unavailable scope and
  any genuine PaddleOCR line score separately.
- Tesseract continues to preserve the existing nullable `ocr_confidence`
  storage scalar for backward compatibility, while new revision metadata
  records the native 0..100 score, source, word scope and
  `NOT_CALIBRATED` status.
- Admin revision responses now expose explicit raw score, line score, source,
  scope, calibration status and whether the original evidence still applies to
  the current text.
- Manual edit drafts copy existing confidence evidence. If an administrator
  changes a token, the original evidence is marked as applying only to the
  original OCR text, not the corrected token.
- Admin bounding boxes use neutral styling until calibrated probability exists.
  Raw engine scores are displayed with their source and scope rather than
  converted to high/medium/low colors.
- `ReadingContentService._build_page_dto` now returns null for page confidence
  rather than averaging raw word scores.

No database migration was needed for these metadata additions because
`PageRevision.ProcessingMeta` already maps to a JSONB column. The existing
`PageRevisionWord.OCRConfidence` field and response field are retained for
backward compatibility; consumers must not interpret that legacy scalar as a
calibrated probability.

## 8A. Child Reading accent-safety changes on this branch

The branch also updates `frontend/lib/reading/realtime-alignment.ts`:

- Exact real-time token normalization now preserves Vietnamese tone marks,
  vowel marks and the distinction between `d` and `đ`.
- A separate accent-insensitive helper is used only to detect a possible
  diacritic-only transcript ambiguity. It is never used to declare an exact
  match.
- A diacritic-only mismatch receives `AMBIGUOUS` rather than `MATCH` or
  `SUBSTITUTE`. The presentation uses a neutral style and explicitly says the
  evidence is insufficient to judge correct/incorrect.
- The word cursor remains based on stable word IDs and sequential book indices.
  A following exact word can continue the alignment after an ambiguous token.
- The final report alignment service was separately inspected:
  `backend/app/services/text_alignment.py::normalize_text` uses NFC and
  lowercase without removing Vietnamese diacritics, so it already preserves
  tone marks for final transcript comparison.

This does not make all STT output reliable. The browser STT adapter does not
currently provide a verified, consistently available word-level confidence
signal to this alignment engine. Therefore, the new neutral ambiguity rule is
limited to differences attributable to Vietnamese diacritics; other uncertain
provider outputs still require further evidence and should not be represented
as a calibrated pronunciation probability.

## 9. Calibration data and evaluation status

At the baseline HEAD, no dedicated, versioned Vietnamese OCR confidence
calibration dataset or reproducible calibration report was found in the
inspected repository. The database may contain administrator-verified
revisions, but a verified revision alone is not sufficient to prove that its
original image, original OCR token output, word mapping and corrected reference
are aligned and exportable without leakage.

Therefore this branch does **not** claim a calibrated probability and does not
report fabricated Word Exact Match Accuracy, CER, WER, Brier Score, ECE,
high-confidence precision, coverage or sample counts.

A future calibration run must:

1. Build paired image / original OCR / manually verified ground-truth word
   examples with auditable word alignment.
2. Preserve Vietnamese Unicode marks for exact-match labels.
3. Split by book (or at minimum page) so near-duplicate words from the same
   page do not leak across train and test.
4. Hold out an independent validation set.
5. Evaluate engines and model versions separately.
6. Report Word Exact Match Accuracy, CER, WER, Brier Score, ECE, reliability
   diagrams, high-confidence precision and coverage.
7. Promote a calibrator only when sample size and held-out evaluation justify
   it. Until then `calibrated_confidence` remains null.

## 10. Source files

- `backend/app/services/ocr_engine.py`
- `backend/app/services/admin_ocr_service.py`
- `backend/app/schemas/admin_ocr.py`
- `backend/app/schemas/book.py`
- `backend/app/repositories/admin_ocr_repository.py`
- `backend/app/models/book.py`
- `backend/app/services/reading_content_service.py`
- `backend/test_ocr_engine.py`
- `backend/test_reading_content_service.py`
- `frontend/components/admin/admin-ocr-review-screen.tsx`
- `frontend/lib/api/ocr-review-service.ts`
- `frontend/types/admin.ts`
- `frontend/lib/reading/realtime-alignment.ts`
- `frontend/components/reading/book-page-content.tsx`
- `frontend/components/reading/word-highlight-overlay.tsx`
- `frontend/components/reading/reading-screen.tsx`
