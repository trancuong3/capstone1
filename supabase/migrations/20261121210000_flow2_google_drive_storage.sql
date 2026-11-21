-- Additive, zero-downtime migration for Flow 2 Google Drive-First AI Training Storage.
-- All existing Supabase Storage legacy rows remain readable with default storage_provider = 'supabase_legacy'.
-- Browser roles (anon, authenticated) receive zero access; server-side DB connections own all writes.

-- 1. Private server-managed Google Drive OAuth 2.0 connection & quota state for Flow 2.
CREATE TABLE IF NOT EXISTS public.viread_ocr_drive_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_key TEXT NOT NULL UNIQUE DEFAULT 'flow2_primary'
        CHECK (connection_key = 'flow2_primary'),
    status TEXT NOT NULL DEFAULT 'DISCONNECTED'
        CHECK (status IN ('CONNECTED', 'DISCONNECTED', 'ERROR', 'TOKEN_REVOKED')),
    account_email TEXT,
    account_display_name TEXT,
    oauth_scope TEXT,
    encrypted_refresh_token TEXT,
    token_key_fingerprint TEXT,
    root_folder_id TEXT,
    root_folder_path TEXT NOT NULL DEFAULT 'MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified',
    subfolder_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
    quota_limit_bytes BIGINT CHECK (quota_limit_bytes IS NULL OR quota_limit_bytes >= 0),
    quota_usage_bytes BIGINT CHECK (quota_usage_bytes IS NULL OR quota_usage_bytes >= 0),
    quota_usage_in_drive_bytes BIGINT CHECK (quota_usage_in_drive_bytes IS NULL OR quota_usage_in_drive_bytes >= 0),
    quota_usage_in_trash_bytes BIGINT CHECK (quota_usage_in_trash_bytes IS NULL OR quota_usage_in_trash_bytes >= 0),
    quota_checked_at TIMESTAMPTZ,
    last_health_check_at TIMESTAMPTZ,
    last_health_status TEXT,
    last_error_code TEXT,
    connected_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    connected_at TIMESTAMPTZ,
    disconnected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.viread_ocr_drive_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.viread_ocr_drive_connections FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.viread_ocr_drive_connections TO service_role;

COMMENT ON TABLE public.viread_ocr_drive_connections IS
    'Server-only Google Drive OAuth 2.0 connection metadata and Fernet-encrypted refresh token for Flow 2 training artifacts.';

-- 2. Provider-explicit storage metadata on Flow 2 training tables (additive, backward-compatible).
ALTER TABLE public.viread_ocr_samples
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'supabase_legacy'
        CHECK (storage_provider IN ('supabase_legacy', 'google_drive')),
    ADD COLUMN IF NOT EXISTS drive_file_id TEXT,
    ADD COLUMN IF NOT EXISTS label_storage_path TEXT,
    ADD COLUMN IF NOT EXISTS label_drive_file_id TEXT,
    ADD COLUMN IF NOT EXISTS label_sha256 TEXT
        CHECK (label_sha256 IS NULL OR label_sha256 ~ '^[0-9a-f]{64}$'),
    ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'SYNCED'
        CHECK (sync_status IN ('SYNCED', 'PENDING', 'FAILED', 'BLOCKED_CONFLICT'));

CREATE INDEX IF NOT EXISTS viread_ocr_samples_storage_provider_idx
    ON public.viread_ocr_samples (source_flow, storage_provider, split);

CREATE INDEX IF NOT EXISTS viread_ocr_samples_drive_file_id_idx
    ON public.viread_ocr_samples (drive_file_id)
    WHERE drive_file_id IS NOT NULL;

ALTER TABLE public.viread_ocr_dataset_versions
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'supabase_legacy'
        CHECK (storage_provider IN ('supabase_legacy', 'google_drive')),
    ADD COLUMN IF NOT EXISTS drive_file_id TEXT,
    ADD COLUMN IF NOT EXISTS drive_folder_id TEXT,
    ADD COLUMN IF NOT EXISTS split_manifests JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.viread_ocr_training_runs
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'supabase_legacy'
        CHECK (storage_provider IN ('supabase_legacy', 'google_drive')),
    ADD COLUMN IF NOT EXISTS checkpoint_drive_file_id TEXT,
    ADD COLUMN IF NOT EXISTS resume_storage_path TEXT;

ALTER TABLE public.viread_ocr_checkpoint_chunks
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'supabase_legacy'
        CHECK (storage_provider IN ('supabase_legacy', 'google_drive')),
    ADD COLUMN IF NOT EXISTS drive_file_id TEXT;

ALTER TABLE public.viread_ocr_benchmarks
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'supabase_legacy'
        CHECK (storage_provider IN ('supabase_legacy', 'google_drive')),
    ADD COLUMN IF NOT EXISTS report_storage_path TEXT,
    ADD COLUMN IF NOT EXISTS report_drive_file_id TEXT;

ALTER TABLE public.viread_ocr_active_model
    ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'supabase_legacy'
        CHECK (storage_provider IN ('supabase_legacy', 'google_drive')),
    ADD COLUMN IF NOT EXISTS drive_file_id TEXT;

ALTER TABLE public.viread_ocr_model_decisions
    ADD COLUMN IF NOT EXISTS candidate_storage_provider TEXT NOT NULL DEFAULT 'supabase_legacy'
        CHECK (candidate_storage_provider IN ('supabase_legacy', 'google_drive')),
    ADD COLUMN IF NOT EXISTS previous_storage_provider TEXT NOT NULL DEFAULT 'supabase_legacy'
        CHECK (previous_storage_provider IN ('supabase_legacy', 'google_drive'));

-- 3. Widen transactional outbox statuses to distinguish AI-only skips and hash-conflict blocks cleanly.
DO $$
DECLARE
    con_name TEXT;
BEGIN
    SELECT c.conname INTO con_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'viread_ocr_outbox'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%status%PENDING%PROCESSING%';

    IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.viread_ocr_outbox DROP CONSTRAINT %I', con_name);
    END IF;
END $$;

ALTER TABLE public.viread_ocr_outbox
    ADD CONSTRAINT viread_ocr_outbox_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'RETRY', 'DONE', 'DEAD', 'SKIPPED', 'BLOCKED'));
