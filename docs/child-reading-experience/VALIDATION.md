# Validation evidence

The later [box geometry correction](BOX_GEOMETRY_FIX.md) has a separate isolated run in `viread-box-fix-20261111-a1`. The completion-run numbers below predate that correction and are retained as historical evidence. Consult the box-fix report and its final logs for validation of the current geometry behavior.

This report distinguishes the historical completion run from earlier handoff results and the later geometry correction. Final aggregate counts are updated only from completed runs; failures and skips remain visible. The [final acceptance report](FINAL_ACCEPTANCE.md) lists the latest source validation and user-reported manual acceptance. Publication documentation changes are not represented as a new full test run.

## Historical Phase 7–8 completion evidence, before the box correction

- Frontend Vitest: **1,706/1,706 passed in 104 files**, 409.55 seconds, on source after the final modal CSS correction (`frontend-full.log`, `full-results.json`). Categorized subsets: audio 93, Vietnamese NLP 33, reading/retry components 62, TTS 72 and image presentation 23; these are selected groups, not an exhaustive partition.
- Complete backend discovery: **748 collected, 743 passed, five skipped**, no failures/errors, 266.080 seconds (`backend-full-final.log`). The five skips require unavailable PaddleOCR/VietOCR runtimes; this is not an all-engine pass.
- Existing PostgreSQL suites: 17 tests passed, including 14 formerly gated cases and three repository checks. The final complete backend run also includes these cases and the eight new concurrency/API scenarios.
- Frontend/backend/PostgreSQL browser suite: **8/8 passed**, four scenarios on desktop and mobile: first-pass preservation, three-word retry identity/order, offline recovery after a committed event and navigation during capture (`browser-postgres-final-results.json`).
- Complete fixture browser run: **110 collected, 96 passed, 14 skipped, zero failed/flaky**, 10.5 minutes (`browser-full-final.log`, `browser-full-final-results.json`). Eight opt-in PostgreSQL cases are skipped here and passed in the separate database run above. Six viewport matrix cases skip duplicate execution in the mobile project; those six widths run in the desktop project. Two additional screenshot scenarios passed for tablet layout and active retry feedback. This is not a zero-skip claim.
- Zoom 200%: strengthened assertions reproduced the original label truncation. The corrected toolbar passed desktop and mobile with full labels and reachable controls.
- Metadata/filename security: tests reject oversized/non-finite new metadata, retain larger legacy response metadata and verify traversal filenames cannot choose storage object keys.
- Typecheck, Prettier, ESLint and production build passed. ESLint retains 12 existing warnings. Synthetic server-only canaries were absent from all 78 scanned client bundle files (`client-canary-audit.json`); no actual secrets were read.

The initial frontend/backend/browser evidence from prior sessions is not represented as a new run. Current evidence is in the sibling workspace directory `viread-phase7-8-completion-20261111-a1`; runner scripts, JSON reports and raw logs are retained there. Initial metadata security tests failed before the validator was added. Initial zoom checks reproduced truncated labels. The initial complete browser run failed two XSS expectations because the rendered transcript includes quotation marks; the expectation was corrected while retaining script-injection assertions. A later run stopped during global setup with an empty Next dev manifest; its cache was retained under `.next-warmup-failed`, and the server was restarted with a fresh test cache. These failed runs are retained, not relabeled as passes.

Visual inspection then found an oversized dialog close control. New desktop/mobile assertions reproduced widths of 556/326 pixels before the 48-pixel correction. The interrupted full browser log is retained separately, and the final browser run exercises the corrected source and assertions. The complete 1,706-test frontend suite, voice-control component tests and production build all passed after this correction. Earlier full frontend results are retained separately as `full-before-final-modal-css-results.json` and `frontend-full-before-final-modal-css.log`.

### Selected groups from completed runs

