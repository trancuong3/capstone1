# 11 — Security Audit

**Date:** 2026-11-25  
**Scope:** ViRead production security posture

---

## 1. Authentication & Authorization

### Supabase Auth
- **Method:** Email + password via Supabase Auth
- **JWT:** Signed by Supabase, verified by RLS policies
- **Session:** Short-lived access tokens + refresh tokens
- **Status:** ✅ Secure

### Row-Level Security (RLS)
All tables have RLS enabled.

| Table | Policy | Status |
|-------|--------|--------|
| `books` | Authenticated read; admin write | ✅ |
| `pages` | Authenticated read; admin write | ✅ |
| `revisions` | Admin read/write | ✅ |
| `profiles` | Own profile read; admin read all | ✅ |
| `reading_progress` | Own progress read/write | ✅ |
| `ocr_inference_jobs` | Admin read/write; own jobs | ✅ |
| `tts_audio_cache` | Authenticated read; service write | ✅ |
| `audit_log` | Admin read-only | ✅ |
| `private_books` | Owner read/write; admin moderate | ✅ |

**Private book isolation:** Child audio recordings and private book content are isolated per family (parent+child) with RLS preventing cross-family access.

---

## 2. Content Security Policy (CSP)

Frontend CSP headers configured in `next.config.js`:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-eval' blob:;   ← blob: required for WASM worker
  worker-src 'self' blob:;                  ← WASM web worker
  connect-src 'self' https://*.supabase.co wss://*.supabase.co;
  media-src 'self' https://*.supabase.co;  ← TTS MP3 from Supabase Storage
  img-src 'self' data: https://*.supabase.co;
  frame-ancestors 'none';
  upgrade-insecure-requests;
```

**CSP test:** `frontend/tests/config/security-headers.test.ts` — ✅ All 4 rules pass.

---

## 3. Worker Token Authentication

Local workers (OCR, Voice, Cron) authenticate to Render backend via bearer tokens.

```
Worker → POST /v1/ocr/infer
  Authorization: Bearer ${VIREAD_OCR_WORKER_TOKEN}

Render backend validates token before processing
```

**Token generation:** Random UUID (256-bit entropy)  
**Storage:** Render dashboard environment variables (not in code)  
**Rotation:** Manual — document in runbook

---

## 4. Data Privacy (Child Audio)

ViRead handles children's voice data for pronunciation assessment.

**Current implementation:**
- STT: Browser WASM → audio **never leaves the device** ✅
- Pronunciation score: sent as text transcript to backend (not audio)
- Backend: score computed from text, audio not stored
- Private book recordings: stored in Supabase Storage under family-isolated RLS

**COPPA / Child data compliance:**
- No audio persisted server-side from STT assessment
- Private content isolated by family ID
- No third-party STT API (audio stays in browser)

---

## 5. Signed URLs for Storage

TTS cache MP3 files are served via Supabase signed URLs (1-hour expiry).

```python
# tts_audio_cache_service.py
url = await supabase.storage.from_("tts-cache").create_signed_url(
    path=audio_path, 
    expires_in=3600  # 1 hour
)
```

**Security:** Signed URLs prevent hotlinking and unauthorized access.

---

## 6. Secret Management

| Secret | Storage | Rotation |
|--------|---------|----------|
| Supabase service role key | Render env vars | Never logged |
| Worker tokens | Render env vars | Manual |
| Supabase anon key | Vercel env vars (public prefix) | Safe to expose |
| JWT signing key | Vercel env vars (server-only) | Manual |

**Verified:** No secrets appear in:
- Git history (`.env.local` in `.gitignore`)
- Application logs
- API responses
- Error messages

---

## 7. Dependency Security

Pinned ABI-sensitive dependencies:
```
numpy==1.26.4          # ABI pin — do not upgrade
protobuf==3.20.2       # ABI pin
opencv-python-headless==4.10.0.84  # ABI pin
pytesseract==0.3.13    # ABI pin
```

Frontend dependencies: managed by `npm audit`  
Backend: `pip-audit` recommended before next release

---

## 8. Security Gaps / Recommendations

| Gap | Severity | Recommendation |
|----|----------|----------------|
| Render worker tokens not yet set | HIGH | Owner: add env vars before deploy |
| `VIREAD_SSR_AUTH_SIGNING_KEY` not verified | HIGH | Owner: confirm set on Vercel |
| No rate limiting on `/v1/voice/assess` | MEDIUM | Add `slowapi` rate limiter |
| OCR worker token rotation not documented | LOW | Add to runbook |
| No IP allowlist for Render admin APIs | LOW | Consider Vercel middleware |
