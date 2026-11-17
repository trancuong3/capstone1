-- Pin every training job to the immutable Locked Test version it must use.
-- generation allows an explicitly closed candidate to be replaced by a new job
-- while regular scheduler polls still deduplicate the same lineage.
ALTER TABLE public.viread_ocr_training_jobs
    ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 1
    CHECK (generation > 0);

DO $$
DECLARE
    existing_constraint TEXT;
BEGIN
    SELECT constraint_row.conname
      INTO existing_constraint
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
      JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
        ON TRUE
      JOIN pg_attribute AS attribute_row
        ON attribute_row.attrelid = table_row.oid
       AND attribute_row.attnum = key_column.attnum
     WHERE constraint_row.contype = 'u'
       AND schema_row.nspname = 'public'
       AND table_row.relname = 'viread_ocr_training_jobs'
     GROUP BY constraint_row.oid, constraint_row.conname
    HAVING array_agg(attribute_row.attname::TEXT ORDER BY key_column.ordinal) = ARRAY[
        'profile', 'dataset_version_id', 'manifest_sha256',
        'config_sha256', 'parent_checkpoint_sha256'
    ]::TEXT[];

    IF existing_constraint IS NULL THEN
        RAISE EXCEPTION 'Expected training-job uniqueness constraint was not found';
    END IF;

    EXECUTE format(
        'ALTER TABLE public.viread_ocr_training_jobs DROP CONSTRAINT %I',
        existing_constraint
    );
END $$;

ALTER TABLE public.viread_ocr_training_jobs
    ADD CONSTRAINT viread_ocr_training_jobs_locked_lineage_key
    UNIQUE NULLS NOT DISTINCT (
        profile,
        dataset_version_id,
        manifest_sha256,
        config_sha256,
        parent_checkpoint_sha256,
        locked_test_version_id,
        generation
    );

COMMENT ON COLUMN public.viread_ocr_training_jobs.generation IS
    'Explicit replacement sequence for a closed unbenchmarked candidate; normal scheduler retries remain idempotent.';

-- Old deployments could already have queued jobs before the worker enforced a
-- pinned Locked Test. Close only jobs that never created a run or a Colab
-- execution; leave active/submitted executions and retained candidates intact.
UPDATE public.viread_ocr_training_jobs
   SET status = 'FAILED',
       last_error_code = 'LOCKED_TEST_REQUIRED_REQUEUE',
       progress = COALESCE(progress, '{}'::jsonb) || jsonb_build_object(
           'stage', 'closed_missing_locked_test'
       ),
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'candidate_disposition', 'closed_missing_locked_test',
           'candidate_disposition_at', now(),
           'candidate_disposition_note', 'Closed before run/execution because this job had no immutable Locked Test.'
       ),
       updated_at = now()
 WHERE status IN ('QUEUED', 'FALLBACK_QUEUED_COLAB', 'WAITING_FOR_COLAB_WORKER',
                  'BLOCKED_CONFIGURATION')
   AND run_id IS NULL
   AND locked_test_version_id IS NULL
   AND locked_test_manifest_sha256 IS NULL
   AND colab_execution_id IS NULL
   AND colab_execution_resource_name IS NULL
   AND colab_operation_name IS NULL
   AND colab_execution_number = 0;
