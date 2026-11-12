# ViRead VietOCR V2 workflow

This directory adds a separately versioned VietOCR fine-tuning and evaluation workflow. It keeps the installed VietOCR 0.3.12 Original checkpoint, vocabulary, input shape, and architecture locked; it does not train PaddleOCR or Tesseract.

## Data flows

**Flow 1: Admin VERIFIED revisions.** The existing Admin verification transaction inserts an ID-only outbox row before commit. The backend worker reads the verified revision, crops line images from saved word boxes, records the page as the split group, and writes private image objects and sample provenance. The worker retries idempotently and dead-letters after eight failed attempts. Only train and validation samples enter Flow 1 training snapshots; holdout samples stay out of training.

**Flow 2: external labels and synthetic images.** `flow2_prepare.py` accepts human-verified line annotations, matches them one-to-one against the existing DBNet detector, and sends low-confidence or ambiguous boxes to `needs_review.json`. `trdg_generate.py` creates synthetic samples from an explicitly supplied Vietnamese text file and font, recording font hash and generation seed. After reviewing the external manifest, use `flow2_register.py` to upload either or both manifests and preserve per-sample source flow and provenance. It uses `VIREAD_API_BASE` and `VIREAD_ADMIN_BEARER` from the environment and never prints the bearer token.

Prepare external crops in the pinned backend environment, and generate synthetic rows in the training environment:

```powershell
python -m ai.vietocr_v2.flow2_prepare --annotations data/external_annotations.json --output work/flow2
python -m ai.vietocr_v2.trdg_generate --texts data/vietnamese_training_text.txt --font data/vietnamese-font.ttf --output work/flow2
```

**Locked Test.** Keep test references in a separate human-reviewed JSON array. Each row needs `sample_id`, `group_id`, `image`, `label` (or `reference`), `annotation_id`, and `verified: true`. Register it separately with `flow2_register.py --locked-test-manifest ...`; Locked Test rows cannot enter a training JSONL. Do not generate test labels or metrics from model predictions.

Example registration:

```powershell
$env:VIREAD_API_BASE = 'https://your-backend.example/api/v1'
$env:VIREAD_ADMIN_BEARER = '<Admin access token>'
python -m ai.vietocr_v2.flow2_register `
  --external-manifest data/flow2_external.jsonl `
  --trdg-manifest data/flow2_trdg.jsonl `
  --trdg-provenance data/flow2_trdg_provenance.json `
  --locked-test-manifest data/locked_test_source.json
```

The external and TRDG manifests can be registered independently by supplying either manifest alone. Flow 2 records share one dataset version only when both sources are supplied together. Registration uploads image bytes to the existing private Storage bucket and verifies SHA-256 before accepting the version.

## Training and promotion

Run `viread_vietocr_v2_colab.ipynb` in Colab after the feature branch is available on GitHub and the backend migration and API are deployed. Set `VIREAD_API_BASE` and `VIREAD_ADMIN_BEARER` in Colab Secrets. The notebook downloads the active checkpoint by hash, stores checkpoints on Drive for resume, uploads candidate shards within the 40 MiB object limit, and compares Original and V2 predictions on the separately registered Locked Test set.

The backend recomputes paired CER/WER and document-group bootstrap intervals from the submitted outputs, applies the quality gate, and requires a human Admin decision before the active model pointer changes. Every decision retains the previous checkpoint pointer for rollback. The backend verifies model artifacts and keeps its last working engine if the active V2 artifact cannot be loaded.

No training data or benchmark metrics are bundled here. A real training run remains pending human-verified source data and an available Colab GPU; until then, Original remains active.