| Test group                              | Total | Passed | Failed | Skipped |
| --------------------------------------- | ----- | ------ | ------ | ------- |
| Audio Unit                              | 93    | 93     | 0      | 0       |
| NLP Unit                                | 33    | 33     | 0      | 0       |
| Retry / frontend reading component      | 62    | 62     | 0      | 0       |
| TTS Unit / component                    | 72    | 72     | 0      | 0       |
| Image Unit / component                  | 23    | 23     | 0      | 0       |
| Backend PostgreSQL integration          | 22    | 22     | 0      | 0       |
| Related repository checks               | 3     | 3      | 0      | 0       |
| PostgreSQL browser E2E                  | 8     | 8      | 0      | 0       |
| Complete fixture browser E2E            | 110   | 96     | 0      | 14      |
| Browser transcript XSS (included above) | 2     | 2      | 0      | 0       |
| UI evidence supplement                  | 2     | 2      | 0      | 0       |
| Backend metadata / filename security    | 5     | 5      | 0      | 0       |
| Reading scale regression                | 11    | 11     | 0      | 0       |

Groups overlap the complete suites and must not be summed into a total. Frontend file lists and individual assertions are in `frontend-category-results.json` / `full-results.json`. PostgreSQL files are `test_reading_comparison_postgres_integration.py`, `test_admin_ocr_postgres_integration.py`, `test_book_content_quality_persistence.py` and `test_phase7_postgres.py`; three additional repository checks in the first module use test doubles and are counted separately above. Security additions are in `test_reading_input_safety.py`; browser XSS and dialog/zoom regressions are in `reading-phase7.pw.ts`. Opt-in backend/browser workflows are in `reading-postgres.pw.ts`.

### Executed commands and boundaries

Installed package scripts were inspected. Equivalent executables were invoked through retained guarded runners to disable dotenv and real outbound services. From the frontend working directory, `node <evidence>/frontend.mjs full` runs installed Vitest with two workers and writes JSON; `node <evidence>/checks.cjs` runs installed `tsc --noEmit --incremental false`, `eslint .` and `prettier --check .` with the recorded ignore file. The final modal component rerun uses `frontend.mjs modal-final tests/reading/reading-voice-settings.test.tsx tests/reading/reading-controls-voice.test.tsx`.

The backend command is the installed virtualenv Python with `<evidence>/backend-postgres.py --discover`. The build command is `node <evidence>/build.cjs`, invoking installed Next build in the sanitized source copy. The fixture-only browser command is `node <evidence>/browser-full.cjs --fully-parallel --workers=2`, invoking installed Playwright with `playwright.full-managed.config.ts`. The PostgreSQL E2E command uses that runner with `--grep PostgreSQL --workers=1` and its opt-in flag plus the dedicated test backend. The `<evidence>` placeholder denotes the local evidence directory above, not a package script or missing repository dependency. Raw runner files retain the precise configuration and safety guards.

## Local load measurements

| Concurrent sessions | Requests | Errors | p50 (ms) | p95 (ms) |
| ------------------- | -------- | ------ | -------- | -------- |
| 1                   | 3        | 0      | 687.7    | 899.4    |
| 5                   | 15       | 0      | 3,186.9  | 4,047.5  |
| 10                  | 30       | 0      | 6,351.4  | 8,505.5  |
| 20                  | 60       | 0      | 18,505.8 | 25,537.7 |

Source: `postgres-api-load.json` from the final backend run. These are three small batches per level on a shared Windows host, Docker PostgreSQL 17 restricted to two CPUs/1 GiB and SQLAlchemy NullPool. Requests use actual reading routes and database transactions, synthetic auth and in-process ASGI; they exclude HTTP network and provider latency. p95 is the nearest-rank observed sample. An additional replay per level measured Python heap separately (about 177–178 KiB retained, 286–288 KiB peak); these are neither total process RSS nor leak/stability measurements. Earlier timings with tracemalloc inside the timed loop are retained as superseded evidence.

The 20-session p95 is a material performance risk. There is no production capacity or latency acceptance claim. Repeat a representative longer benchmark on a quiet, production-like test environment before selecting a capacity target; do not infer provider throughput from this local run.

## Test levels

