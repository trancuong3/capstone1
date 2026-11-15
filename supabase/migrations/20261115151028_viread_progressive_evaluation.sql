-- Additive progressive evaluation metadata. Existing datasets, benchmarks, jobs,
-- checkpoints, and decisions remain intact and keep their legacy interpretation.

CREATE TABLE IF NOT EXISTS public.viread_ocr_evaluation_cohorts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluation_type TEXT NOT NULL CHECK (evaluation_type IN ('PILOT', 'PRODUCTION')),
    dataset_version_id UUID NOT NULL UNIQUE
        REFERENCES public.viread_ocr_dataset_versions(id) ON DELETE RESTRICT,
    manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    seed TEXT NOT NULL,
    sampling_policy TEXT NOT NULL,
    sample_count INTEGER NOT NULL CHECK (sample_count > 0),
    group_count INTEGER NOT NULL CHECK (group_count > 0),
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.viread_ocr_training_jobs
    ADD COLUMN IF NOT EXISTS evaluation_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (evaluation_attempts >= 0);

ALTER TABLE public.viread_ocr_benchmarks
    ADD COLUMN IF NOT EXISTS evaluation_cohort_id UUID
        REFERENCES public.viread_ocr_evaluation_cohorts(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS evaluation_type TEXT NOT NULL DEFAULT 'PRODUCTION'
        CHECK (evaluation_type IN ('PILOT', 'PRODUCTION')),
    ADD COLUMN IF NOT EXISTS parent_checkpoint_sha256 TEXT
        CHECK (parent_checkpoint_sha256 IS NULL OR parent_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
    ADD COLUMN IF NOT EXISTS active_checkpoint_sha256 TEXT
        CHECK (active_checkpoint_sha256 IS NULL OR active_checkpoint_sha256 ~ '^[0-9a-f]{64}$');

-- A sealed cohort is consumed once globally; repeated candidate comparisons
-- require a fresh independent cohort and cannot turn optional stopping into evidence.
CREATE UNIQUE INDEX IF NOT EXISTS viread_ocr_benchmarks_evaluation_cohort_uidx
    ON public.viread_ocr_benchmarks (evaluation_cohort_id)
    WHERE evaluation_cohort_id IS NOT NULL;

ALTER TABLE public.viread_ocr_evaluation_cohorts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.viread_ocr_evaluation_cohorts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.viread_ocr_evaluation_cohorts TO service_role;

COMMENT ON TABLE public.viread_ocr_evaluation_cohorts IS
    'Immutable, single-use Pilot or Production evaluation snapshot; membership is pinned by dataset manifest hash.';
