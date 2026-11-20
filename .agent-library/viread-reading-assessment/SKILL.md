---
name: viread-reading-assessment
description: >-
  Use this skill when working on ViRead Speech-to-Text (STT), live child reading word alignment, ElevenLabs-to-Browser Speech fallback, Vietnamese text normalization, Levenshtein reading comparison, or first-pass/retry assessment metrics.
---

# ViRead Speech & Reading Assessment Workflow

ViRead evaluates Vietnamese children's oral reading both in real time (word-by-word highlight) and post-page/session (comparison & retry assessment).

## 1. Key Modules

- **Frontend (`frontend/`)**:
  - Live session controller: `components/reading/reading-screen.tsx`
  - Word display & report UI: `components/reading/book-page-viewer.tsx`, `book-page-content.tsx`, `ReadingReport.tsx`
  - Vietnamese NFC/token policy: `lib/reading/vietnamese-text.ts`
  - Live alignment & retry: `lib/reading/realtime-alignment.ts`, `retry-recognition.ts`, `retry-word-recognition.ts`
  - Audio & recognition evidence: `lib/reading/audio-quality.ts`, `recognition-evidence.ts`, `browser-transcript-collector.ts`
  - Speech hooks & API clients: `hooks/use-speech-recorder.ts`, `hooks/use-speech-player.ts`, `lib/api/speech-service.ts`, `lib/api/comparison-service.ts`
- **Backend (`backend/app/`)**:
  - Endpoints: `api/routes/voice.py`, `api/routes/reading.py`
  - Levenshtein edit alignment: `services/text_alignment.py` (`align_text`)
  - Report persistence & metrics: `services/reading_comparison_service.py`, `services/reading_assessment.py`

## 2. Core Alignment & Assessment Invariants

1. **Vietnamese Tone & Diacritic Preservation**:
   - Always normalize with `NFC` and `vi-VN` casing (`normalizeVietnameseWord` / `unicodedata.normalize("NFC", ...)`).
   - **Never** strip Vietnamese tone marks (`à, á, ả, ã, ạ...`) or collapse `đ` -> `d`; mispronouncing tones or `đ` is a real reading error (`SUBSTITUTE` / `MISPRONUNCIATION`), not noise.
2. **Live Alignment & Quota Fallback**:
   - Live reading uses `RealtimeAlignmentEngine` with `+1` lookahead to tolerate minor filler/slurred words without freezing `currentWordId`.
   - When ElevenLabs returns `STT_QUOTA_EXCEEDED` or `SPEECH_UNAVAILABLE`, `BrowserTranscriptCollector` captures immutable final Web Speech API results (`vi-VN`).
   - `resolveTranscriptForSegment` keeps final text already consumed by live alignment so live feedback, word retries, and persisted reports never diverge.
3. **Post-Reading Comparison & Assessment Metrics**:
   - `text_alignment.py` computes word-level Levenshtein operations:
     - `MATCH` (correct word)
     - `SUBSTITUTE` (misread / wrong word)
     - `DELETE` (omitted word)
     - `INSERT` (inserted extra word)
     - Plus `hesitations` (long inter-word pauses) and `repeated_words`.
   - `reading_assessment.py` (`assessment_version == 1`) computes first-pass (`initial_assessment`: `CORRECT`, `MISPRONUNCIATION`, `OMISSION`, `UNCERTAIN`) vs practice (`WORD_RETRY` events) metrics. Never mutate historical assessment snapshots in place or infer assessment counts from UI colors.

## 3. Targeted Verification

Run focused Vitest & Python tests whenever modifying speech, normalization, or alignment rules:
```powershell
Set-Location "F:\c1\capstone1\frontend"
npx.cmd vitest run components/reading/reading-screen.test.tsx

Set-Location "F:\c1\capstone1\backend"
..\.venv\Scripts\python.exe -m unittest discover -p "test_*reading*.py" -v
```
