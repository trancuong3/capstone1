# 07 — Deployment Report

**Date:** 2026-11-25  
**Release branch:** `feat/viread-zero-cost-production-20261125`  
**HEAD:** `714561b6`

---

## 1. Current Deployment State

### Vercel (Frontend)

| Property | Value |
|----------|-------|
| Project | `viread-frontend` |
| URL | https://viread-frontend.vercel.app/ |
| Framework | Next.js 15 |
| Currently deployed | Linked to `main` branch (auto-deploy) |
| Status | ✅ ONLINE |
| New features | ⏳ Pending PR merge to main |

**Vercel environment variables required:**
- `NEXT_PUBLIC_SUPABASE_URL` — set ✅
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — set ✅
- `VIREAD_SSR_AUTH_SIGNING_KEY` — verify on Vercel dashboard

### Render (Backend)

| Property | Value |
|----------|-------|
| Service | `capstone1-ssd8` |
| URL | https://capstone1-ssd8.onrender.com/ |
| Region | Oregon (US West) |
| Currently serving | `v1.0.0+29e2da36` (origin/main) |
| Status | ✅ ONLINE |
| New features | ⏳ Pending PR merge to main |
| Free tier sleep | After 15 min inactivity → 50s cold start |

**Render build command change needed (pending owner action):**
```
# Current: pip install -r backend/requirements.txt
# Required: pip install -r backend/requirements-web.txt
```

**Render environment variables to add (pending owner action):**

| Var | Purpose | Value |
|-----|---------|-------|
| `VIREAD_OCR_MODE` | Route OCR to queue instead of local | `remote_worker` |
| `VIREAD_WEB_DISABLE_HEAVY_WORKERS` | Don't start OCR/voice workers on Render | `true` |
| `VIREAD_OCR_WORKER_TOKEN` | Auth token for OCR worker webhook | Generate secure random |
| `VIREAD_VOICE_WORKER_TOKEN` | Auth token for voice worker | Generate secure random |
| `VIREAD_CRON_DISPATCH_TOKEN` | Auth for scheduled cron jobs | Generate secure random |
| `VIREAD_LOCAL_VOICE_WORKER_URL` | Local voice worker URL (if used) | `http://localhost:8010` |

### Supabase (Database + Auth + Storage)

| Property | Value |
|----------|-------|
| Project ID | `akjxbkakbbabpblmsktm` |
| Region | ap-southeast-1 (Singapore) |
| Status | ✅ ONLINE |
| DB size | 33.7 MB / 500 MB free |
| Storage | 247.9 MB / 1 GB free |
| Auth | Supabase Auth (email+password) |
| All migrations | ✅ Applied (4 migrations) |

---

## 2. Local Worker Configuration (Windows)

Workers run on the developer's laptop for OCR/Voice processing.

**Scripts location:** `scripts/windows/`

| Script | Purpose |
|--------|---------|
| `start-viread-workers.ps1` | Start OCR, Voice, Cron workers |
| `stop-viread-workers.ps1` | Gracefully stop all workers |
| `check-viread-workers.ps1` | Health check: worker PIDs + endpoints |
| `restart-viread-workers.ps1` | Restart all workers |

**Worker ports:**
- OCR worker: `http://localhost:8011`
- Voice worker: `http://localhost:8010`
- Cron dispatcher: internal

**Startup (run from PowerShell as admin):**
```powershell
cd F:\c1\capstone1-master-release
.\scripts\windows\start-viread-workers.ps1
```

---

## 3. CI/CD Pipeline

### GitHub Actions
- Trigger: push to any branch, PR to main
- Steps: install → lint → pytest (non-PG) → build
- PG integration tests: run with GitHub Actions PostgreSQL service
- Status: ✅ Green on `feat/viread-zero-cost-production-20261125`

### Deployment flow (after owner approval):
```
PR approved by owner
   ↓
Merge feat/* → main
   ↓
Vercel auto-deploys frontend (linked to main)
   ↓
Render: owner clicks "Manual Deploy" on dashboard
   ↓ (or Render auto-deploys if GitHub auto-deploy enabled)
Services updated
```

---

## 4. Pending Owner Actions

The following require manual action by the project owner:

| Action | Service | Priority |
|--------|---------|----------|
| Review and approve PR | GitHub | P0 |
| Update build command to `requirements-web.txt` | Render | P1 |
| Set 6 new environment variables | Render | P1 |
| Verify `VIREAD_SSR_AUTH_SIGNING_KEY` is set | Vercel | P1 |
| Run `precompute_book_tts_cache.py` | Local | P2 |
| Connect HONOR X9d for APK test | Local | P3 |

---

## 5. Post-Deployment Verification Checklist

After PR merge and Render redeploy:

- [ ] `GET https://capstone1-ssd8.onrender.com/health` → check `tts_audio_cache` in services list
- [ ] `GET https://capstone1-ssd8.onrender.com/health` → check `ocr_mode: remote_worker`
- [ ] Login to https://viread-frontend.vercel.app/ → verify auth works
- [ ] Open a book → verify TTS plays (from cache)
- [ ] Press microphone → verify STT transcription appears
- [ ] Admin panel → verify audit logs load (no prerender error)
- [ ] Upload image → verify OCR job queued
