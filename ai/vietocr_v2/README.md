# ViRead VietOCR V2

ViOCR V2 is one VietOCR `vgg_transformer` model lineage with two separate training profiles. Each run selects exactly one dataset source. The model family, locked Original vocabulary, architecture, input shape, checkpoint lineage, benchmark, approval, and rollback are shared. The Original checkpoint is never overwritten. PaddleOCR/DBNet is used only for text detection; Tesseract and PaddleOCR are not trained.

## Flow 1: real data + DBNet + TRDG

This flow starts with real images and human-reviewed line text/boxes. DBNet proposals are matched one-to-one to the supplied annotations; weak or ambiguous matches go to `needs_review.json`, and only accepted matches become crops. TRDG creates a separate synthetic corpus from a curated Vietnamese text file. Pass multiple reviewed font files to increase font variety. The registration step keeps real and synthetic provenance separate inside one Flow 1 dataset version.

Target range before a production run: 500–1,000 real line samples and 20,000–50,000 TRDG samples. The trainer and backend both block runs below or above those ranges. Data is split by source group at 70/15/15; a group never crosses train, validation, and holdout. Locked Test is registered separately.

```powershell
python -m ai.vietocr_v2.flow1_prepare --annotations data/external_annotations.json --output work/flow1
python -m ai.vietocr_v2.flow1_trdg_generate --texts data/vietnamese_training_text.txt `
  --font data/fonts/font-a.ttf --font data/fonts/font-b.ttf --count-per-text 40 --output work/flow1

$env:VIREAD_API_BASE = 'https://your-backend.example/api/v1'
$env:VIREAD_ADMIN_BEARER = '<Admin access token>'
python -m ai.vietocr_v2.flow1_register `
  --external-manifest work/flow1/flow1_external.jsonl `
  --trdg-manifest work/flow1/flow1_trdg.jsonl `
  --trdg-provenance work/flow1/flow1_trdg_provenance.json `
  --locked-test-manifest data/locked_test_source.json
