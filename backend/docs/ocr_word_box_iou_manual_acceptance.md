# TASK 05 — Private hand-labeled word-box IoU evaluation

This is a **diagnostic tool**, not an automatic proof of OCR acceptance.
Do not push, upload or paste private photos, extracted words or annotation
JSONL files to GitHub/CI/chat. The aggregate JSON contains counts only.

## Label contract and independence

1. Work only with original photos in a private folder outside the repository
   (example: `F:\c1\ocr-private-eval\images\`).
2. **Independently mark every visible word** using the original pixels,
   without viewing or copying OCR-predicted boxes. Include words missed by OCR.
3. The annotation file must have **one JSONL object per image**, with exact
   relative `image` paths from `pages.jsonl`. There can be no missing pages,
   empty reference lists or duplicate page identifiers.
4. A reference word is stored as `{"text":"Bé","bbox":[x,y,w,h]}`,
   in normalized **original-image** coordinates. Each entry must contain exactly **one whitespace-delimited word**, not an entire phrase or line. If the original dimensions
   are `W x H` and the hand-drawn rectangle is `left,top,right,bottom`
   in original pixels, calculate:
   `x=left/W`, `y=top/H`, `w=(right-left)/W`, `h=(bottom-top)/H`.
5. Confirm each page has been independently reviewed, change
   `annotation_source` to `"manual_independent"` and
   `reviewer_confirmed` to `true` **only after actual human annotation**.
   Self-declaration is not independent external proof of provenance.
6. Never automatically populate reference boxes from PaddleOCR/VietOCR
   predictions, since this invalidates the IoU measurement.

Example (synthetic values only; no real page/word labels):
```json
{"image":"images/example.png","annotation_source":"manual_independent","reviewer_confirmed":true,"coordinate_space":"normalized_original_dimensions","words":[{"text":"Bé","bbox":[0.10,0.20,0.08,0.04]},{"text":"đọc","bbox":[0.20,0.20,0.12,0.04]}]}
```

## Safe Windows commands

First fetch and check out the feature branch in the separate worktree:
```powershell
git -C "F:\c1\capstone1" fetch origin
git -C "F:\c1\capstone1-ocr-acceptance" switch --detach origin/test/ocr-manual-word-box-iou-acceptance
$py = "F:\c1\capstone1\.venv\Scripts\python.exe"
$backend = "F:\c1\capstone1-ocr-acceptance\backend"
& $py -m unittest discover -s $backend -p "test_ocr_word_box_iou.py" -v
& $py -m unittest discover -s $backend -p "test_ocr_word_box_iou_acceptance.py" -v
& $py -m unittest discover -s $backend -p "test_ocr_bbox_annotation_template.py" -v
& $py -m unittest discover -s $backend -p "test_ocr_real_photo_benchmark.py" -v
```

Generate an **unverified, empty** annotation skeleton locally. Never publish it.
```powershell
cd $backend
& $py scripts\ocr_bbox_annotation_template.py `
  "F:\c1\ocr-private-eval\pages.jsonl" `
  --output "F:\c1\ocr-private-eval\bbox-annotations-draft.jsonl"
```

After independently annotating **all** words on all 10 photos and
confirming the declarations, save the completed file under a new local
filename (for example `bbox-annotations-manual.jsonl`).

Run the geometry + exact-word positioning benchmark:
```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
& $py scripts\ocr_word_box_iou_acceptance.py `
  "F:\c1\ocr-private-eval\pages.jsonl" `
  --bbox-annotations "F:\c1\ocr-private-eval\bbox-annotations-manual.jsonl" `
  --env-file "F:\c1\capstone1\backend\.env" `
  --min-pages 10 `
  --expected-profile FLOW1_EXTERNAL_TRDG `
  --expected-sha 200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6 `
  --output "F:\c1\ocr-private-eval\aggregate-iou-$stamp.json"
```

The script refuses missing/duplicate/unreviewed annotations, unexpected
checkpoint or failed engine statuses, and output overwrites. It prints only
aggregate numbers. Keep the optional photo/annotation files local.

## What the metrics mean

At each threshold (0.50 and 0.75) the algorithm calculates **separate**
maximum one-to-one bipartite matchings:

- `geometry`: predicted/reference boxes with IoU at least the threshold,
  regardless of recognized word text.
- `strict_word_and_geometry`: **both** IoU at least the threshold and exact
  NFC token identity. Case, Vietnamese diacritics, đ/d, punctuation and
  internal symbols remain significant.

Both produce TP, FP, FN, precision, recall and F1 using total predicted and
reference word counts. Invalid predicted boxes remain in the FP denominator.
Maximum-cardinality matching prevents a duplicated prediction from being
counted twice against the same truth word. Reported values are micro-aggregates
over successfully scored pages, **not** IoU accuracy on pages never labeled.

Do not mistake any result for verified photo provenance, color-based reading
feedback, or predeclared product quality gates. Those remain separate tasks.
