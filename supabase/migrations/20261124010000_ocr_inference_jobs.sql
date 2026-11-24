-- Durable OCR inference queue and remote Windows OCR worker heartbeats.
-- Supports Stage B remote_worker mode without putting DB/Supabase credentials on the worker.

CREATE TABLE IF NOT EXISTS public.ocr_inference_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_kind TEXT NOT NULL CHECK (
        job_kind IN (
            'ADMIN_PAGE_UPLOAD',
            'ADMIN_PAGE_REUPLOAD',
            'ADMIN_PAGE_REPROCESS',
            'PARENT_BOOK_SUBMISSION',
            'LOCAL_PAGE_SCAN'
        )
    ),
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (
        status IN (
            'QUEUED',
            'CLAIMED',
            'RUNNING',
            'SUCCEEDED',
            'FAILED_RETRYABLE',
            'DEAD_LETTER',
            'CANCELLED'
        )
    ),
    priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0 AND priority <= 1000),
    idempotency_key TEXT,
    owner_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    book_id UUID REFERENCES public.books(id) ON DELETE CASCADE,
    page_id UUID REFERENCES public.bookpages(id) ON DELETE CASCADE,
    revision_id UUID REFERENCES public.pagerevisions(id) ON DELETE SET NULL,
    submission_id UUID REFERENCES public.parent_book_page_submissions(id) ON DELETE CASCADE,
    local_scan_request_id TEXT,
    image_bucket TEXT,
    image_path TEXT NOT NULL,
    image_sha256 TEXT NOT NULL,
    image_width INTEGER,
    image_height INTEGER,
    image_mime_type TEXT,
    processing_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    expected_version INTEGER NOT NULL DEFAULT 1,
    expected_candidate_hash TEXT,
    expected_verified_revision_id UUID,
    expected_latest_revision_id UUID,
    fencing_token BIGINT NOT NULL DEFAULT 0,
    worker_id TEXT,
    claimed_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1 AND max_attempts <= 20),
    next_retry_at TIMESTAMPTZ,
    retry_delay_seconds INTEGER,
    error_code TEXT,
    error_message TEXT,
    result_payload JSONB,
    model_profile TEXT,
    model_sha256 TEXT,
    engine_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
    duration_ms INTEGER,
    cancelled_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.ocr_worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    hostname TEXT,
    app_version TEXT,
    git_sha TEXT,
    status TEXT NOT NULL DEFAULT 'IDLE' CHECK (
        status IN ('STARTING', 'IDLE', 'BUSY', 'DEGRADED', 'OFFLINE')
    ),
    active_job_id UUID REFERENCES public.ocr_inference_jobs(id) ON DELETE SET NULL,
    active_job_count INTEGER NOT NULL DEFAULT 0 CHECK (active_job_count >= 0),
    concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 1),
    model_profile TEXT,
    model_sha256 TEXT,
    engines JSONB NOT NULL DEFAULT '{}'::jsonb,
    system_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error TEXT,
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_claim_queue
    ON public.ocr_inference_jobs (priority ASC, created_at ASC)
    WHERE status IN ('QUEUED', 'FAILED_RETRYABLE');

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_active_lease
    ON public.ocr_inference_jobs (lease_expires_at ASC)
    WHERE status IN ('CLAIMED', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_book_created
    ON public.ocr_inference_jobs (book_id, created_at DESC)
    WHERE book_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_page_active
    ON public.ocr_inference_jobs (page_id, created_at DESC)
    WHERE page_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_submission_created
    ON public.ocr_inference_jobs (submission_id, created_at DESC)
    WHERE submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ocr_inference_jobs_owner_created
    ON public.ocr_inference_jobs (owner_user_id, created_at DESC)
    WHERE owner_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ocr_inference_jobs_idempotency
    ON public.ocr_inference_jobs (
        job_kind,
        COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
        idempotency_key
    )
    WHERE idempotency_key IS NOT NULL AND status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS idx_ocr_worker_heartbeats_last_seen
    ON public.ocr_worker_heartbeats (last_heartbeat_at DESC);

ALTER TABLE public.ocr_inference_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ocr_worker_heartbeats ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ocr_inference_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ocr_worker_heartbeats FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.ocr_inference_jobs TO service_role;
GRANT ALL ON TABLE public.ocr_worker_heartbeats TO service_role;

DROP POLICY IF EXISTS "ocr_inference_jobs_service_role_only" ON public.ocr_inference_jobs;
CREATE POLICY "ocr_inference_jobs_service_role_only"
    ON public.ocr_inference_jobs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "ocr_worker_heartbeats_service_role_only" ON public.ocr_worker_heartbeats;
CREATE POLICY "ocr_worker_heartbeats_service_role_only"
    ON public.ocr_worker_heartbeats
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
