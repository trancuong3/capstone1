# 06 — Database Migration Report

**Date:** 2026-11-25  
**Supabase Project:** `akjxbkakbbabpblmsktm`  
**Applied by:** Antigravity agent (session 2026-11-25)

---

## 1. Migrations Applied

All 4 migrations listed below were applied to the production Supabase instance during this release cycle.

| # | Migration File | Applied | Status |
|---|---------------|---------|--------|
| 1 | `20261124010000_ocr_inference_jobs.sql` | 2026-11-24 | ✅ Applied |
| 2 | `20261124020000_security_hardening_and_hot_fk_indexes.sql` | 2026-11-24 | ✅ Applied |
| 3 | `20261124030000_soft_delete_catalog_books.sql` | 2026-11-24 | ✅ Applied |
| 4 | `20261125130000_tts_audio_cache.sql` | 2026-11-25 | ✅ Applied |

---

## 2. Migration Details

### Migration 1: OCR Inference Jobs

**Purpose:** Async OCR queue system — buffers OCR requests when local worker is offline.

```sql
CREATE TABLE ocr_inference_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  image_url TEXT,
  extracted_text TEXT,
  confidence FLOAT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
```

**RLS:** Enabled — admin-only write, authenticated read own jobs.

### Migration 2: Security Hardening + FK Indexes

**Purpose:** Add indexes for hot foreign key paths + tighten RLS.

Key indexes added:
- `idx_pages_book_id` — pages.book_id FK
- `idx_revisions_page_id` — revisions.page_id FK
- `idx_reading_progress_user_book` — composite (user_id, book_id)
- `idx_ocr_jobs_status_created` — queue poll index
- `idx_audit_log_user_created` — audit queries

### Migration 3: Soft Delete Catalog Books

**Purpose:** Allow admin to soft-delete books without permanent data loss.

```sql
ALTER TABLE books ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE books ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES profiles(id);
CREATE INDEX idx_books_active ON books(deleted_at) WHERE deleted_at IS NULL;
```

**Effect:** `GET /v1/books` now filters `WHERE deleted_at IS NULL` by default.

### Migration 4: TTS Audio Cache

**Purpose:** Store precomputed TTS MP3 files for laptop-independent playback.

```sql
CREATE TABLE tts_audio_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
  text_hash TEXT NOT NULL,
  audio_path TEXT NOT NULL,  -- Supabase Storage path
  voice_id TEXT DEFAULT 'vi-VN-Standard-A',
  duration_ms INTEGER,
  file_size_bytes INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (page_id, voice_id, text_hash)
);
```

**RLS:** Authenticated users can read; service role writes.

---

## 3. Verification

**Method:** Queried Supabase via `execute_sql` MCP tool during session.

```sql
-- Verified tables exist
SELECT tablename FROM pg_tables 
WHERE schemaname = 'public' 
  AND tablename IN ('ocr_inference_jobs', 'tts_audio_cache');
-- Result: 2 rows returned ✅

-- Verified soft-delete column
SELECT column_name FROM information_schema.columns
WHERE table_name = 'books' AND column_name = 'deleted_at';
-- Result: 1 row ✅

-- Verified FK indexes
SELECT indexname FROM pg_indexes
WHERE tablename = 'pages' AND indexname = 'idx_pages_book_id';
-- Result: 1 row ✅
```

---

## 4. Rollback Procedure

If a migration causes issues, rollback SQL is documented in `docs/release/zero-cost-production/14-rollback-runbook.md`.

| Migration | Rollback risk | Safe to reverse? |
|-----------|--------------|-----------------|
| ocr_inference_jobs | Drop table | ✅ Yes (no production data) |
| security_hardening indexes | Drop indexes | ✅ Yes (no data) |
| soft_delete_catalog_books | Remove column | ⚠️ Only if no books have been soft-deleted |
| tts_audio_cache | Drop table | ✅ Yes (cache is regenerable) |

---

## 5. Data Integrity Verification

```
Active books before migration:   11
Active books after migration:    11 (unchanged)
Active pages:                    32 (unchanged)
Revisions verified:              23 (unchanged)
ocr_inference_jobs rows:         0 (empty, expected)
tts_audio_cache rows:            0 (empty, precompute not yet run)
```

No data loss. All migrations additive only.