| Level                                | Actual boundary                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Frontend units/components            | Real helpers/hooks/components with test service/browser boundaries                                                |
| Backend discovery                    | All `test*.py` via unittest; dotenv and outbound connections guarded                                              |
| PostgreSQL integration               | Real PostgreSQL 17 in a new Docker container, random test schemas, real SQLAlchemy repositories/services          |
| API load                             | Actual FastAPI reading routes and PostgreSQL; synthetic actor identity; ASGI in-process; no paid provider latency |
| Browser workflow suite               | Real frontend/native media with intercepted APIs and synthesized audio                                            |
| PostgreSQL E2E browser suite         | Real frontend, HTTP reading/STT routes, PostgreSQL; synthetic auth and STT/TTS/storage boundaries                 |
| Physical microphone / live providers | Not inferred from synthetic media or mocks                                                                        |

No application database, historical data, migrations or real provider credentials were used in these automated checks. The PostgreSQL container has no host data mount and is exposed only on loopback. Guarded runners accept only the explicitly configured test services.

## Reproduction prerequisites

Use the installed dependencies and actual scripts in `frontend/package.json` for format, lint, typecheck, Vitest, build and Playwright. Do not install dependencies or point database tests at an application database merely to remove a skip.

The existing PostgreSQL suites use `READING_REPORT_TEST_DATABASE_URL`, `ADMIN_OCR_TEST_DATABASE_URL` and `BOOK_CONTENT_QUALITY_TEST_DATABASE_URL`. The additional concurrency suite uses `VIREAD_PHASE7_TEST_DATABASE_URL` and deliberately accepts only user `phase7`, database `viread_phase7_test`, host `127.0.0.1`, port `55439`. It creates/removes its own `phase7_<uuid>` schema.

The browser PostgreSQL file is opt-in with `VIREAD_PHASE7_POSTGRES_E2E=1`, requires the dedicated test backend and runs with one worker so each scenario owns its fixture reset. It is exercised separately from the parallel fixture-only browser suite. Provider/auth test adapters are never installed into the production app.

## UI evidence and manual acceptance

Browser screenshots document all 14 master-prompt UI evidence items: source image/overlay, text fallback, current/correct/incorrect/self-corrected/unresolved states, voice/speed settings, retry feedback, TTS playback, admin images and mobile/tablet layouts. `UI_EVIDENCE.md` and `ui-evidence-index.json` in the local evidence directory map each requirement to its actual screenshot, dimensions and SHA-256 hash; some screenshots show multiple states. Additional screenshots cover zoom. They are generated from implemented application code with identified test boundaries, not design mockups.

Keyboard focus/trapping/restoration, semantic names, non-color word states, reduced motion, magnification/reflow and resource release have automated checks. Screen-reader behavior, OS/browser zoom, physical microphone disconnection/background behavior, real scans and a complete contrast/device audit remain manual acceptance items. The user reported four workflow scenarios passed; this is not converted into universal hardware/provider acceptance.

### Remaining acceptance checklist

- [ ] Approved adult/licensed audio, matching references and before/after STT measurements. The user explicitly accepted recording this as unmeasured; see the audio report.
- [ ] Physical microphone/VAD: quiet, noisy, soft/fast speech, permission denial, device disconnect and background/resume on supported browsers/devices. Synthetic capture tests do not calibrate VAD.
- [ ] Real voice IDs/quality, timing, speed and quota/timeout/fallback behavior using an approved provider environment.
- [ ] Live storage policies, signed URL expiry, cross-user denial and retention of images referenced by old revisions.
- [ ] Screen reader, OS/browser zoom, full contrast/device review and approved dense/portrait/landscape scans.
- [ ] Representative longer performance/resource soak with an agreed latency target. The small local PostgreSQL load run is recorded above and exposes a latency risk.
- [ ] Upstream integration/base decision remains separate from feature-branch publication. The user now authorizes commit/push without merge; there is no `develop` remote ref, and compatibility with the newer `main` has not been tested. Do not infer upstream compatibility from a clean build on the older base.

The previous PostgreSQL concurrency gap is now covered by real disposable database tests, and eight browser scenarios exercise real HTTP/backend/database persistence. This resolves that local evidence gap; it does not establish production schema parity, provider/storage behavior or long-running reliability.

See [the real-audio report](REAL_AUDIO_REPORT.md) for the unavailable WER/CER baseline. Live bucket policies, signed-URL expiry, real provider quota/fallback/voice quality and the OCR-engine runtime gate remain explicitly limited by the available environment.
