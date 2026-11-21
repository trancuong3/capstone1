# Karaoke scoring v2

## Scope and baseline

Branch: `feat/karaoke-scoring-v2`, based on `8ca22412` from
`fix/revert-soft-voice-recognition`. Working tree was clean when the branch was
created. Scope is Vietnamese lyric correctness, not pitch or pronunciation
diagnosis. No production deployment, database migration, paid service creation,
or physical microphone recording is part of verification.

Baseline reproduction: `tests/karaoke/scoring-v2.test.ts` initially had 3 failed
and 2 passed tests. Failures proved that playback alone produced omissions,
interim repeated words disagreed with final alignment, and interim text could
credit future syllables. The initial multi-file test run also hit Vitest's
sandbox temporary-directory ENOENT; subsequent runs use a workspace-local TEMP
and TMP. This environmental failure is not counted as a product failure.

## Delivery phases

| Phase | Required evidence | Status |
| --- | --- | --- |
| 0: branch | Git branch and clean baseline | Done |
| 1: baseline | Red regressions; [16-case replay](V2-REPLAY.json); actual playback ticks in native probe | Done |
| 2: contract | Separate phases and labels; unknown excluded from scores; quiet evidence tests | Done |
| 3: capture | Direct-track monitor; drain/error/timeout tests; existing pause/seek/rate tests | Done |
| 4: alignment | Shared alignment; ordered capture revisions; fragmented repeats; digits; late results | Done |
| 5: recognition | [Audio comparison](V2-AUDIO-BENCHMARK.json); offline candidate rejected | Done within measured scope |
| 6: child UI | Neutral interim, confirmed counts, unassessed coverage, practice suggestions; desktop/mobile screenshots checked | Done |
| 7: verification | Fresh lint, types, unit, browser and audio results | Done within verification boundaries below |

## Evidence contract

- A lyric token is identified by occurrence, never just its spelling.
- `matched`, `different`, `omitted` are assessed states. `unknown` is excluded
  from accuracy and included in unassessed coverage.
- The separate word phase is `upcoming`, `listening`, `processing`, or `settled`.
  `settled + unknown` means the attempt could not assess the word.
- Interim decisions use the same alignment as final decisions, never enter the
  official score, and may be replaced or removed.
- Missing text is not evidence of silence. Omission requires either reliable
  bounding words in the same line, or almost complete healthy quiet coverage
  over the true timed unit AND successful recognition drain.
- Any ambiguous/voiced audio prevents a silence verdict for that unit. Digital
  zero before established audible input, clipped input, uncalibrated low volume
  and unavailable monitoring are uncertain. Noise-suppressed zero after voice
  on the same healthy, enabled, unmuted track can establish quiet.
- Line-only lyrics use the entire real line interval for acoustic evidence;
  evenly divided display times are not word timing evidence.
- Quiet detection is an energy heuristic, not identification of the child.
  The existing muted-speaker/headphone path remains necessary.
- Final wait and capture failures leave unresolved words unassessed.

## What changed

- `frontend/lib/karaoke/live-singing-score.ts`: a single alignment calculation
  serves preview and final. A capture can revise its accumulated fragments;
  closed/older captures cannot rewrite a new capture. Playback only tracks
  exposure. Healthy quiet coverage requires successful drain before omission.
- `frontend/lib/karaoke/recognition-capture.ts`: bounded native-clock intervals,
  capture identities and monotonic revisions; rejected fragments break the
  group rather than becoming artificial omissions between accepted fragments.
- `frontend/lib/karaoke/recognition-provider.ts`: the browser implementation is
  separated from scoring behind a provider contract. No new hosted dependency.
- `frontend/lib/karaoke/microphone-signal.ts`: observes the same authorized
  audio track, classifies conservative energy evidence, releases its own audio
  context, and never requests another microphone or records/uploads samples.
- `frontend/lib/karaoke/singing-text.ts`: preserves tones and normalizes only
  standalone digits 0–10; merged digits, decimals and signed numbers are never
  split to fit the song. Rendering shares its token boundaries.
- Karaoke UI: interim text is neutral and absent from official counts; unknown
  coverage is explicit; confirmed errors take priority in practice suggestions;
  the progress-copy text no longer draws over recognition colors.

