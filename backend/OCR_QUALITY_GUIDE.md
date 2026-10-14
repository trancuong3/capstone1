# OCR quality guide for ReadAlong Vision

## Pipeline

The Admin OCR endpoint continues to use the local Tesseract engine. The default production strategy now evaluates a bounded set of candidates: CLAHE with PSM 3, grayscale with PSM 3, Otsu thresholding with PSM 4, and adaptive thresholding with PSM 6 when the image is large enough for a safe adaptive threshold window. On small source images, candidates use uniform upscale capped at 2x / 1800 px maximum side target. Uniform scaling preserves normalized box coordinates.

The ranking heuristic combines valid Tesseract confidence, confidence coverage, the number of detected words relative to the candidate with the most words, printable text ratio, and replacement-character penalty. It is a candidate-ranking heuristic, not a calibrated probability of correctness. An admin must still review and verify the revision.

The old single-pass CLAHE + PSM 3 strategy remains available for comparison using the engine's baseline mode.

## Configuration

- TESSERACT_CMD: optional path to the Tesseract executable if it is not in PATH.
- OCR_TESSERACT_TIMEOUT_SECONDS: per-candidate execution timeout in seconds; defaults to 20 and is clamped to 5–60.
- OCR_LOW_CONFIDENCE_THRESHOLD: warning threshold in the range 0–1; defaults to 0.65.

Install Tesseract OCR 5.x and compatible Vietnamese vie.traineddata on the Backend host. The Python pytesseract package alone does not install the binary or the language model. You can test language availability with the runtime diagnostics command documented in ADMIN_BOOKS_OCR_SETUP.md.

If you choose to use the tessdata_best model, replace the Vietnamese traineddata file in the configured Tesseract data directory with a compatible version and restart the Backend. Do not commit large model files or secrets to the repository. Measure speed and quality on the same reviewed ground-truth set before keeping a new model in production.

## Reproducible benchmark

Create a JSON manifest outside the repository, for example:

    [
      {"image": "page-01.jpg", "ground_truth": "Nội dung chính xác đã được con người kiểm tra."},
      {"image": "page-02.png", "ground_truth": "Trang tiếp theo đã được kiểm tra."}
    ]

Image paths are relative to the manifest file unless absolute. Ground truth must be verified manually; do not use OCR output as ground truth. Keep copyrighted scans and private material out of Git unless you have permission and a clear need.

From the backend directory, run:

    python -m scripts.benchmark_ocr --manifest path/to/manifest.json

The script reports per-image and mean CER/WER for the old baseline and current multi-candidate mode. It preserves Vietnamese diacritics by applying Unicode NFC and whitespace normalization only. Lower CER/WER is better. The benchmark does not measure latency and does not prove improvement unless representative images and verified ground truth are provided.

## Coordinate contract

Every box is stored as normalized [x, y, width, height] coordinates. The current candidate transforms preserve geometry and use uniform scaling only, so normalized coordinates map onto the original visual page. If future work adds perspective correction, rotation, or cropping, it must implement and test inverse coordinate transforms before shipping that preprocessing path.

## Review and privacy

Every newly uploaded or reprocessed revision remains NEEDS_REVIEW. Never automatically verify OCR text. Preserve old revisions and current verified revision references. Keep OCR text, page images, access tokens, signed URLs and Supabase server keys out of logs.
