# 12 — Bug Fix Report

**Date:** 2026-11-25  
**Session:** Zero-cost production release (Antigravity agent session)

---

## 1. Bugs Fixed This Session (commits `1e3cf98e` → `714561b6`)

### Fix 1 — Admin Prerender Failure (Build Error)

| Field | Value |
|-------|-------|
| **File** | `frontend/app/admin/(protected)/layout.tsx` |
| **Error** | `Missing required env NEXT_PUBLIC_SUPABASE_URL` during Next.js static prerender |
| **Root cause** | Admin layout was prerendered statically; Supabase client needs env at runtime |
| **Fix** | Added `export const dynamic = "force-dynamic"` to force dynamic rendering |
| **Commit** | `714561b6` |
| **Test** | Next.js build: 50 routes, 0 errors ✅ |

### Fix 2 — CSP Test Directive Index Mismatch

| Field | Value |
|-------|-------|
| **File** | `frontend/tests/config/security-headers.test.ts` line 76 |
| **Error** | `media-src` CSP directive undefined — `rules[0]` was wrong index |
| **Root cause** | CSP rules array index changed when `media-src` added for TTS audio |
| **Fix** | Changed `rules[0]` → `rules[1]` to find correct directive |
| **Commit** | `714561b6` |
| **Test** | 4 CSP tests pass ✅ |

### Fix 3 — TTS Outage Test Timeout (15 seconds)

| Field | Value |
|-------|-------|
| **File** | `frontend/tests/reading/tts-playback-lifecycle.test.tsx` |
| **Error** | Test "does not speak with non-Vietnamese browser voice during outage" timed out |
| **Root cause** | Mock for Render voice worker wasn't set to reject; test waited 15s for timeout |
| **Fix** | Added `speech.synthesize.mockRejectedValueOnce(new Error("local worker unavailable"))` before `play()` |
| **Commit** | `714561b6` |
| **Test** | TTS lifecycle tests all pass ✅ |

### Fix 4 — Health Services List Order Mismatch

| Field | Value |
|-------|-------|
| **File** | `backend/test_backend_perf_optimizations.py` |
| **Error** | `['api', 'database', 'local_ocr', 'tts', 'stt', 'tts_audio_cache'] != ['api', 'database', 'local_ocr', 'tts', 'stt', 'storage']` |
| **Root cause** | New `tts_audio_cache` service added to health check; test expected old list |
| **Fix** | Updated expected services list to include `tts_audio_cache` before `storage` |
| **Commit** | `714561b6` |
| **Test** | Backend perf optimizations test passes ✅ |

### Fix 5 — Data Access Cache Collision (Subtests)

| Field | Value |
|-------|-------|
| **File** | `backend/test_data_access.py` |
| **Error** | `HTTPException not raised` for 2 subtests — shared invalid token was cached from first passing subtest |
| **Root cause** | All subtests used the same literal `"invalid-token-xxx"` string; auth cache (LRU) returned valid result for subsequent subtests |
| **Fix** | Use `f"invalid-token-{id(user)}"` — unique token per subtest instance, bypasses cache |
| **Commit** | `714561b6` |
| **Test** | 4 passed, 2 subtests ✅ |

### Fix 6 — Health Test Missing tts_audio_cache

| Field | Value |
|-------|-------|
| **File** | `backend/test_admin_data.py` line 285 |
| **Error** | `test_health_reports_only_services_actually_checked` FAILED |
| **Fix** | Added `'tts_audio_cache'` to expected services list at line 285 |
| **Commit** | `48149531` |
| **Test** | Admin data health test passes ✅ |

### Fix 7 — Audio Validation Library Missing (Karaoke Tests)

| Field | Value |
|-------|-------|
| **Files** | `test_karaoke.py`, `test_karaoke_*.py` |
| **Error** | `503 Service Unavailable` — audio validation unavailable |
| **Root cause** | `mutagen` and `tinytag` not installed in local venv |
| **Fix** | `pip install mutagen tinytag` |
| **Commit** | N/A (environment fix) |
| **Test** | Karaoke tests all pass ✅ |

---

## 2. Bugs Fixed in Previous Sessions

| Bug | Fix | Session |
|-----|-----|---------|
| Render keepalive cron violating ToS | Removed cron job from `render-keepalive.yml` | Earlier |
| OCR inference job schema missing | Added migration `20261124010000_ocr_inference_jobs.sql` | Earlier |
| Soft delete not implemented | Migration + API layer update | Earlier |
| Missing FK indexes causing slow queries | `security_hardening_and_hot_fk_indexes` migration | Earlier |
| TTS cache table not existing | Migration `20261125130000_tts_audio_cache.sql` | 2026-11-25 |

---

## 3. Known Remaining Issues

| Issue | Severity | Notes |
|-------|----------|-------|
| Render workers not configured (env vars) | HIGH | Requires owner action |
| TTS cache empty (precompute not run) | MEDIUM | Run `precompute_book_tts_cache.py` |
| Android not tested | MEDIUM | HONOR X9d not connected |
| PG integration tests need local PG | LOW | Pass on CI; not blocking |
| Render cold start 50s | LOW | Free tier limitation; accepted |
