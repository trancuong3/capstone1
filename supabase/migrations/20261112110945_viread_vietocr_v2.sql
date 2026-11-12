-- Additive, private persistence for the ViOCR V2 data/training/evaluation pipeline.
-- Browser roles receive no access; the existing server-side DB connection owns all writes.

CREATE TABLE IF NOT EXISTS public.viread_ocr_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL CHECK (event_type IN ('VERIFIED_REVISION')),
    page_id UUID NOT NULL REFERENCES public.bookpages(id) ON DELETE CASCADE,
    revision_id UUID NOT NULL REFERENCES public.pagerevisions(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'DONE', 'DEAD')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at TIMESTAMPTZ,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event_type, revision_id)
);
CREATE INDEX IF NOT EXISTS viread_ocr_outbox_poll_idx
    ON public.viread_ocr_outbox (available_at, created_at) WHERE status IN ('PENDING', 'RETRY', 'PROCESSING');

CREATE TABLE IF NOT EXISTS public.viread_ocr_dataset_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_flow TEXT NOT NULL CHECK (source_flow IN ('FLOW1_VERIFIED', 'FLOW2_EXTERNAL', 'FLOW2_TRDG', 'FLOW2_EXTERNAL_TRDG', 'LOCKED_TEST')),
    version_sha256 TEXT NOT NULL CHECK (version_sha256 ~ '^[0-9a-f]{64}$'),
    manifest_storage_path TEXT NOT NULL,
    sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
    is_locked_test BOOLEAN NOT NULL DEFAULT FALSE,
    split_seed TEXT NOT NULL,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_flow, version_sha256),
    CHECK ((source_flow = 'LOCKED_TEST') = is_locked_test)
);

CREATE TABLE IF NOT EXISTS public.viread_ocr_samples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_version_id UUID REFERENCES public.viread_ocr_dataset_versions(id) ON DELETE SET NULL,
    source_flow TEXT NOT NULL CHECK (source_flow IN ('FLOW1_VERIFIED', 'FLOW2_EXTERNAL', 'FLOW2_TRDG', 'LOCKED_TEST')),
    source_group_id TEXT NOT NULL,
    split TEXT NOT NULL CHECK (split IN ('train', 'validation', 'holdout', 'locked_test')),
    image_storage_path TEXT NOT NULL,
    image_sha256 TEXT NOT NULL CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
    label TEXT NOT NULL CHECK (length(label) > 0),
    source_page_id UUID REFERENCES public.bookpages(id) ON DELETE SET NULL,
    source_revision_id UUID REFERENCES public.pagerevisions(id) ON DELETE SET NULL,
    source_annotation_id TEXT,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((source_flow = 'LOCKED_TEST') = (split = 'locked_test'))
);
CREATE UNIQUE INDEX IF NOT EXISTS viread_ocr_samples_identity_uidx
    ON public.viread_ocr_samples
       (source_flow, (COALESCE(dataset_version_id, '00000000-0000-0000-0000-000000000000'::uuid)), image_storage_path);
CREATE INDEX IF NOT EXISTS viread_ocr_samples_profile_idx
    ON public.viread_ocr_samples (source_flow, split, source_group_id);

