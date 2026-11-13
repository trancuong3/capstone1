-- Durable routing queue for automatic Flow 2 training.
-- No browser role can access this table; API/worker DB connections own writes.

ALTER TABLE public.viread_ocr_training_runs
    ADD COLUMN IF NOT EXISTS dataset_version_id UUID
    REFERENCES public.viread_ocr_dataset_versions(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS public.viread_ocr_training_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile TEXT NOT NULL CHECK (profile = 'FLOW2_ADMIN_VERIFIED'),
    dataset_version_id UUID NOT NULL REFERENCES public.viread_ocr_dataset_versions(id) ON DELETE RESTRICT,
    manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    config_sha256 TEXT NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
    parent_checkpoint_sha256 TEXT NOT NULL CHECK (parent_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
    target TEXT NOT NULL CHECK (target IN ('LOCAL', 'COLAB')),
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN (
        'QUEUED', 'LOCAL_RUNNING', 'FALLBACK_QUEUED_COLAB', 'COLAB_RUNNING',
        'WAITING_FOR_DATA', 'WAITING_FOR_COLAB_WORKER', 'CANDIDATE', 'BENCHMARKED', 'FAILED', 'BLOCKED'
    )),
    run_id UUID REFERENCES public.viread_ocr_training_runs(id) ON DELETE SET NULL,
    locked_test_version_id UUID REFERENCES public.viread_ocr_dataset_versions(id) ON DELETE RESTRICT,
    locked_test_manifest_sha256 TEXT CHECK (locked_test_manifest_sha256 IS NULL OR locked_test_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    worker_id TEXT,
    lease_expires_at TIMESTAMPTZ,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    progress JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error_code TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (profile, dataset_version_id, manifest_sha256, config_sha256, parent_checkpoint_sha256)
);

CREATE INDEX IF NOT EXISTS viread_ocr_training_jobs_poll_idx
    ON public.viread_ocr_training_jobs (target, status, created_at)
    WHERE status IN ('QUEUED', 'FALLBACK_QUEUED_COLAB', 'WAITING_FOR_COLAB_WORKER', 'WAITING_FOR_DATA');

CREATE INDEX IF NOT EXISTS viread_ocr_training_jobs_lease_idx
    ON public.viread_ocr_training_jobs (lease_expires_at)
    WHERE status IN ('LOCAL_RUNNING', 'COLAB_RUNNING');

ALTER TABLE public.viread_ocr_training_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.viread_ocr_training_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.viread_ocr_training_jobs TO service_role;

COMMENT ON TABLE public.viread_ocr_training_jobs IS
    'Durable automatic training queue for Admin VERIFIED flow; target and lease prevent duplicate local/Colab execution.';
