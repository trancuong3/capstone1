-- Schema rollback for 20261122100000_flow2_sample_quarantine_and_archive.sql
-- Safe to run only after restoring or confirming no code depends on training_eligibility / dataset_status.

DROP INDEX IF EXISTS public.viread_ocr_dataset_versions_active_idx;
DROP INDEX IF EXISTS public.viread_ocr_samples_flow2_eligible_pool_idx;

ALTER TABLE public.viread_ocr_dataset_versions
    DROP COLUMN IF EXISTS archive_reason,
    DROP COLUMN IF EXISTS archived_at,
    DROP COLUMN IF EXISTS dataset_status;

ALTER TABLE public.viread_ocr_samples
    DROP COLUMN IF EXISTS quarantined_by,
    DROP COLUMN IF EXISTS quarantine_reason,
    DROP COLUMN IF EXISTS quarantined_at,
    DROP COLUMN IF EXISTS training_eligibility;
