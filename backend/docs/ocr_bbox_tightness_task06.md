# TASK 06 — Offline word-box tightness investigation

**Purpose:** Explain why 10 synthetic ViRead pages achieved 130/130 matches
at IoU 0.50 but only 46/130 at IoU 0.75. The new scripts are diagnostic:
there is **no** production bbox, OCR model, preprocessing, or API change.

## Inputs / rules

- The existing `ViRead_TASK05_mau_10_anh_IoU.zip` fixture uses renderer-created
  Vietnamese text and reference boxes. It is **not** a human-annotated photo
  benchmark. Do not claim OCR photo acceptance from this fixture.
- Output JSON contains numerical aggregates only. Optional overlays contain
  the image pixels and must stay in the same **private dataset** directory.
- Red rectangles show **reference labels**, blue rectangles show **actual OCR
  predictions**. Overlays never write private words as additional text.
- Nine fixed what-if hypotheses scale predicted bbox width and height around
  their centers to 90%, 100%, or 110%; image boundaries are respected.
  These transformed boxes are evaluated **offline**, never returned to
  production clients or written back to the backend/database.
- Baseline is kept separate. Geometry-only and exact NFC text+geometry
  precision/recall/F1 at IoU 0.50 and 0.75 are always both available.
- Median width/height ratios and best-overlap histograms are **descriptive**,
  not one-to-one box metrics. Compare using the scorer's F1 instead.
- A larger in-sample F1 on renderer labels is **not enough** to approve
  algorithm changes. Repeat on independent photo labels and held-out pages.

## Windows: tests and checkout

```powershell
git -C "F:\c1\capstone1" fetch origin
git -C "F:\c1\capstone1-ocr-acceptance" switch --detach origin/test/ocr-box-tightness-offline-probe
$py = "F:\c1\capstone1\.venv\Scripts\python.exe"
$backend = "F:\c1\capstone1-ocr-acceptance\backend"

& $py -m unittest discover -s $backend -p "test_ocr_box_tightness.py" -v
& $py -m unittest discover -s $backend -p "test_ocr_box_tightness_probe.py" -v
& $py -m unittest discover -s $backend -p "test_ocr_word_box_iou.py" -v
& $py -m unittest discover -s $backend -p "test_ocr_real_photo_benchmark.py" -v
```

## Windows: evaluate the existing synthetic fixture (real OCR, not self-check)

The `viread_task05_sample` folder must already have been extracted from the
ZIP under `F:\c1\ocr-private-eval\sample-...\`. Find it without assuming
a fixed timestamp:

```powershell
$folder = Get-ChildItem "F:\c1\ocr-private-eval" -Directory -Recurse -Filter "viread_task05_sample" |
  Where-Object { Test-Path (Join-Path $_.FullName "synthetic_renderer_labels.jsonl") } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $folder) { throw "Unzip the existing TASK05 fixture first." }
cd $backend
$stamp = Get-Date -Format "yyyyMMdd-HHmmss-ffff"

& $py scripts\ocr_box_tightness_probe.py `
  "$folder\pages.jsonl" `
  --reference-labels "$folder\synthetic_renderer_labels.jsonl" `
  --reference-kind synthetic_renderer `
  --env-file "F:\c1\capstone1\backend\.env" `
  --min-pages 10 `
  --expected-profile FLOW1_EXTERNAL_TRDG `
  --expected-sha 200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6 `
  --output "$folder\aggregate-tightness-$stamp.json" `
  --overlay-dir "$folder\overlays-tightness-$stamp"
if ($LASTEXITCODE -ne 0) { throw "Offline tightness probe failed" }
```

Do not upload `$folder\overlays-tightness-*`, image files, labels,
`pages.jsonl`, or `.env`. Only aggregate counts should be shared.

## Read the report

```powershell
$report = Get-Content "$folder\aggregate-tightness-$stamp.json" -Raw | ConvertFrom-Json
$report.results.baseline.'0.75'.geometry
$report.results.baseline.'0.75'.strict_word_and_geometry
$report.results.baseline_shapes
$report.results.bbox_tightness_hypotheses.width_110_height_110.scores.'0.75'.geometry
```

Check that baseline remains reproducible with 130 predictions, 130
renderer words, 130 TP at 0.50 and 46 TP at 0.75, before interpreting the
box-resizing hypotheses. Any difference needs investigation, not an invented
explanation. Manual photographs, independent annotation/provenance, and
reading-color evaluation remain separate unverified acceptance gates.
