# Box geometry correction — 2026-11-11

This correction addresses master prompt §19.1–19.2, Phase 6 and Phase 7: word highlights must fit the source, and unreliable geometry must use readable OCR text. It does not add an OCR engine or rewrite an existing revision.

## Reproduced defect

The word segmentation routine applied inverse adaptive thresholding before normalizing light text on dark backgrounds. It could segment background regions and then force the resulting regions to match the token count. The shared background normalizer also excluded pixels exactly equal to the Otsu threshold from its dark class, missing clean two-tone screenshots.

Regression tests reproduced the wrong word coverage before correction. Five synthetic Vietnamese text lines, including the title and sentence patterns in the user's screenshot, show mean horizontal box overlap increasing from 0.5858 to 0.92884 after correction. These are local raster geometry measurements on generated text, not recognition accuracy or measurements on the user's saved page.

## Resulting behavior

- Both line segmentation and the Tesseract fallback normalize background polarity while retaining source coordinates.
- Blank regions and regions requiring forced splitting/merging may retain provisional boxes for Admin review, but do not authorize reading-image overlays.
- New OCR metadata records a versioned geometry decision and a fingerprint of ordered word indices, line indices, Vietnamese text, normalized boxes and source dimensions. Invalid/duplicate/excessively overlapping boxes are rejected. Editing that content invalidates the old decision automatically.
- Reading responses add `image_overlay_safe`. The backend sets it only when the selected revision's stored geometry evidence matches its current words and source dimensions. The frontend requires explicit `true` in addition to existing range, identity, aspect-ratio and readability checks.
- Missing/false geometry decisions use the existing image-reference plus OCR-text mode. Current-word highlighting and first-pass/retry state continue by the same `word_id`. OCR text confidence and reading correctness do not decide image geometry.

The evidence is a conservative geometric eligibility check, not a claim of perfect OCR or manual box verification on every real image. Existing content verification and page/revision ownership checks remain required.

## Existing data and compatibility

Existing revisions without the new evidence deliberately use text fallback. Their image remains available as a reference. No stored text, word ID, box, score, retry event or historical revision is modified during reading; there is no database migration or backfill.

An existing page is not silently OCRed again. If an administrator later wants a fresh image overlay, a new OCR/review/verification workflow must produce geometry that passes the new checks. Editing an old revision's metadata alone is not a repair.

Deploy the backend/frontend contract together. The optional frontend field tolerates older responses safely by using text fallback; the backend defaults the field to false. New metadata lives in the existing JSON column. No dependency was added.

## Local validation

The isolated evidence directory is `viread-box-fix-20261111-a1` beside the repository. It contains before/after logs, regression results, source snapshots, patches and rendered evidence. Final aggregate counts are recorded after each process terminates; earlier handoff counts are not relabeled as this run.

| Check                                            | Actual result                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Complete frontend Vitest                         | 1,710/1,710 passed; 104 files; 634.47 seconds                                |
| Complete isolated backend                        | 758 collected: 731 passed, 27 skipped, zero failures/errors; 100.200 seconds |
| Complete browser run                             | 112 collected: 97 passed, one catalog failure, 14 skipped; 11.6 minutes      |
| Focused catalog rerun, same source/assertions    | 2/2 passed on desktop/mobile; does not relabel the complete run              |
| Typecheck / ESLint / Prettier / production build | Passed; ESLint retains 12 existing warnings                                  |
| Client bundle synthetic canaries                 | Zero matching files among 78 scanned                                         |

The full browser failure is in `real-data.pw.ts` (`Parent dashboard → catalog → real book metadata with unavailable preview`): the expected preview-unavailable message was absent and the log recorded navigation back to `/books`. The exact navigation/race cause is not established. The catalog source/assertions were not changed, and the focused rerun passed both projects. Reading/box/fallback scenarios in the complete run passed; do not describe the complete project browser run as fully green. Raw full-run JSON, error context and screenshot are preserved separately from the focused rerun.

The 27 backend skips comprise 22 database-gated cases and five unavailable real OCR-engine gates. The 14 browser skips comprise eight opt-in PostgreSQL cases and six duplicate mobile viewport-matrix cases; those eight database browser cases were not rerun in this correction. Previous database test results are historical evidence on the earlier source, not a new database acceptance result here.

Retained guarded commands are `backend.py --discover`, `frontend.mjs full`, `checks.cjs`, `build.cjs`, `browser-full.cjs --fully-parallel --workers=2` and `catalog-recheck.cjs --grep "Parent dashboard" --workers=1`. They invoke installed project executables, disable dotenv/outbound services and use sanitized copies for build/browser. `geometry-before-after.png` and `geometry-comparison.json` show the synthetic raster comparison; the browser run also saves `reading-untrusted-boxes.png` for both projects.

Focused regression tests cover both image polarities and two-tone backgrounds, blank/forced geometry, inverse mapping to original source coordinates, measured Tesseract boxes with a mocked recognizer, stale/modified geometry evidence, legacy revision fallback, API-field parsing and preservation of word/current/error identity. Browser scenarios cover both eligible overlays and normalized but untrusted boxes on desktop/mobile.

No `.env`/real secret was read by the guarded checks. No actual database, provider, storage call, microphone recording, migration or Git publication was used. The project's manual servers stay stopped; any isolated test server is stopped after validation.

Real OCR model quality and the user's exact saved page/revision remain outside the evidence collected here. Five unavailable real OCR engine tests and database-gated tests must not be called passed in the final isolated backend run. Previous real-audio/provider/storage/device and upstream integration limitations still apply.

## Subsequent user acceptance

After the corrected frontend/backend were restarted with the existing application configuration for user testing, the user reported the box presentation was satisfactory and requested shutdown. Both application process trees were stopped and ports 3000, 3106 and 8000 were verified free. This records user-reported visible behavior only; it does not identify the tested database revision, measure real OCR/STT accuracy or establish provider/storage acceptance. The user then authorized committing and pushing the feature branch without merging; see [delivery status](DELIVERY.md).