## Measured outcomes

### Follow-up: omissions remained at zero

The reported result showed 61/126 assessed words and zero omissions. The image
does not identify which of the remaining 65 words were actually skipped, but
three reproducible defects prevented valid quiet evidence from being counted:

1. Every transcript event marked the entire capture from its start as speech,
   including earlier quiet lines and old final slots repeated in native events.
2. Splitting transcript groups restarted acoustic evidence even though the
   physical microphone capture had not restarted.
3. Quiet coverage required 300 ms beyond a lyric's end, while scheduled capture
   could stop at that exact end. Fully monitored silent lines stayed unknown.

The fix confines speech contradictions to native speech intervals for new
results, preserves acoustic evidence when only transcript grouping changes,
and measures quiet coverage over the actual lyric interval. Real microphone
restarts still reset evidence. Final drain must still succeed; missing audio,
network errors, disabled/muted tracks and uncertain/voiced samples do not become skips.
Line-only lyrics still require coverage of the complete real line.

Regression tests reproduced four engine/capture failures and one hook failure
before the fix. Browser coverage adds a real Web Audio track at a calibrated
quiet level, natural playback, scheduled capture drain and assertions for both
the live omission count and the final result card. This synthetic signal checks
the complete omission path; it does not establish real child-voice accuracy.

Follow-up verification: 8 karaoke test files / 108 tests passed, TypeScript,
scoped ESLint and formatting checks exited 0. The new browser scenario verifies
that skipping a monitored three-word line produces `Bỏ qua: 3` while singing
and `Bỏ qua 3` in the final card. The previous confirmed-speech, practice and
unassessed-input scenario remains included in the browser gate.
Both scenarios passed on desktop and mobile: **4/4 browser tests**, exit 0.
The final result screenshot was inspected and shows the expected omission
count of 3. The test server shuts down at the end; the user's project services
remain stopped as requested before this fix.

### Follow-up: stopping after singing still produced zero skips

The next report showed 24/126 assessed words with zero skips. The previous
browser fixture used a constant 0.0002 amplitude signal, which did not exercise
two reproducible failures in the input classifier: a 0.002 room-noise signal
after 0.04 singing stayed uncertain, and noise-suppressed digital zero remained
uncertain even after the same input had carried audible voice. Two new tests
failed before the fix.

Quiet classification now uses the measured prior voice level, with a bounded
relative threshold and the existing 300 ms voice holdoff. A live, enabled,
unmuted input can classify zero as quiet only after audible voice on that same
track. Initial zero, clipped/invalid samples and an uncalibrated higher noise
floor stay uncertain. Track state is checked before classification.

The classifier persists across recognition slices that reuse the same physical
stream, and is reset when the stream closes (pause, device change or new
attempt). This prevents every slice from losing proof that the input works.
The browser regression now supplies audible audio, then room noise and exact
zero across two lyric lines and a capture restart, using natural playback.
This reproduces signal-processing failure modes; no recording from the user's
microphone was available to prove the precise cause in their session.

Final verification for this follow-up: **110 tests / 8 karaoke files passed**;
TypeScript, scoped ESLint and formatting exited 0. The stopping-singing and
existing confirmed-speech scenarios passed on desktop and mobile (**4/4**,
exit 0). The stopping scenario counts **6/6 omitted words** across two lines
and a recognition slice, both live and in the final card; the final screenshot
was visually checked. Frontend/backend user servers remain stopped.

### Countdown sound

Preparation now plays one short, low-volume 520 Hz tone per visual 3–2–1 tick,
then a distinct 880 Hz start tone. Sound is unlocked in the start gesture
before asynchronous microphone permission. Cancel, failed permission and
unmount close the cue's audio context; the final tone closes it on completion.
Unsupported/blocked Web Audio preserves the existing visual countdown.
This applies to song starts, replay and line practice. No asset or speech
service is needed. User frontend/backend servers were stopped for this change.
Validation: 111 tests / 8 karaoke files passed; TypeScript, scoped ESLint and
formatting exited 0. Desktop/mobile stage and scored-singing browser scenarios
passed 4/4, including observed oscillator frequencies for all four cues.

