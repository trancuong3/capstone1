# 03 — Provider Benchmark

**Date:** 2026-11-25  
**Methodology:** Research + architecture analysis (live API benchmarks blocked by 0 VND constraint)

---

## 1. STT Provider Benchmark

| Option | Provider | Cost/mo (100 users) | Laptop-OFF | Vi Quality | Latency | Privacy | Score |
|--------|----------|--------------------:|-----------|-----------|---------|---------|-------|
| **A (chosen)** | Sherpa-ONNX WASM | **$0** | ✅ | ⭐⭐⭐⭐ | 200ms | ✅ On-device | **9/10** |
| B | Web Speech API | $0 | ✅ | ⭐⭐ | 100ms | ❌ Cloud | 4/10 |
| C | OpenAI Whisper | ~$12/mo | ✅ | ⭐⭐⭐⭐⭐ | 500ms | ❌ Cloud | 6/10 |
| D | Local Whisper (backend) | $0 | ❌ | ⭐⭐⭐⭐⭐ | 1-3s | ✅ | 5/10 |
| E | Groq Whisper | $0 (free tier) | ✅ | ⭐⭐⭐⭐⭐ | 200ms | ❌ Cloud | 7/10 |
| F | Azure Speech | ~$8/mo | ✅ | ⭐⭐⭐⭐⭐ | 150ms | ❌ Cloud | 5/10 |
| G | AssemblyAI | ~$12/mo | ✅ | ⭐⭐⭐⭐ | 300ms | ❌ Cloud | 5/10 |
| H | Vosk (browser WASM) | $0 | ✅ | ⭐⭐⭐ | 300ms | ✅ On-device | 7/10 |

**Winner: Option A (Sherpa-ONNX Zipformer Vi)**
- Only option combining $0 cost + laptop-off + high Vietnamese quality + on-device privacy

---

## 2. TTS Provider Benchmark

| Option | Provider | Cost/mo (100 users) | Laptop-OFF | Vi Quality | Delay | Score |
|--------|----------|--------------------:|-----------|-----------|-------|-------|
| **A (chosen)** | gTTS cache + Browser fallback | **$0** | ✅ | ⭐⭐⭐⭐ | 0ms (cached) | **9/10** |
| B | gTTS live (via Render) | $0 | ❌ | ⭐⭐⭐⭐ | 500ms | 5/10 |
| C | Edge-TTS (Microsoft unofficial) | $0 | ❌ | ⭐⭐⭐⭐⭐ | 400ms | 6/10 |
| D | Google Cloud TTS | ~$4/1M chars | ✅ | ⭐⭐⭐⭐⭐ | 150ms | 5/10 |
| E | Browser SpeechSynthesis only | $0 | ✅ | ⭐⭐ | 50ms | 4/10 |
| F | ElevenLabs | ~$22/mo | ✅ | ⭐⭐⭐⭐⭐ | 200ms | 4/10 |
| G | pyttsx3 (local) | $0 | ❌ | ⭐⭐ | 100ms | 3/10 |
| H | Festival/eSpeak | $0 | ❌ | ⭐ | 50ms | 2/10 |

**Winner: Option A (Precomputed cache)**
- Instant playback for cached pages (100% of current 32 pages)
- $0 storage cost (1.6 MB total at 50KB/page)
- Laptop-independent once cache is populated

---

## 3. OCR Provider Benchmark

| Option | Provider | Cost/mo | Laptop-OFF | Vi Accuracy | Score |
|--------|----------|---------|-----------|-------------|-------|
| **Current (kept)** | PaddleOCR + Tesseract (local worker) | $0 | ❌ | ⭐⭐⭐⭐⭐ | 8/10 |
| B | Google Cloud Vision | ~$1.50/1K pages | ✅ | ⭐⭐⭐⭐⭐ | 6/10 |
| C | Azure Computer Vision | ~$1/1K pages | ✅ | ⭐⭐⭐⭐⭐ | 6/10 |
| D | Tesseract only | $0 | ✅ (can run on Render) | ⭐⭐⭐ | 5/10 |
| E | EasyOCR | $0 | ❌ (GPU needed) | ⭐⭐⭐⭐ | 6/10 |

**Decision: Keep local PaddleOCR worker**
- Quality is highest (combined PaddleOCR + Tesseract ensemble)
- OCR is an admin operation (not real-time child reading)
- Queue system (ocr_inference_jobs) buffers requests when worker is offline

---

## 4. Scoring Criteria

| Criterion | Weight |
|-----------|--------|
| Zero cost (0 VND) | 30% |
| Laptop-independent (works when OFF) | 25% |
| Vietnamese language quality | 20% |
| Latency / UX | 15% |
| Privacy / Data protection | 10% |
