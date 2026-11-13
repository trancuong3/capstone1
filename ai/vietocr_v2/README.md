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

The manual notebook can still be used for either profile. The optional automatic Flow 2 worker is described in [viread-vietocr-auto-training.md](../../docs/viread-vietocr-auto-training.md) and runs from `viread_vietocr_v2_colab_worker.ipynb`. It polls jobs made from `/books/admin/viread-training/datasets/flow2-admin-verified`; no per-job cell edits are needed. Page-level groups stay together in the 70/15/15 split. Training waits unless both train and validation groups exist; one page can produce many line crops but only one split, so it cannot by itself provide validation.

The internal source identifier `FLOW1_VERIFIED` and older profile names remain in stored rows for backward compatibility. The user-facing training profiles are now `FLOW1_EXTERNAL_TRDG` and `FLOW2_ADMIN_VERIFIED`; the Admin screen displays those meanings instead of exposing the legacy identifiers.

## Colab training, benchmark, and model control

`viread_vietocr_v2_colab.ipynb` remains the manual GPU runner for both profiles. `viread_vietocr_v2_colab_worker.ipynb` is the Flow 2 queued worker: once its secrets are configured and its GPU runtime is connected, it automatically claims Flow 2 jobs, downloads the selected dataset and parent checkpoint, resumes from Google Drive, uploads the candidate and runs the paired benchmark. A stopped standard Colab runtime must be reconnected by an operator; Google Cloud has a separate supported start API for Colab Enterprise, but this repository has no Enterprise runtime configuration or identity. See [the setup guide](../../docs/viread-vietocr-auto-training.md).

The trainer starts from the hash-locked Original or current approved VietOCR V2 parent. It keeps the `vgg_transformer` architecture and vocabulary fixed, preprocesses local line-image copies with conservative deskew, denoising and luminance CLAHE, resizes/pads through the pinned VietOCR loader, uses AdamW and cosine scheduling, enables fp16 on CUDA, freezes the VGG feature extractor for five data passes, then unfreezes it at a `1e-5` learning rate. Batch size defaults to 32 and can be lowered for smaller GPUs. Resume requires the same profile, dataset, parent, and training configuration. The uploaded candidate is selected from the lowest measured validation loss, with its step and checkpoint hash recorded in the resume state.

Every candidate must pass the independent paired Locked Test benchmark and statistical quality gate. A passing result still requires Admin approval before the active-model pointer changes. Rejected candidates remain inactive; rollback uses the recorded previous pointer. No Colab run or benchmark is claimed until a real GPU execution and report exist.

## Current limitations

- This repository does not include real image datasets, a curated Vietnamese text corpus, reviewed font assets, Locked Test labels, or Colab credentials/GPU execution evidence.
- The admin-confirmed dataset currently represents one sample per verified line, not one per word. For the displayed example, eight distinct line indices correctly produce eight line samples; all words on each line remain in that line's ground-truth label.
- Vietnamese n-gram/spell-check post-correction is not enabled. It needs a reviewed Vietnamese lexicon/corpus and paired evaluation before it can safely rewrite OCR output. Training labels are never autocorrected.
- The registered-data and checkpoint APIs use the existing ViRead backend, Supabase project, and private Storage bucket. Deploy the additive migration and matching backend before using the new profiles; this code does not create or upgrade a Supabase project.
