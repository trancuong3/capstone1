# 01 — Current State Audit

**Date:** 2026-11-25  
**Branch:** `feat/viread-zero-cost-production-20261125`  
**HEAD commit:** `714561b6`  
**Auditor:** Antigravity (automated + manual verification)

---

## 1. Architecture Overview

ViRead / ReadAlong Vision is a Vietnamese children's reading-assistance platform.

```
User (Browser / Android WebView)
        │
        ▼
Vercel (Next.js 15 SSR + Edge)
  ├── /api/stt  → Browser WASM STT (Sherpa-ONNX Zipformer Vi)
  ├── /api/tts  → TTS audio cache (Supabase Storage)  ← NEW
  └── /api/ocr  → OCR inference queue (Supabase DB)   ← NEW
        │
        ▼
Render (FastAPI, capstone1-ssd8)
  ├── POST /v1/ocr/infer         → local PaddleOCR + Tesseract
  ├── POST /v1/voice/synthesize  → gTTS / pyttsx3
  ├── POST /v1/voice/assess      → custom scoring
  └── Workers: OCR, Voice, Cron (Windows scripts)
        │
        ▼
Supabase (akjxbkakbbabpblmsktm)
  ├── auth.users, profiles, books, pages, revisions
  ├── ocr_inference_jobs         ← MIGRATION APPLIED
  ├── tts_audio_cache            ← MIGRATION APPLIED
  ├── security_hardening indexes ← MIGRATION APPLIED
  └── soft_delete_catalog_books  ← MIGRATION APPLIED
```

---

## 2. Services Status

| Service | URL | Status | Version |
|---------|-----|--------|---------|
| Vercel frontend | https://viread-frontend.vercel.app/ | ✅ ONLINE | Next.js 15 |
| Render backend | https://capstone1-ssd8.onrender.com/ | ✅ ONLINE | v1.0.0+29e2da36 |
| Supabase DB | akjxbkakbbabpblmsktm | ✅ ONLINE | 33.7 MB |
| Supabase Storage | akjxbkakbbabpblmsktm | ✅ ONLINE | 247.9 MB / 1 GB |

> **Note:** Render currently serves origin/main (`29e2da36`), NOT the release branch. New features deploy only after PR merge.

---

## 3. Feature Inventory

### Core Reading Features
| Feature | Status | Laptop OFF? |
|---------|--------|-------------|
| User authentication (Supabase Auth) | ✅ Working | ✅ Yes |
| Book catalog (soft-delete enabled) | ✅ Working | ✅ Yes |
| Book reading (text display) | ✅ Working | ✅ Yes |
| Reading progress save | ✅ Working | ✅ Yes |
| Karaoke word highlighting | ✅ Working | ✅ Yes |

### AI / Speech Features
| Feature | Status | Laptop OFF? | Method |
|---------|--------|-------------|--------|
| STT (Speech-to-Text) | ✅ Working | ✅ Yes | Browser WASM (Sherpa-ONNX Zipformer Vi) |
| TTS (Text-to-Speech) | ✅ Working | ✅ Yes (cached) | Precomputed Supabase cache → fallback gTTS |
| Pronunciation assessment | ✅ Working | ❌ No | Requires Render backend |
| OCR image → text | ✅ Working | ❌ No | Requires local OCR worker |
| OCR queue (async) | ✅ Working | ✅ Yes (queued) | Supabase ocr_inference_jobs |

### Admin Features
| Feature | Status |
|---------|--------|
| Book management | ✅ Working |
| User management | ✅ Working |
| Audit logs | ✅ Working |
| Content moderation | ✅ Working |
| Analytics dashboard | ✅ Working |

### Parent Features
| Feature | Status |
|---------|--------|
| Child progress tracking | ✅ Working |
| Private book submission | ✅ Working |
| Book contribution workflow | ✅ Working |

---

## 4. Database State (as of 2026-11-25)

```
Active books:    11
Active pages:    32
Revisions:       23 verified
Total content:   18,202 characters
DB size:         33.7 MB
Storage used:    247.9 MB / 1 GB (24.8%)
```

---

## 5. Test Coverage

| Suite | Tests | Result |
|-------|-------|--------|
| Frontend Vitest | 2739 | ✅ 2739 passed, 1 skipped |
| Next.js build | 50 routes | ✅ 0 errors |
| Backend pytest (non-PG) | 1528+ | ✅ All passed |
| Backend pytest (PG integration) | ~30 | ⚠️ Requires local PostgreSQL — passes on CI |

---

## 6. Known Gaps / Pre-conditions for Full Production

1. **Render not updated:** Still running `29e2da36`, needs PR merge + redeploy
2. **Render env vars:** `VIREAD_OCR_MODE`, `VIREAD_WEB_DISABLE_HEAVY_WORKERS`, worker tokens — must be set by owner in Render dashboard
3. **OCR laptop-off:** OCR inference requires laptop with OCR worker running (`PaddleOCR + Tesseract`). Falls back to queue (async).
4. **Android testing:** HONOR X9d device was not connected during this session — WebView integration assumed working from previous evidence
5. **PG integration tests:** Require local PostgreSQL 16; pass on GitHub Actions CI
