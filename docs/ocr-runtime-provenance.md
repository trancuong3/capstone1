# VietOCR Runtime Checkpoint Provenance — TASK 04

> Scope: `feat/ocr-runtime-provenance`. No model activation, weight changes, deployment, or production writes.

## What was proven, and what was not

The active-model registry is a **desired state**, not proof of the
model that a running Render process currently holds in RAM. A read-only
Supabase query on 2026-11-20 found:

| Registry field | Observed |
|---|---|
| `profile` | `FLOW1_EXTERNAL_TRDG` |
| `checkpoint_sha256` | `200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6` |

**This does NOT prove that a production Scan used Flow 1**, and does not
prove that any weights were fine-tuned or passed a benchmark. There was
no authorized production deployment/runtime introspection for this task.

Original is locked to upstream VietOCR `0.3.12`, architecture and
vocabulary lock, and expected weight SHA256
`380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59`.
That constant is an expected artifact fingerprint, not itself runtime
evidence. Flow 2 likewise must never be inferred to have run solely
because its registry profile was selected.

## How Scan evidence is generated

1. `refresh_active_viread_model()` reads the private Supabase registry
   using the existing short-timeout service-role client and caches the
   desired model. It is polled and can also be updated by an Admin
   decision; on registry failures it retains the last good pointer.
2. `_get_ocr_engines()` imports heavy torch/PaddleOCR/VietOCR modules
   lazily, under `_engine_lock`. This protects Render RAM at startup.
3. For Flow 1/2, `_v2_artifact_from_storage()` verifies the shard
   manifest, each chunk's length and digest, the assembled checkpoint
   digest, and optional YAML config digest. An existing cached checkpoint
   is reused only when its actual file bytes match the expected SHA256.
   Checkpoint assembly now uses uniquely named scratch files and an
   atomic `os.replace`; failed downloads delete their own scratch file.
4. For Original, the pinned version/architecture/vocabulary are
   checked, then the actual cached/downloaded Original weight file is
   hashed and compared with the lock.
5. Immediately before `Predictor(config)`, the candidate local file
   is **hashed again**. Only after successful initialization is
   `{model_profile, checkpoint_sha256, config_sha256}` registered against
   the actual Predictor object via `WeakKeyDictionary`. The registry
   SHA alone cannot populate provenance.
6. A Scan snapshots this per-Predictor proof *after lazy load and before
   inference*, into thread-local request context, so another worker's
   active model switch cannot change the metadata for the original
   engine. Line/crop preprocessing also selects by the actual instance
   rather than the mutable `_vietocr_active_profile` global.
7. `extract_text_and_boxes()` attaches the snapshot to the returned OCR
   `metadata`. Both Admin OCR upload and replace/reprocess already
   copy this metadata to `PageRevision.ProcessingMeta`. Admin revision
   read APIs remove sensitive source paths and preserve safe evidence.

### Metadata example (Illustrative test fixture, not a production claim)

```json
{
  "model_profile": "FLOW1_EXTERNAL_TRDG",
  "checkpoint_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "model_load_status": "loaded",
  "fallback_reason": null,
  "vietocr_runtime_provenance": {
    "provenance_version": "vietocr_loaded_checkpoint_v1",
    "model_profile": "FLOW1_EXTERNAL_TRDG",
    "checkpoint_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "config_sha256": null,
    "model_load_status": "loaded",
    "fallback_reason": null,
    "engine_version": "0.3.12",
    "model_inference_status": "success"
  }
}
```

The example SHA is synthetic. Never use it to identify the production
checkpoint. `model_profile` indicates the profile under which the
*verified checkpoint file was loaded* into the Predictor, not training
quality, model authorship or the selected token's accuracy. The
`model_inference_status` field distinguishes model load from inference
success. `ocr_metadata.line_evidence` still explains line-level
selection and fallback to PaddleOCR.

### Status semantics

| `model_load_status` | Meaning |
|---|---|
| `loaded` | Verified on-disk SHA associated with the actual successful Predictor |
| `fallback_loaded` | Different verified model (usually Original) successfully loaded after desired checkpoint failed |
| `stale_loaded` | Previous verified Predictor still serving while a different desired checkpoint could not load |
| `unavailable` | No VietOCR Predictor available |
| `unverified` | Instance is untracked or old scan has no binding proof |
| `not_run` | Tesseract fallback or PaddleOCR did not provide line regions; **no** VietOCR checkpoint claimed |

Safe fallback codes: `checkpoint_unavailable_or_invalid`,
`model_initialization_failed`, `requested_checkpoint_not_loaded`,
`invalid_original_registry_pointer`, `unsupported_model_profile`,
`vietocr_inference_error`, `vietocr_no_result`,
`vietocr_unavailable`, `paddle_unavailable`, `paddle_no_text`, `paddle_inference_error`,
`tesseract_fallback`.

## Security / backwards compatibility

- Only model profile, *verified* SHA256, load/inference status, optional
  config SHA256, non-sensitive package version and enumerated reason code
  are exposed to Admin Diagnostics. There is no checkpoint path,
  manifest object path, signed URL, token, service key or exception text.
- Frontend sanitization permits only a known profile/status/reason
  vocabulary and a lowercase 64-character hex digest; arbitrary stored
  metadata cannot appear verbatim as runtime proof.
- Historical `PageRevision.ProcessingMeta` rows are **not** back-filled
  from the registry. Admin UI labels missing evidence as unverified.
- The scanned image, OCR words, chosen engine, verification and
  ownership contract are unchanged. This PR does not add checkpoints
  to DB or change the production active-model row.
- `WeakKeyDictionary` cannot keep retired 150 MB model weights alive.
- Limit of proof: the SHA authenticates the local bytes supplied to
  `Predictor` immediately before successful construction. It is not
  a tensor-by-tensor hash of the model already in GPU/CPU memory,
  nor proof of a training recipe or benchmark.

## Verification plan and gates

- `backend/test_ocr_runtime_provenance.py`: fake weight files,
  Original/Flow1/Flow2 instance hash, missing download, stale fallback
  under pointer swap, invalid digest, corrupt shard cleanup,
  Tesseract scan, and safe metadata.
- `frontend/tests/admin/ocr-runtime-provenance.test.ts`:
  restricted rendering for 3 profiles, stale fallback, invalid SHA/URL,
  legacy scan and no-run.
- Existing `backend/scripts/run_ci_tests.py` skip-audits all backend
  tests. Existing `backend/scripts/run_real_ocr_gate.py` exercises
  real PaddleOCR, VietOCR and Vietnamese Tesseract against synthetic
  fixtures without test skips. **Neither test alone proves any
  production Flow 1/2 checkpoint ran.**
- Before deploying, run on isolated staging with explicit approved
  test artifacts; perform one scan per selected profile and inspect
  saved `ProcessingMeta` with actual checkpoint digest; deliberately
  simulate failed artifact download and concurrent pointer switch.
  Record the exact process/build ID and scan revision ID for audit.
  Use a controlled deployment/rollback plan; leave the active
  production model unchanged without explicit approval.

## Operational rollback

This feature is only metadata and a read-only Admin display. If
staging reveals a regression, revert its feature branch commit and
re-run backend, frontend, Real OCR and E2E checks before any
deployment. Do not reset production model state as a debugging step.