### Original v2 benchmark results

The deterministic replay improved from **11/16 to 16/16 cases** against base
commit `8ca22412`. Its 52 expected token states comprise 20 matched, 4 different,
2 omitted and 26 unknown; all 52 agree in the new replay. This includes interim
cases and is not an estimate of real child ASR accuracy. Additional unit tests
cover fragmented finals, open-capture corrections, rejected middle fragments,
quiet/voice/uncertain samples, duplicate coverage, error/timeout drain, and
digit/renderer consistency.

Native audio was measured using Chrome 158.0.8127.36 and Edge 157.0.4341.60,
fake microphone tracks, public ELLA recordings, the existing piano fixture and
generated digital silence. The probe now includes playback observations (431–
2534 ticks in the recorded Chrome runs), so absent ASR also exercises the
production exposure path. No default/physical microphone was started.

| Input | Chrome raw transcript WER vs printed lyrics | Assessed / total | Matched | Result after music ends |
| --- | ---: | ---: | ---: | ---: |
| Colours / App 2 | 30.0% | 14 / 30 | 14 | 156 ms |
| Numbers / App 3, initial run | 60.87% | 0 / 23 | 0 | 74 ms |
| Actions / App 6 | 107.69% | 2 / 13 | 2 | 88 ms |
| Piano | No speech reference; 0 words emitted | 0 / 126 | 0 | 76 ms |
| Digital silence | No speech reference; 0 words emitted | 0 / 126 | 0 | 62 ms |

After standalone digit normalization, a second Numbers run assessed/matched
**5/23**, finishing in 76 ms. Native transcript strings differed between runs;
the deterministic digit regression separately proves the formatting fix. App 3
was held out for the initial run, then inspected; this retest is diagnostic,
not fresh held-out evidence. Edge returned empty final strings and correctly
reported insufficient evidence rather than zero points (529 ms).

These three song references use one whole-track line with no invented word
timestamps. They exercise the difficult v1 path and compare raw transcripts;
they are not comparable to the earlier Phase 5 per-syllable figures. A WER over
100% is possible when ASR inserts extra words. Numeric formatting contributes
to raw WER. Printed lyrics are not independent human annotations of the actual
performance, timing, or identity of the singer.

The locally cached PhoWhisper-small ONNX INT8 candidate was rerun on the same
five recordings, with free decoding and no reference prompt. It used 2 CPU
threads, took 4.305 s to load and 3.593–5.901 s per recording, and emitted **16
words on piano and 12 on silence**. Its tested batch mode therefore does not
qualify as a live fallback. Its lower printed-lyric WER on some songs does not
justify accepting those false positive transcripts. Model hashes, version,
per-recording timings and the selection decision are in the audio report.

The existing 2 s final-drain timeout remains: observed clean endings were
62–529 ms, while timeout/error tests prove that a failed drain does not invent
omissions. There is no evidence here to justify increasing that deadline or
loosening recognition confidence globally.

## Initial v2 verification (before the omission follow-up)

- Full frontend Vitest: **141 files, 2,201 tests passed**, exit 0. This run
  started before the last small phase/rendering changes; the fresh scoped run
  below verifies those final changes and two added regressions.
- Final karaoke Vitest: **7 files, 101 tests passed**, exit 0, followed by
  `tsc --noEmit`, exit 0.
- Final full frontend ESLint and Prettier checks: exit 0.
- Browser: the earlier full karaoke run passed 14 existing desktop/mobile
  scenarios; the two revised scoring scenarios passed after fixing the test
  fixture's unintended seek. After final UI polish, both scoring scenarios
  passed again on desktop and mobile (2/2, exit 0), including neutral interim,
  confirmed labels, practice retention, unassessed results and no horizontal
  overflow. Computed styles verify the duplicate lyric fill is hidden.
- Final desktop confirmed-score and mobile unassessed-result screenshots were
  inspected: clear text, no duplicate glyphs and no invented zero score.
- Replay: **16/16** against **11/16** at the base commit, exit 0.
- Audio preparation reproduced all five measured WAV hashes; both Python
  benchmark scripts parsed successfully. Native/offline measured results are
  recorded above and in the audio JSON report.
