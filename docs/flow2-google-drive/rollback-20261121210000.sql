-- Rollback SQL for 20261121210000_flow2_google_drive_storage.sql
-- SAFETY GUARD: Automatically refuses rollback if any active model, candidate run,
-- dataset version, or verified sample still points to Google Drive.
-- NEVER run on production without migrating/retiring all Google Drive references first.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.viread_ocr_active_model
        WHERE singleton = TRUE AND (storage_provider = 'google_drive' OR storage_path LIKE 'gdrive://%')
    ) THEN
        RAISE EXCEPTION 'Refusing rollback: active VietOCR model currently points to Google Drive. Roll back active model to ORIGINAL or Supabase Legacy first.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.viread_ocr_training_runs
        WHERE storage_provider = 'google_drive' OR checkpoint_storage_path LIKE 'gdrive://%'
    ) THEN
        RAISE EXCEPTION 'Refusing rollback: training runs reference Google Drive checkpoints. Archive or migrate them before rolling back schema.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.viread_ocr_dataset_versions
        WHERE storage_provider = 'google_drive' OR manifest_storage_path LIKE 'gdrive://%'
    ) THEN
        RAISE EXCEPTION 'Refusing rollback: dataset versions reference Google Drive manifests.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.viread_ocr_samples
        WHERE storage_provider = 'google_drive' OR image_storage_path LIKE 'gdrive://%'
    ) THEN
        RAISE EXCEPTION 'Refusing rollback: verified samples reference Google Drive artifacts.';
    END IF;
END $$;

-- 1. Restore original outbox status check constraint (only when no SKIPPED/BLOCKED rows remain)
UPDATE public.viread_ocr_outbox
SET status = 'DEAD'
WHERE status IN ('SKIPPED', 'BLOCKED');

ALTER TABLE public.viread_ocr_outbox
    DROP CONSTRAINT IF EXISTS viread_ocr_outbox_status_check;

ALTER TABLE public.viread_ocr_outbox
    ADD CONSTRAINT viread_ocr_outbox_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'DONE', 'DEAD'));

-- 2. Drop additive columns across Flow 2 training tables
ALTER TABLE public.viread_ocr_model_decisions
    DROP COLUMN IF EXISTS previous_storage_provider,
    DROP COLUMN IF EXISTS candidate_storage_provider;

ALTER TABLE public.viread_ocr_active_model
    DROP COLUMN IF EXISTS drive_file_id,
    DROP COLUMN IF EXISTS storage_provider;

ALTER TABLE public.viread_ocr_benchmarks
    DROP COLUMN IF EXISTS report_drive_file_id,
    DROP COLUMN IF EXISTS report_storage_path,
    DROP COLUMN IF EXISTS storage_provider;

ALTER TABLE public.viread_ocr_checkpoint_chunks
    DROP COLUMN IF EXISTS drive_file_id,
    DROP COLUMN IF EXISTS storage_provider;

ALTER TABLE public.viread_ocr_training_runs
    DROP COLUMN IF EXISTS resume_storage_path,
    DROP COLUMN IF EXISTS checkpoint_drive_file_id,
    DROP COLUMN IF EXISTS storage_provider;

ALTER TABLE public.viread_ocr_dataset_versions
    DROP COLUMN IF EXISTS split_manifests,
    DROP COLUMN IF EXISTS drive_folder_id,
    DROP COLUMN IF EXISTS drive_file_id,
    DROP COLUMN IF EXISTS storage_provider;

DROP INDEX IF EXISTS public.viread_ocr_samples_drive_file_id_idx;
DROP INDEX IF EXISTS public.viread_ocr_samples_storage_provider_idx;

ALTER TABLE public.viread_ocr_samples
    DROP COLUMN IF EXISTS sync_status,
    DROP COLUMN IF EXISTS label_sha256,
    DROP COLUMN IF EXISTS label_drive_file_id,
    DROP COLUMN IF EXISTS label_storage_path,
    DROP COLUMN IF EXISTS drive_file_id,
    DROP COLUMN IF EXISTS storage_provider;

-- 3. Drop private Google Drive connection table
DROP TABLE IF EXISTS public.viread_ocr_drive_connections;
