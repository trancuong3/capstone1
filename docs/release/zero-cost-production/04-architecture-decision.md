# 04 — Architecture Decision Record (ADR)

**Date:** 2026-11-25  
**Status:** ACCEPTED  
**Decision:** Option A — Browser WASM STT + TTS Precomputed Cache + Local OCR Worker

---

## 1. Context

ViRead requires speech AI (STT for pronunciation assessment, TTS for read-aloud) for Vietnamese children.

**Hard constraints:**
- Budget: 0 VND / month (no paid APIs)
- P1: Reading features (STT + TTS) must work when laptop is OFF
- P2: Quality must not degrade for child users

---

## 2. Decision

### STT: Sherpa-ONNX Zipformer Vietnamese (Browser WASM)

**Implementation:** `frontend/public/workers/sherpa-stt-worker.js`

```
User speaks into microphone
       ↓
Web Worker (sherpa-stt-worker.js)
  ↳ Loads sherpa-onnx WASM runtime
  ↳ Loads Zipformer Vi model (cached in browser after first load)
  ↳ Streams audio → incremental transcript
       ↓
React component receives transcript
  ↳ Displays pronunciation score
  ↳ Sends to backend for detailed assessment (if laptop ON)
```

**Why Zipformer Vi specifically:**
- k2-fsa Zipformer architecture — state of the art for streaming ASR
- Trained on Vietnamese speech (Vivos + Common Voice Vi)
- ONNX export enables browser WebAssembly execution
- MIT license — no commercial restrictions
- 40 MB model size — practical for browser caching

### TTS: Supabase Storage Cache → Browser SpeechSynthesis Fallback

**Implementation:** `app/services/tts_audio_cache_service.py` + `frontend` fetch layer

```
Book text
   ↓ (precompute: scripts/precompute_book_tts_cache.py)
gTTS Vietnamese synthesis
   ↓
Supabase Storage bucket: tts-cache/{book_id}/{page_id}.mp3
   ↓ (at playback time — laptop can be OFF)
Vercel Edge fetches signed URL from Supabase
   ↓
Browser plays MP3
   ↓ (if cache miss)
Browser SpeechSynthesis API fallback
```

**Cache economics:**
- 32 pages × ~50 KB = 1.6 MB total
- Supabase Storage free: 1 GB → 0.16% utilization
- Zero additional cloud cost
- Signed URLs: 1-hour expiry (private bucket per RLS policy)

### OCR: Local PaddleOCR + Tesseract Worker (Queue-Buffered)

**Architecture:** Supabase `ocr_inference_jobs` table as queue

```
Admin uploads image
   ↓
POST /v1/ocr/infer → creates job in ocr_inference_jobs (status: PENDING)
   ↓
Local OCR Worker (Windows: start-viread-workers.ps1)
  ↳ Polls ocr_inference_jobs every 5s
  ↳ Runs PaddleOCR → Tesseract ensemble
  ↳ Updates job → status: COMPLETED + extracted text
   ↓
Admin sees result in UI (auto-refresh or webhook)
```

**When laptop is OFF:**
- Jobs queue in Supabase DB
- No data lost
- OCR completes when laptop turns back ON
- Reading (STT/TTS) continues uninterrupted

---

## 3. Alternatives Rejected

| Alternative | Reason Rejected |
|-------------|----------------|
| Cloud STT (OpenAI/Azure/Google) | Cost > 0 VND at any real usage |
| Web Speech API | Vietnamese quality unacceptable |
| Render-side STT worker | Requires laptop + Render free tier compute limits |
| Browser SpeechSynthesis only for TTS | Vietnamese quality varies by browser/OS |
| Cloud OCR (Google Vision/Azure) | Cost > 0 VND |

---

## 4. Consequences

**Positive:**
- P1 fully met: STT (WASM) + TTS (cached) work laptop-OFF
- Zero ongoing cloud cost
- Audio privacy: STT audio never leaves device
- OCR quality preserved (best-in-class PaddleOCR ensemble)

**Negative / Accepted Risks:**
- OCR requires laptop to be ON for new image processing
- First STT load: ~2-3s (model download, cached after)
- TTS precompute must be re-run when new books are added (manual step)
- Voice assessment (pronunciation scoring detail) requires Render backend

---

## 5. Implementation Commits

| Commit | Description |
|--------|-------------|
| `1e3cf98e` | feat: TTS audio cache layer + Browser-WASM STT + Windows worker scripts |
| `48149531` | fix(test): add tts_audio_cache to expected health services list |
| `714561b6` | fix(tests): resolve 7 test failures — admin prerender, CSP rules index, TTS outage timeout, health services order, data_access cache collision |