- `git diff --check`: exit 0. Only karaoke implementation, tests, benchmark
  scripts and reports changed; no media, weights, secrets or dependency pins
  are included. Backend runtime code was unchanged, so backend tests were not
  part of this scoped final gate.

## Reproduction

Run frontend checks from `frontend/`. In this Windows sandbox, set `TEMP` and
`TMP` to an existing workspace-local directory (the run used
`../.cache/karaoke-v2-tmp`) to avoid the sandbox temp path ENOENT.

```powershell
npx.cmd vitest run tests/karaoke test/karaoke-stage.test.tsx test/karaoke-syllables.test.tsx
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run format:check
npx.cmd vitest run --maxWorkers=2
node scripts/benchmark-karaoke-scoring.mjs 8ca22412 ../docs/karaoke-live-scoring/V2-REPLAY.json
$env:PLAYWRIGHT_ROUTE_FILTER='/dashboard,/entertainment,/karaoke,/login'
npx.cmd playwright test test/browser/karaoke.pw.ts --config=playwright.real-data.config.ts
```

Audio files and model weights stay out of Git. The reproducible preparation
script is `scripts/prepare_karaoke_scoring_benchmark.py --corpus-root <reviewed
ELLA cache> --output-dir <local output>`. Regeneration was executed and all five
WAV hashes matched the measured corpus. It generates a frozen manifest, WAVs,
printed references and valid UUID-based whole-line lyric files.

The browser command is `node scripts/benchmark-karaoke-mic.mjs chrome
--reviewed-wav <WAV> <lyrics JSON>` (or `msedge`). Only approved public or
synthetic inputs may be sent through the browser's recognition service.

The offline command is `python scripts/benchmark_karaoke_recognizer.py
--model-dir <pinned model directory> --manifest <manifest.json> --output
<report.json> [--ort-packages <local package directory>]`. It checks the model
hashes against the reviewed revision, audio hashes against the manifest, uses
local model files only and reads the reference after decoding.

Sources: [ELLA resources](https://www.ella.edu.au/app-toolkit/vietnamese/),
[ELLA licence and exclusions](https://www.ella.edu.au/terms-of-use/),
[pinned model card](https://huggingface.co/pdnhan/PhoWhisper-small-mobile/tree/9b0cc3c44a701d6107b5ad0052e5546626e41bad).
The source lyrics and attribution were visually checked using the cached PDF
renders. ELLA audio is used only for noncommercial evaluation, with no artwork
or logos added to the product.

## Verification boundaries

Synthetic transcript events prove scoring/lifecycle logic, not ASR quality.
Public recordings can evaluate audio recognition, not child speaker identity.
Child-voice performance must only be claimed for actual, permitted child samples.
If none are available, report that limitation rather than requesting the user
to supply recordings or treating generated speech as a child-voice benchmark.

The goals of ≤5% false confirmation, ≤20% missed correct words, and class-specific
false wrong/omission rates remain **unverified on child voices**. This delivery
completes implementation and available automated/audio evaluation; it does not
claim field qualification, universal browser accuracy, or pitch assessment.
No production deployment is performed. The local branch preserves the base
commit for rollback; the existing free-singing mode remains available.

## Working checkpoint

- GOAL: Complete phases 0–7 above with current-state evidence.
- ROOT: Playback omission inference and independent greedy interim matching.
- VERIFIED: Replay 16/16 vs 11/16; full frontend 141 files/2,201 tests;
  final scoped 7 files/101 tests; final lint/types/format exit 0; 14 existing
  browser scenarios plus final 2/2 scoring scenarios and inspected screenshots;
  five native Chrome inputs plus number retest, one Edge input, five offline
  model inputs. See initial v2 verification for timing/scope boundaries.
  Follow-up: omission regressions failed before the fix; 8 files/110
  karaoke tests and 4/4 desktop/mobile browser tests pass after the fix;
  TypeScript, scoped ESLint, formatting and whitespace checks exit 0.
- NEXT: No remaining implementation or local verification work in this scope.
  Child-voice field qualification remains unverified as explicitly documented.
- DO_NOT_REPEAT: Do not use clock-only omission or treat synthetic tests as ASR accuracy.
- BASE: `8ca22412`.
