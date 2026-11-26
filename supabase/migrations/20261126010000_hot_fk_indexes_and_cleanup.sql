-- Add missing partial foreign-key indexes for recent OCR queue, TTS cache,
-- and Smart Book Studio V2 tables (matches live Supabase migration).
-- Strictly additive and idempotent.

BEGIN;

CREATE INDEX IF NOT EXISTS ix_ocr_inference_jobs_revision_id
    ON public.ocr_inference_jobs (revision_id)
    WHERE revision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_ocr_worker_heartbeats_active_job_id
    ON public.ocr_worker_heartbeats (active_job_id)
    WHERE active_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_tts_audio_cache_entries_page_id
    ON public.tts_audio_cache_entries (page_id)
    WHERE page_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_tts_audio_cache_entries_page_revision_id
    ON public.tts_audio_cache_entries (page_revision_id)
    WHERE page_revision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_book_presentation_assets_source_revision_id
    ON public.book_presentation_assets (source_revision_id)
    WHERE source_revision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_book_style_bibles_owner_id
    ON public.book_style_bibles (owner_id)
    WHERE owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_page_ocr_extractions_page_revision_id
    ON public.page_ocr_extractions (page_revision_id)
    WHERE page_revision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_page_ocr_extractions_owner_id
    ON public.page_ocr_extractions (owner_id)
    WHERE owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_smart_studio_jobs_book_id
    ON public.smart_studio_jobs (book_id)
    WHERE book_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_smart_studio_jobs_book_page_id
    ON public.smart_studio_jobs (book_page_id)
    WHERE book_page_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_smart_studio_jobs_source_revision_id
    ON public.smart_studio_jobs (source_revision_id)
    WHERE source_revision_id IS NOT NULL;

COMMIT;
