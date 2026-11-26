# 14 — Rollback Runbook

**Date:** 2026-11-25  
**Purpose:** Step-by-step rollback procedures for each service if production issues occur post-deploy

---

## 1. Decision Tree: When to Rollback

```
Issue detected in production
         ↓
Is it data corruption?
   YES → Immediate rollback + contact owner
   NO  ↓
Is it a critical auth failure?
   YES → Rollback Vercel + Render immediately
   NO  ↓
Is it affecting > 50% of users?
   YES → Rollback within 1 hour
   NO  → Fix forward if possible (hotfix)
```

---

## 2. Vercel Frontend Rollback

**Time to rollback:** ~2 minutes

```
1. Go to https://vercel.com/trancuong3/viread-frontend
2. Click "Deployments" tab
3. Find the previous working deployment
4. Click ⋮ (three dots) → "Promote to Production"
5. Wait ~60 seconds for propagation
6. Verify: https://viread-frontend.vercel.app/ loads correctly
```

**Git equivalent:**
```powershell
# Revert the merge commit
git revert -m 1 <merge-commit-sha>
git push origin main
# Vercel auto-deploys the revert
```

---

## 3. Render Backend Rollback

**Time to rollback:** ~3-5 minutes

```
1. Go to https://dashboard.render.com/web/capstone1-ssd8
2. Click "Deploys" tab
3. Find the previous working deploy
4. Click "Rollback to this deploy"
5. Render rebuilds from that commit
6. Verify: GET https://capstone1-ssd8.onrender.com/health → 200
```

**Manual rollback via git:**
```powershell
# Reset Render to specific commit
git push origin <previous-sha>:main --force-with-lease
# Render auto-deploys if GitHub auto-deploy is enabled
```

---

## 4. Database Migration Rollback

> ⚠️ **CAUTION:** Only run if the migration caused data integrity issues. All migrations are additive — rollback may cause application errors if code expects new columns.

### Rollback tts_audio_cache (Migration 4)
```sql
-- Safe: table is empty until precompute runs
DROP TABLE IF EXISTS public.tts_audio_cache;
```

### Rollback ocr_inference_jobs (Migration 1)
```sql
-- Only safe if no jobs are queued (check first)
SELECT COUNT(*) FROM public.ocr_inference_jobs;
-- If 0: safe to drop
DROP TABLE IF EXISTS public.ocr_inference_jobs;
```

### Rollback soft_delete_catalog_books (Migration 3)
```sql
-- Only safe if no books have been soft-deleted
SELECT COUNT(*) FROM public.books WHERE deleted_at IS NOT NULL;
-- If 0: safe to remove columns
ALTER TABLE public.books DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE public.books DROP COLUMN IF EXISTS deleted_by;
DROP INDEX IF EXISTS idx_books_active;
```

### Rollback security_hardening indexes (Migration 2)
```sql
-- Always safe (indexes only, no data change)
DROP INDEX IF EXISTS idx_pages_book_id;
DROP INDEX IF EXISTS idx_revisions_page_id;
DROP INDEX IF EXISTS idx_reading_progress_user_book;
DROP INDEX IF EXISTS idx_ocr_jobs_status_created;
DROP INDEX IF EXISTS idx_audit_log_user_created;
```

---

## 5. Local Worker Emergency Stop

If workers are causing issues:
```powershell
# Immediate stop
.\scripts\windows\stop-viread-workers.ps1

# Or kill by port
netstat -ano | findstr :8010 | ForEach-Object { 
  $pid = ($_ -split '\s+')[-1]; Stop-Process -Id $pid -Force 
}
netstat -ano | findstr :8011 | ForEach-Object {
  $pid = ($_ -split '\s+')[-1]; Stop-Process -Id $pid -Force
}
```

---

## 6. Supabase Auth Emergency

If authentication is broken:
```
1. Go to https://app.supabase.com/project/akjxbkakbbabpblmsktm/auth/providers
2. Check Email provider is enabled
3. Check Site URL matches https://viread-frontend.vercel.app/
4. If JWT signing key changed: update VIREAD_SSR_AUTH_SIGNING_KEY in Vercel
```

---

## 7. Health Check Endpoints

Use these to verify each service after rollback:

```bash
# Backend
curl https://capstone1-ssd8.onrender.com/health
# Expected: {"status":"ok","services":{...}}

# Frontend (not an API, check HTTP status)
curl -I https://viread-frontend.vercel.app/
# Expected: HTTP/2 200

# Supabase (via backend health)
# The /health endpoint checks DB connectivity
```

---

## 8. Contacts / Escalation

| Role | Action |
|------|--------|
| Project owner | Approve any rollback that affects production data |
| Render dashboard | Manual redeploy / rollback |
| Vercel dashboard | Instant deployment rollback |
| Supabase dashboard | DB inspection, run emergency SQL |
| GitHub | Revert PR, emergency hotfix branch |