```

The external annotation input must include an image path, human-verified label, unique annotation ID, source group, and explicit line bounding box. Do not generate real labels from OCR predictions. The TRDG text corpus and Vietnamese font files must be supplied and reviewed by the dataset owner; this repository does not fabricate them.

## Flow 2: Admin VERIFIED image + ground truth

When an Admin confirms a page revision, the same database transaction creates a durable outbox event. The worker reads that exact page and revision, groups the verified word boxes by line, orders words by `wordindex`, and crops one image per line. The label is the confirmed words in that line. Each sample retains its page, revision, source image hash, line index, private crop object path, and label provenance. Retries are idempotent. This is an independent dataset and does not ingest Flow 1 external or TRDG rows.

The interactive free Colab notebook supports both `FLOW1_EXTERNAL_TRDG` and `FLOW2_ADMIN_VERIFIED`: after a user starts a GPU runtime and runs the cell, it claims at most one ready job, downloads and verifies the exact dataset and parent checkpoint, trains, uploads, benchmarks, and reports status. It does not poll continuously or start a Colab runtime remotely. Rerun the cell for another queued job. Google Colab Free resources are not guaranteed and a runtime can disconnect; the persistent job folder is mounted from Google Drive so a later session can resume the same job when its checksummed state is intact. For unattended paid execution, the separate [Colab Enterprise setup checklist](../../docs/viread-colab-enterprise-setup.md) requires Google Cloud resources and can incur charges. See [the architecture and operations guide](../../docs/viread-vietocr-auto-training.md) for readiness and limitations. Page-level Flow 2 groups stay together in the 70/15/15 split. Training waits unless both train and validation groups exist; one page can produce many line crops but only one split, so it cannot by itself provide validation.

The internal source identifier `FLOW1_VERIFIED` and older profile names remain in stored rows for backward compatibility. The user-facing training profiles are now `FLOW1_EXTERNAL_TRDG` and `FLOW2_ADMIN_VERIFIED`; the Admin screen displays those meanings instead of exposing the legacy identifiers.

## Colab training, benchmark, and model control

`viread_vietocr_v2_colab.ipynb` remains the manual GPU runner for both profiles. `viread_vietocr_v2_colab_worker.ipynb` is the interactive free queue worker: each user-started run claims at most one job and exits. For unattended training, the backend can dispatch a job-pinned one-shot notebook to Colab Enterprise through the separately deployed Cloud Run dispatcher. That optional path requires Google Cloud billing, a runtime template, Secret Manager, IAM, and the additive migration; see [the paid setup checklist](../../docs/viread-colab-enterprise-setup.md). A stopped standard Colab runtime requires a person to reconnect and run the cell again.

The Colab worker installs `requirements-colab.txt`, a separate Python 3.12/3.13 training-runtime lock. It omits TRDG because the worker consumes registered datasets rather than generating the Flow 1 corpus; local Flow 1 generation keeps using `requirements.txt` and its existing NumPy 1.26 pins. The Colab lock matches NumPy 2.4.6 preloaded by the current Colab runtime and OpenCV 4.13.0.92, avoiding an in-place replacement of a NumPy module already imported by the notebook kernel; it also leaves Pillow at the Colab-provided version for the same reason. The notebook installs the pinned VietOCR 0.3.12 wheel with `--no-deps` because its published metadata pins unavailable legacy `gdown==4.4.0`; compatible VietOCR runtime dependencies, including `prefetch-generator` used by its dataloader, are explicitly included in the Colab lock. Narrow compatibility adapters use `frombuffer` only at VietOCR's two binary `fromstring` call sites (image validation and LMDB dimensions), and restore its removed Pillow `ANTIALIAS` alias when needed; they do not replace NumPy globally or modify installed packages. The dataloader also corrects VietOCR 0.3.12's off-by-one LMDB sample count so every stored image-label pair is included. The adapters supply the `sctypes` and `complex` names used by VietOCR 0.3.12's pinned imgaug. Before it claims a job, the notebook imports the complete training stack and verifies the pinned package versions. The job config records hashes for both dependency files, and the worker rejects a stale or mismatched lock.

The trainer starts from the hash-locked Original or current approved VietOCR V2 parent. It keeps the `vgg_transformer` architecture and vocabulary fixed, preprocesses local line-image copies with conservative deskew, denoising and luminance CLAHE, resizes/pads through the pinned VietOCR loader, uses AdamW and cosine scheduling, enables fp16 on CUDA, freezes the VGG feature extractor for five data passes, then unfreezes it at a `1e-5` learning rate. Batch size defaults to 32 and can be lowered for smaller GPUs. Resume requires the same profile, dataset, parent, and training configuration. The uploaded candidate is selected from the lowest measured validation loss, with its step and checkpoint hash recorded in the resume state.

Every candidate must pass the independent paired Locked Test benchmark and statistical quality gate. A passing result still requires Admin approval before the active-model pointer changes. Rejected candidates remain inactive; rollback uses the recorded previous pointer. No Colab run or benchmark is claimed until a real GPU execution and report exist.

## Current limitations

- This repository does not include real image datasets, a curated Vietnamese text corpus, reviewed font assets, Locked Test labels, or Colab credentials/GPU execution evidence.
- The admin-confirmed dataset currently represents one sample per verified line, not one per word. For the displayed example, eight distinct line indices correctly produce eight line samples; all words on each line remain in that line's ground-truth label.
- Vietnamese n-gram/spell-check post-correction is not enabled. It needs a reviewed Vietnamese lexicon/corpus and paired evaluation before it can safely rewrite OCR output. Training labels are never autocorrected.
- The registered-data and checkpoint APIs use the existing ViRead backend, Supabase project, and private Storage bucket. Deploy the additive migration and matching backend before using the new profiles; this code does not create or upgrade a Supabase project.
