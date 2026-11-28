# Versions and Provenance — ViRead Reading Acceptance (`2026-11-25`)

## 1. Public Vietnamese Human Speech Dataset (VIVOS)
- **Dataset:** `AILAB-VNUHCM/vivos` (VIVOS v1.00 — Vietnamese Voices of Southern Corpus for Speech Recognition)
- **Author / Maintainer:** Artificial Intelligence Laboratory (AILAB), VNUHCM - University of Science
- **Source URL:** `https://huggingface.co/datasets/AILAB-VNUHCM/vivos`
- **DOI / Original Homepage:** `https://doi.org/10.5281/zenodo.7068130`
- **HuggingFace Revision Commit:** `3cbfb2502e5e84776b4b778b020a09759f723f52`
- **License:** `CC BY-NC-SA 4.0` (Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International)
- **Archive Checksum (`data/vivos.tar.gz`):**
  - Size: `1,474,408,300` bytes
  - SHA-256: `147477f7a7702cbafc2ee3808d1c142989d0dbc8d9fce8e07d5f329d5119e4ca`
- **Local Workspace Paths:**
  - Raw archive & prompts: `F:\c1\tools\voice-runtime\datasets\vivos_raw\`
  - Extracted corpus: `F:\c1\tools\voice-runtime\datasets\vivos_extracted\vivos\`
  - Manifest builder: `F:\c1\tools\voice-runtime\datasets\build_vivos_manifest.py`
  - Manifest output: `docs/reading/evidence/reading_acceptance_20261125/human_corpus_manifest.json`

### Disjoint Speaker Splits & Word-End Timestamp Methodology
- **Strict Speaker Disjointness:**
  - `tuning` split (from official `vivos/train`): **6 speakers** (`VIVOSSPK01`..`VIVOSSPK06`), **48 clips**, **457 words**.
  - `holdout` split (from official `vivos/test`): **10 speakers** (`VIVOSDEV01`..`VIVOSDEV10`), **80 clips**, **745 words**.
  - Speaker overlap between `tuning` and `holdout`: **0**.
- **Ground-Truth Acoustic Word-End Timestamps:**
  - Computed via transducer subword emission onset (`sherpa-onnx-zipformer-vi-30M-int8-2026-02-09`, exact reference match verified) refined by short-time RMS acoustic energy envelope (`frame_ms=25`, `hop_ms=10`, `silence_gap_threshold_ms=30`).
  - Word `end` stops at the acoustic energy offset before inter-word pauses — **never** stretched to `next_word_start` across pauses (`267` pause-trimmed word ends in `tuning`, `449` in `holdout`), and early-emitted leading tokens are anchored to sustained acoustic speech onset (`0/80` holdout clips with quiet `<0.05s` false onsets).
- **Limitation Disclosure:** VIVOS contains adult Vietnamese speakers reading sentences cleanly in quiet rooms; **real child speech (`trẻ em lớp 1-2`) remains unverified on real child recordings (`chưa kiểm chứng trên trẻ thật`)** until recorded in school/home trials.

## 2. Technical Regression Suite (Preserved Unmodified)
- **Acceptance Passages:** `docs/reading/evidence/reading_acceptance_20261125/fixtures/passages.json` (`short_passage`: 18 words; `long_passage`: 401 words).
- **Existing Technical Regression Clips:** `docs/reading/evidence/reading_acceptance_20261125/fixtures/audio_corpus_manifest.json` (`3` existing human recordings `human_0..2` + `15` synthetic multi-region/edge-case clips, `187` words total) plus `F:\c1\tools\voice-runtime\models\bench_clips\` (`5` synthetic clips).

## 3. Baseline & Runtime Environment Versions
- **Git Baseline Commit:** `cad23ac79f7a94fb1224f23e730b5e990043af65` (PR #192)
- **Local STT Model:** `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09` (`F:\c1\tools\voice-runtime\models\sherpa-onnx-zipformer-vi-30M-int8-2026-02-09`)
- **Local TTS Runtime:** `vieneu==3.8.5`, `onnxruntime==1.32.0`, `sherpa_onnx==2.0.2` in `F:\c1\tools\voice-runtime\.venv` (Python `3.12.10`)
- **Isolated Local Postgres Staging:** PostgreSQL `18.6` (`127.0.0.1:5432/viread_qa_local`), seeded via `scripts/windows/Setup-ViReadLocalStaging.py`
- **Pinned Backend ABI Environment (`capstone1/.venv`):** `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13` (untouched).
