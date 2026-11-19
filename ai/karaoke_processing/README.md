# Local karaoke engine — experimental, not production-approved

This directory is a separate CPU environment, **not** the backend/OCR venv.
The automatic-import quality gate has not passed. Do not enable production
on the basis of synthetic fixtures or the short research composite smoke.

## Dependencies and pinned assets

Tested locally on Windows, Python 3.13.3, CPU-only. Install into a new environment:

```powershell
# From repository root; never target backend/.venv.
py -3.13 -m venv .cache/karaoke-ai/.venv
.\.cache\karaoke-ai\.venv\Scripts\python.exe -m pip install -r ai/karaoke_processing/requirements.txt
```

The Vietnamese checkpoint is
[nguyenvulebinh/lyric-alignment](https://huggingface.co/nguyenvulebinh/lyric-alignment),
revision `2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed`.
Weights are **CC-BY-NC-4.0**; this implementation is research-only until licensing
and the representative-song quality gate are resolved. Do not infer a weights
license from the Apache-2.0 inference source.

Download the public revision only after checking those terms. The installed
huggingface_hub dependency can use `snapshot_download` with `token=False`,
`revision` above and `allow_patterns=["*.json","pytorch_model.bin","README.md"]`.
The engine verifies every required file against [model_pins.py](model_pins.py)
before loading, disallows remote code and runs offline.

Stem separation uses the official Demucs 4.0.1 `htdemucs` checkpoint:
[upstream model list](https://github.com/facebookresearch/demucs/blob/v4.0.1/demucs/remote/files.txt),
[upstream code license](https://github.com/facebookresearch/demucs/blob/v4.0.1/LICENSE).
Download `955717e8-8726e21a.th` from
`https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th`
into a dedicated model directory. Expected size: 84,141,911 bytes.
Full SHA256:
`8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`.
Runtime verifies this digest and loads with `weights_only=True` plus a minimal
allowlist for the pinned architecture, Fraction and numpy scalar/dtype types.

The stem recipe identity includes `active-anchors-v2` independently of these
unchanged weights. MP3 clock verification keeps informative beginning/middle/end
anchors and searches a silent/DC-only anchor's third for an informative source
window. Selection uses source energy only; a mismatch at any selected anchor
still rejects. Correlation 0.85, maximum 20ms lag and 40ms duration delta are not
relaxed. Entirely uninformative audio cannot prove a clock. Diagnostics record
the actual positions/version, and the backend fences old stem recipe/cache reuse.

No model is downloaded by a job. No backend credentials are passed to the engine.
FFmpeg accepts local file/pipe input only; worker MP3 inputs use the MP3 demuxer.
Models, audio artifacts and Python environments must not be committed to Git.

## Worker configuration

API, worker, model cache and temp directory must run as the intended service
account. Python private temp directories on Windows are not automatically
readable by a different account. Do not loosen project/home ACLs to solve this;
create artifacts under the service account or use an explicitly managed shared
cache with appropriate access.

Use the karaoke settings in `backend/.env.example`. Paths below are placeholders:

```dotenv
KARAOKE_PROCESSING_ENABLED=false
KARAOKE_PROCESSING_WORKER_ENABLED=false
KARAOKE_PROCESSING_PIPELINE_VERSION=local-ctc-demucs-research-v4
KARAOKE_LOCAL_PYTHON=<absolute-path-to-isolated-python>
KARAOKE_LOCAL_ENGINE_SCRIPT=<repo>/ai/karaoke_processing/runner.py
KARAOKE_LOCAL_MODEL_PATH=<verified-vietnamese-checkpoint-directory>
KARAOKE_LOCAL_STEM_MODEL_PATH=<directory-containing-955717e8-8726e21a.th>
KARAOKE_TEMP_DIR=<dedicated-karaoke-job-temp-directory>
KARAOKE_MAX_RESERVED_AUDIO_MINUTES_PER_ADMIN_DAY=0
KARAOKE_MAX_RESERVED_AUDIO_MINUTES_GLOBAL_DAY=0
```

These are intentionally disabled/zero, not production defaults to copy and enable.
The example pipeline version identifies active-anchor clocks, ordered word edits
and the v3 acoustic boundary window; restart
API/worker together with a deliberately chosen new version for an approved rollout.
No real environment file is updated by changing this example.
Positive daily caps must be deliberately configured before enabling either process.
Audio-minute reservations limit processing volume, not a guaranteed monetary bill.
The local adapters make no external inference calls, but machine/hosting costs
and processing time still exist. No paid-provider adapter is installed.

Check configuration without starting a model or worker:

```powershell
.\backend\.venv\Scripts\python.exe -B scripts/check_karaoke_processing_readiness.py
# Optional, explicit reads of configured DB and model files:
.\backend\.venv\Scripts\python.exe -B scripts/check_karaoke_processing_readiness.py --check-schema --check-weights
```

Readiness does not prove an idle worker is alive, credentials have quota,
or alignment quality is acceptable. Use supervisor/process health for liveness.
Apply the additive migration separately with deployment approval; startup never
runs migrations. Keep the existing manual editor available.

When rollout prerequisites and permissions have been satisfied:

```powershell
# From backend, use backend dependencies (the worker spawns the isolated engine).
.\.venv\Scripts\python.exe -B -m app.jobs.karaoke_processing_worker --once
.\.venv\Scripts\python.exe -B -m app.jobs.karaoke_processing_worker
```

A disabled worker exits without claiming jobs. With worker_enabled true it can
drain existing jobs even if API enqueue is disabled. Ctrl+C/SIGTERM stops claims
and cancels the owned engine process tree. Ambiguous DB results retain ledger
and media. Expired local operations can safely retry under attempt limits;
ambiguous nonlocal calls still require explicit possible-charge acknowledgment.
Completed artifacts are hash-verified before reuse; outputs remain private and
never automatically apply, attest or publish.

Claims and expired-lease recovery are restricted to the configured pipeline
version. A worker never claims, fails or requeues a different version's jobs.
During a version change, drain the previous queue with its compatible worker
before retiring it, or cancel those jobs explicitly through the existing API.
Starting only the new worker leaves old-version jobs queued; the queue warning
does not prove that either worker is dead. Do not rewrite job versions in SQL
to force incompatible checkpoints through a new pipeline.

## Verification boundaries

- Backend fixture tests prove transaction, mapping, cache, lease and HTTP logic.
- AI pure tests prove signal-clock/envelope checks, not music quality.
- `scripts/smoke_karaoke_local_engine.py` runs a short local research composite,
  keeps artifacts local and explicitly reports NOT_EVALUATED for product quality.
- `test_karaoke_processing_engine_smoke.RealLocalEngineSmoke` is opt-in and uses
  the dedicated disposable PostgreSQL harness, real local models and in-memory
  Storage. It is not live Supabase or a representative-song benchmark.
- `INSTRUMENTAL_WITH_REFERENCE` requires measurable common backing at multiple
  anchors. Same duration alone, a pure vocal-only reference, a shifted/cut/warped
  recording or a flat uninformative envelope cannot establish that proof.
- Every candidate is NEEDS_REVIEW while quality is uncalibrated. Missing marks
  remain null. Warning acknowledgments never override structural timing errors.
- `ctc-delimiter-envelope-v3` may use a high-support word-delimiter event only
  when the independent greedy decode and forced path agree on both adjacent
  words, their frame spans and that delimiter event. It never substitutes the
  next word's onset or uniform lyric-length intervals for a missing end.
  Algorithm identity is pinned separately from weights and fences cache reuse.
  Thresholds remain experimental; a model posterior is not measured accuracy.
  If no earlier measurement resolves an end, the energy-valley search can use
  the next vowel as right-hand audio context. The valley itself must remain
  strictly before the next onset, have complete 80ms context on both sides and
  meet the unchanged depth test. Previously measured ends are preserved.
- Backend mapping `ordered-word-edits-v3` preserves a supported, in-bounds measured
  onset when its sustain end is unknown. Ends remain null, review flags remain,
  and incomplete units never count as complete coverage. The transcript and
  at-least-one-complete-unit gates are unchanged. Mapping identity is part of
  the alignment step fingerprint and result provenance to prevent old cache
  entries from bypassing a mapping change. This does not improve model accuracy.
  Transcript agreement uses exact ordered word edit distance instead of greedy
  matching blocks: substitutions inside repeated choruses must not hide earlier
  correct words. The existing experimental 0.35 rejection / 0.8 review thresholds
  remain uncalibrated; switching the metric does not establish a quality gate.

See [current implementation status](../../docs/karaoke-auto-import/STATUS.md)
and [source/measurement record](../../docs/karaoke-auto-import/SOURCES-AND-PREFLIGHT.md).

The [2026-11-19 clock investigation](../../docs/karaoke-auto-import/CLOCK-FIX-20261119.md)
records the actual full-song failure, fix, regression tests and unchanged quality
gate. Successful MP3 clock validation is not human listening or lyric accuracy.