CREATE TABLE IF NOT EXISTS public.viread_ocr_training_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_family TEXT NOT NULL DEFAULT 'vietocr_v2' CHECK (model_family = 'vietocr_v2'),
    profile TEXT NOT NULL CHECK (profile IN ('FLOW1_VERIFIED', 'FLOW2_EXTERNAL_TRDG')),
    status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'RUNNING', 'CANDIDATE', 'BENCHMARKED', 'FAILED', 'CANCELLED')),
    parent_checkpoint_sha256 TEXT NOT NULL CHECK (parent_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
    manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    config_sha256 TEXT NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
    architecture_sha256 TEXT NOT NULL CHECK (architecture_sha256 ~ '^[0-9a-f]{64}$'),
    vocabulary_sha256 TEXT NOT NULL CHECK (vocabulary_sha256 ~ '^[0-9a-f]{64}$'),
    checkpoint_sha256 TEXT CHECK (checkpoint_sha256 IS NULL OR checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
    checkpoint_bytes BIGINT CHECK (checkpoint_bytes IS NULL OR checkpoint_bytes > 0),
    checkpoint_storage_path TEXT,
    step INTEGER NOT NULL DEFAULT 0 CHECK (step >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.viread_ocr_checkpoint_chunks (
    run_id UUID NOT NULL REFERENCES public.viread_ocr_training_runs(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    chunk_sha256 TEXT NOT NULL CHECK (chunk_sha256 ~ '^[0-9a-f]{64}$'),
    storage_path TEXT NOT NULL UNIQUE,
    byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 41943040),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS public.viread_ocr_benchmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES public.viread_ocr_training_runs(id) ON DELETE RESTRICT,
    baseline_checkpoint_sha256 TEXT NOT NULL CHECK (baseline_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
    candidate_checkpoint_sha256 TEXT NOT NULL CHECK (candidate_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
    locked_test_version_id UUID NOT NULL REFERENCES public.viread_ocr_dataset_versions(id) ON DELETE RESTRICT,
    locked_test_manifest_sha256 TEXT NOT NULL CHECK (locked_test_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    report_sha256 TEXT NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
    gate_status TEXT NOT NULL CHECK (gate_status IN ('V2_WIN', 'ORIGINAL_WIN', 'NO_SIGNIFICANT_DIFFERENCE', 'INSUFFICIENT_EVIDENCE', 'EVALUATION_FAILED')),
    sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
    group_count INTEGER NOT NULL CHECK (group_count >= 0),
    metrics JSONB NOT NULL,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.viread_ocr_model_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action TEXT NOT NULL CHECK (action IN ('APPROVE', 'ROLLBACK')),
    candidate_checkpoint_sha256 TEXT NOT NULL CHECK (candidate_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
    previous_checkpoint_sha256 TEXT NOT NULL CHECK (previous_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
    candidate_storage_path TEXT,
    previous_storage_path TEXT,
    candidate_profile TEXT NOT NULL CHECK (candidate_profile IN ('ORIGINAL', 'FLOW1_VERIFIED', 'FLOW2_EXTERNAL_TRDG')),
    previous_profile TEXT NOT NULL CHECK (previous_profile IN ('ORIGINAL', 'FLOW1_VERIFIED', 'FLOW2_EXTERNAL_TRDG')),
    benchmark_id UUID REFERENCES public.viread_ocr_benchmarks(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    actor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.viread_ocr_active_model (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    model_family TEXT NOT NULL DEFAULT 'vietocr_v2' CHECK (model_family = 'vietocr_v2'),
    checkpoint_sha256 TEXT NOT NULL CHECK (checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
    storage_path TEXT,
    profile TEXT NOT NULL DEFAULT 'ORIGINAL' CHECK (profile IN ('ORIGINAL', 'FLOW1_VERIFIED', 'FLOW2_EXTERNAL_TRDG')),
    decision_id UUID REFERENCES public.viread_ocr_model_decisions(id) ON DELETE RESTRICT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.viread_ocr_active_model (singleton, checkpoint_sha256, storage_path, profile)
VALUES (TRUE, '380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59', NULL, 'ORIGINAL')
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.viread_ocr_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viread_ocr_dataset_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viread_ocr_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viread_ocr_training_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viread_ocr_checkpoint_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viread_ocr_benchmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viread_ocr_model_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.viread_ocr_active_model ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.viread_ocr_outbox, public.viread_ocr_dataset_versions,
    public.viread_ocr_samples, public.viread_ocr_training_runs,
    public.viread_ocr_checkpoint_chunks, public.viread_ocr_benchmarks,
    public.viread_ocr_model_decisions, public.viread_ocr_active_model
    FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.viread_ocr_outbox, public.viread_ocr_dataset_versions,
    public.viread_ocr_samples, public.viread_ocr_training_runs,
    public.viread_ocr_checkpoint_chunks, public.viread_ocr_benchmarks,
    public.viread_ocr_model_decisions, public.viread_ocr_active_model
    TO service_role;

COMMENT ON TABLE public.viread_ocr_outbox IS 'Durable transactional outbox for Admin VERIFIED OCR revisions; payloads contain IDs only.';
COMMENT ON TABLE public.viread_ocr_samples IS 'Private line-level training data with explicit source-flow and document-group split provenance.';
COMMENT ON TABLE public.viread_ocr_active_model IS 'Single active VietOCR V2 lineage pointer; Original is the initial rollback baseline.';
