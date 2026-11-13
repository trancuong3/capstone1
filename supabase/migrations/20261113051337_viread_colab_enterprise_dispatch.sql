-- Add Colab Enterprise execution tracking while preserving every existing job and run.
-- The existing queue migration has already been applied; constraints are widened in
-- this transaction so there is no interval where stored jobs become invalid.

ALTER TABLE public.viread_ocr_training_jobs
    DROP CONSTRAINT IF EXISTS viread_ocr_training_jobs_profile_check;
ALTER TABLE public.viread_ocr_training_jobs
    ADD CONSTRAINT viread_ocr_training_jobs_profile_check
    CHECK (profile IN (
        'FLOW1_EXTERNAL_TRDG', 'FLOW2_ADMIN_VERIFIED',
        'FLOW1_VERIFIED', 'FLOW2_EXTERNAL_TRDG'
    ));

ALTER TABLE public.viread_ocr_training_jobs
    DROP CONSTRAINT IF EXISTS viread_ocr_training_jobs_status_check;
ALTER TABLE public.viread_ocr_training_jobs
    ADD CONSTRAINT viread_ocr_training_jobs_status_check
    CHECK (status IN (
        'QUEUED', 'LOCAL_RUNNING', 'FALLBACK_QUEUED_COLAB', 'COLAB_RUNNING',
        'WAITING_FOR_DATA', 'WAITING_FOR_COLAB_WORKER',
        'COLAB_SUBMITTING', 'COLAB_SUBMITTED', 'COLAB_EXECUTING',
        'BLOCKED_CONFIGURATION', 'QUALITY_GATE_REJECTED',
        'CANDIDATE', 'BENCHMARKED', 'FAILED', 'BLOCKED'
    ));

ALTER TABLE public.viread_ocr_training_jobs
    ADD COLUMN IF NOT EXISTS colab_execution_id TEXT,
    ADD COLUMN IF NOT EXISTS colab_execution_resource_name TEXT,
    ADD COLUMN IF NOT EXISTS colab_operation_name TEXT,
    ADD COLUMN IF NOT EXISTS colab_dispatch_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS colab_execution_number INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS colab_submitted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS colab_last_polled_at TIMESTAMPTZ;

ALTER TABLE public.viread_ocr_training_jobs
    ADD CONSTRAINT viread_ocr_training_jobs_colab_execution_id_check
        CHECK (colab_execution_id IS NULL OR colab_execution_id ~ '^vr-[a-f0-9]{32}-[1-9][0-9]*$'),
    ADD CONSTRAINT viread_ocr_training_jobs_colab_dispatch_attempts_check
        CHECK (colab_dispatch_attempts >= 0),
    ADD CONSTRAINT viread_ocr_training_jobs_colab_execution_number_check
        CHECK (colab_execution_number >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS viread_ocr_training_jobs_colab_execution_id_idx
    ON public.viread_ocr_training_jobs (colab_execution_id)
    WHERE colab_execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS viread_ocr_training_jobs_colab_dispatch_idx
    ON public.viread_ocr_training_jobs (available_at, created_at)
    WHERE target = 'COLAB'
      AND status IN ('WAITING_FOR_COLAB_WORKER', 'FALLBACK_QUEUED_COLAB',
                     'COLAB_SUBMITTED', 'COLAB_EXECUTING', 'BLOCKED_CONFIGURATION');

COMMENT ON COLUMN public.viread_ocr_training_jobs.colab_execution_id IS
    'Stable per-attempt Colab Enterprise execution ID used for idempotent submissions.';
COMMENT ON COLUMN public.viread_ocr_training_jobs.colab_execution_resource_name IS
    'Google Colab Enterprise NotebookExecutionJob resource name; never a credential.';
