-- Additive, zero-downtime migration for durable Flow 2 sample quarantine/archiving
-- and historical dataset version archiving (preventing old samples/snapshots from
-- re-entering new Flow 2 training pools while preserving all audit/checkpoint history).

ALTER TABLE public.viread_ocr_samples
    ADD COLUMN IF NOT EXISTS training_eligibility TEXT NOT NULL DEFAULT 'ELIGIBLE'
        CHECK (training_eligibility IN ('ELIGIBLE', 'QUARANTINED', 'ARCHIVED')),
    ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS quarantine_reason TEXT,
    ADD COLUMN IF NOT EXISTS quarantined_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS viread_ocr_samples_flow2_eligible_pool_idx
    ON public.viread_ocr_samples (source_flow, training_eligibility, storage_provider, split)
    WHERE dataset_version_id IS NULL;

ALTER TABLE public.viread_ocr_dataset_versions
    ADD COLUMN IF NOT EXISTS dataset_status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (dataset_status IN ('ACTIVE', 'ARCHIVED')),
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS archive_reason TEXT;

CREATE INDEX IF NOT EXISTS viread_ocr_dataset_versions_active_idx
    ON public.viread_ocr_dataset_versions (source_flow, dataset_status, created_at DESC);

COMMENT ON COLUMN public.viread_ocr_samples.training_eligibility IS
    'Controls whether a pool sample is eligible for new Flow 2 dataset snapshots (ELIGIBLE, QUARANTINED, ARCHIVED). Historical snapshot rows stay immutable.';
COMMENT ON COLUMN public.viread_ocr_dataset_versions.dataset_status IS
    'ACTIVE datasets may be referenced for new scheduling, whereas ARCHIVED datasets remain immutable for historical runs/benchmarks/audit only.';
