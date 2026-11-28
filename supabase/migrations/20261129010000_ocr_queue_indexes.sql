-- Partial indexes on public.ocr_inference_jobs to eliminate full-table scans on
-- /health queue counts, admission-control backpressure checks, SHA-256 cache hits,
-- and active duplicate job lookups.

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_active_status
    ON public.ocr_inference_jobs (status, created_at)
    WHERE status IN ('QUEUED', 'CLAIMED', 'RUNNING', 'FAILED_RETRYABLE');

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_dead_letter
    ON public.ocr_inference_jobs (completed_at DESC)
    WHERE status = 'DEAD_LETTER';

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_succeeded_completed
    ON public.ocr_inference_jobs (completed_at DESC)
    WHERE status = 'SUCCEEDED';

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_sha256_cache
    ON public.ocr_inference_jobs (image_sha256, completed_at DESC)
    WHERE status = 'SUCCEEDED';

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_sha256_active
    ON public.ocr_inference_jobs (image_sha256, job_kind, owner_user_id)
    WHERE status IN ('QUEUED', 'CLAIMED', 'RUNNING', 'FAILED_RETRYABLE');
