# 02 — STT/TTS Research Findings

**Date:** 2026-11-25  
**Scope:** Vietnamese STT and TTS options for zero-cost, laptop-independent operation

---

## 1. Research Objective

Find a Vietnamese STT/TTS solution that:
- Works when laptop is OFF (no local GPU/CPU worker required)
- Has 0 VND / month ongoing cost
- Meets child reading-assistance quality requirements
- Runs in a web browser or Vercel Edge (no server compute needed)

---

## 2. STT Options Evaluated

### Option A: Browser WASM (Sherpa-ONNX Zipformer Vietnamese) ← **CHOSEN**
- **Model:** `sherpa-onnx-streaming-zipformer-vi-2024-04-02`
- **Runtime:** Web Worker + WebAssembly in-browser
- **Cost:** $0 (open-source MIT model, runs in user's browser)
- **Laptop-off:** ✅ Yes — model loads from CDN or /public, runs entirely in browser
- **Quality:** High — Zipformer architecture, trained on Vietnamese speech corpus
- **Latency:** ~200ms first token (after model load ~2-3s first visit, cached after)
- **Privacy:** ✅ Audio never leaves device
- **Offline:** ✅ After first cache
- **Source:** https://github.com/k2-fsa/sherpa-onnx

### Option B: Web Speech API (browser built-in)
- **Cost:** $0
- **Laptop-off:** ✅ Yes
- **Quality:** ❌ Poor Vietnamese support in Chrome/Firefox
- **Privacy:** ❌ Audio sent to Google/Mozilla servers
- **Verdict:** Rejected — Vietnamese quality insufficient for pronunciation assessment

### Option C: OpenAI Whisper API
- **Cost:** $0.006/min — ❌ NOT zero cost
- **Laptop-off:** ✅ Yes
- **Verdict:** Rejected — cost constraint violated

### Option D: Local Whisper (backend worker)
- **Cost:** $0 compute, but requires laptop
- **Laptop-off:** ❌ No
- **Verdict:** Rejected for P1 requirement (laptop-independent)

### Option E: Groq Whisper API (free tier)
- **Free tier:** 28,800 audio-minutes/day
- **Laptop-off:** ✅ Yes
- **Quality:** ✅ Excellent Whisper-large-v3
- **Concern:** Rate limits, API key management, free tier continuity
- **Verdict:** Secondary fallback option (not primary — zero-cost guarantee uncertain)

---

## 3. TTS Options Evaluated

### Option A: Precomputed Cache + Browser SpeechSynthesis ← **CHOSEN**
- **Architecture:** Pre-generate all book text via gTTS (or voice worker), store in Supabase Storage as MP3. Frontend fetches cached audio. Falls back to browser SpeechSynthesis if not cached.
- **Cost:** $0 (Supabase Storage: 1 GB free, MP3 ~50 KB/page)
- **Laptop-off:** ✅ Yes for cached content
- **Quality:** ✅ gTTS Vietnamese quality acceptable for children
- **Storage:** ~50 KB/page × 32 pages = ~1.6 MB total (trivial)

### Option B: gTTS (live, via Render backend)
- **Cost:** $0 (Google Translate TTS, unofficial)
- **Laptop-off:** ❌ No — requires Render backend to call gTTS
- **Verdict:** Used as generation source for cache; not primary delivery path

### Option C: Edge-TTS (Microsoft)
- **Cost:** $0 (unofficial edge API)
- **Quality:** ✅ High quality Vietnamese voices
- **Laptop-off:** ❌ No — requires backend proxy
- **TOS:** ⚠️ Unofficial API, may change
- **Verdict:** Potential upgrade for cache generation

### Option D: Google Cloud TTS
- **Cost:** $4/1M chars — ❌ NOT zero cost at scale
- **Verdict:** Rejected

### Option E: Festival / espeak (local)
- **Quality:** ❌ Poor Vietnamese
- **Verdict:** Rejected

---

## 4. Architecture Decision Summary

```
STT:  Browser WASM (Sherpa-ONNX Zipformer Vi)
      ↳ Runs in user's browser — zero server cost — laptop-independent
      ↳ Audio stays on device (privacy)

TTS:  Supabase Storage Cache → Browser SpeechSynthesis fallback
      ↳ Pre-computed for all 32 book pages
      ↳ Fetched as MP3, no server round-trip at playback time
      ↳ Works when laptop is OFF (served from Supabase CDN)
      ↳ Cache generation: one-time via scripts/precompute_book_tts_cache.py
```

---

## 5. Implementation Files

| File | Purpose |
|------|---------|
| `frontend/public/workers/sherpa-stt-worker.js` | WASM STT web worker |
| `app/models/tts_audio_cache.py` | TTS cache model |
| `app/services/tts_audio_cache_service.py` | Cache lookup + storage service |
| `app/repositories/tts_audio_cache_repository.py` | Supabase repository |
| `scripts/precompute_book_tts_cache.py` | One-time precomputation script |
| `backend/app/services/voice_orchestrator.py` | Unified voice service routing |
| `supabase/migrations/20261125130000_tts_audio_cache.sql` | DB schema |
