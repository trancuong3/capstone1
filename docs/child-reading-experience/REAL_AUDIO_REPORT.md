# Real audio experiment

Date: 2026-11-11. The user confirmed that no approved audio dataset, reference transcripts or before-change baseline are available and requested that speech accuracy remain explicitly unmeasured.

| Required evidence                                                 | Current status                                  |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| Approved adult/licensed Vietnamese audio                          | Not supplied; zero dataset recordings evaluated |
| Reference transcription and annotation status                     | Not supplied                                    |
| Device, room/noise and reading-speed categories                   | Not measured systematically                     |
| Provider and model comparison on identical audio                  | Not performed                                   |
| Baseline/new WER and CER                                          | Not measured                                    |
| False positive/negative and insertion/deletion/substitution rates | Not measured                                    |
| Retry and self-correction classification accuracy                 | Not measured on real audio                      |
| Uncertain rate and VAD calibration                                | Not measured on real audio                      |

The browser suite uses deterministic synthesized streams, native MediaRecorder and test transcript responses. The PostgreSQL-backed E2E suite sends those recordings through the real backend STT route with a test provider adapter. This verifies capture, request/response handling, persistence and assessment invariants. Its fixture transcripts are not ASR predictions on the oscillator signal and cannot establish speech accuracy.

The user reported that four manually tested workflows passed: preserving the first error across a revisit, retaining valid evidence around an uncertain segment, preserving correct repeated words and counting added words in the report. This is user-reported workflow acceptance; it does not supply a labeled dataset or a quantitative before/after experiment.

When an approved dataset is available, record audio ID, reference text, language, permission/provenance, device, environment/noise, reading speed and annotation status. Evaluate the same references before/after; keep uncertainty separate from child errors and publish the actual metrics above. Use adult/licensed recordings. No recordings of children were collected for this work, and no empirical improvement in Vietnamese child speech recognition is claimed.
