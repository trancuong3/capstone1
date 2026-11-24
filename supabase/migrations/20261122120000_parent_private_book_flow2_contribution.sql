-- Additive, zero-downtime migration for Parent Private Book -> Flow 2 (Admin Verified) OCR sample contribution.
-- 1. Book-level opt-in consent state (default OFF; existing books are never auto-collected) + immutable consent audit events.
-- 2. Line-level candidate recruitment & Admin verification queue (`parent_book_flow2_candidates`).
-- 3. Extend `viread_ocr_outbox` cleanly to support `PARENT_CONTRIBUTION_CANDIDATE` alongside `VERIFIED_REVISION`.
-- 4. Server-only RLS and privilege isolation so anon/authenticated roles can never read or tamper with consent/candidate tables.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Book-level consent state (default OFF: absence of row or status <> 'OPTED_IN' means NO training)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.parent_book_ocr_contribution_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id UUID NOT NULL UNIQUE REFERENCES public.books(id) ON DELETE CASCADE,
    owner_parent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    purpose TEXT NOT NULL DEFAULT 'FLOW2_ADMIN_VERIFIED_OCR'
        CHECK (purpose = 'FLOW2_ADMIN_VERIFIED_OCR'),
    status TEXT NOT NULL DEFAULT 'OPTED_OUT'
        CHECK (status IN ('OPTED_IN', 'OPTED_OUT', 'REVOKED')),
    consent_version INTEGER NOT NULL DEFAULT 1 CHECK (consent_version >= 1),
    notice_version VARCHAR(64) NOT NULL,
    rights_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    consented_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoke_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_parent_ocr_consent_opted_in_requires_rights
        CHECK (status <> 'OPTED_IN' OR (rights_confirmed IS TRUE AND consented_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_parent_ocr_consent_owner_status
    ON public.parent_book_ocr_contribution_consents (owner_parent_id, status, updated_at DESC);

CREATE OR REPLACE FUNCTION public.validate_parent_ocr_consent_book()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_scope TEXT;
    v_owner UUID;
BEGIN
    SELECT b.visibility_scope, b.owner_parent_id
      INTO v_scope, v_owner
    FROM public.books b
    WHERE b.id = NEW.book_id;

    IF v_scope IS DISTINCT FROM 'PARENT_PRIVATE' THEN
        RAISE EXCEPTION 'OCR contribution consent is only valid for PARENT_PRIVATE books';
    END IF;
    IF v_owner IS DISTINCT FROM NEW.owner_parent_id THEN
        RAISE EXCEPTION 'OCR contribution consent owner_parent_id must match book owner_parent_id';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_parent_ocr_consent_book() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_validate_parent_ocr_consent_book ON public.parent_book_ocr_contribution_consents;
CREATE TRIGGER trg_validate_parent_ocr_consent_book
    BEFORE INSERT OR UPDATE ON public.parent_book_ocr_contribution_consents
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_parent_ocr_consent_book();

-- ---------------------------------------------------------------------------
-- 2. Immutable consent audit ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.parent_book_ocr_contribution_consent_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
    owner_parent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    actor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (action IN ('OPT_IN', 'OPT_OUT', 'REVOKE_BOOK_DELETED', 'REVOKE_BOOK_SUSPENDED')),
    consent_version INTEGER NOT NULL CHECK (consent_version >= 1),
    purpose TEXT NOT NULL DEFAULT 'FLOW2_ADMIN_VERIFIED_OCR'
        CHECK (purpose = 'FLOW2_ADMIN_VERIFIED_OCR'),
    notice_version VARCHAR(64) NOT NULL,
    rights_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_parent_ocr_consent_events_book_created
    ON public.parent_book_ocr_contribution_consent_events (book_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Line-level Flow 2 candidate recruitment & Admin verification queue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.parent_book_flow2_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
    owner_parent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    page_id UUID NOT NULL REFERENCES public.bookpages(id) ON DELETE CASCADE,
    revision_id UUID NOT NULL REFERENCES public.pagerevisions(id) ON DELETE CASCADE,
    submission_id UUID REFERENCES public.parent_book_page_submissions(id) ON DELETE SET NULL,
    consent_version INTEGER NOT NULL CHECK (consent_version >= 1),
    line_index INTEGER NOT NULL CHECK (line_index >= 0),
    idempotency_key VARCHAR(256) NOT NULL UNIQUE,
    source_image_path TEXT NOT NULL,
    source_content_hash VARCHAR(64) NOT NULL,
    crop_box_json JSONB NOT NULL,
    image_sha256 VARCHAR(64) NOT NULL CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
    proposed_label TEXT NOT NULL CHECK (length(proposed_label) BETWEEN 1 AND 300),
    verified_label TEXT CHECK (verified_label IS NULL OR length(verified_label) BETWEEN 1 AND 300),
    verified_label_sha256 VARCHAR(64) CHECK (verified_label_sha256 IS NULL OR verified_label_sha256 ~ '^[0-9a-f]{64}$'),
    rights_basis VARCHAR(40) NOT NULL
        CHECK (rights_basis IN ('SELF_AUTHORED', 'PUBLIC_DOMAIN', 'LICENSED_OR_PERMISSION')),
    pii_check_status VARCHAR(32) NOT NULL DEFAULT 'CLEAR'
        CHECK (pii_check_status IN ('CLEAR', 'FLAGGED_PII')),
    pii_flags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    quality_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING_VERIFICATION'
        CHECK (status IN ('PENDING_VERIFICATION', 'VERIFIED', 'SYNC_QUEUED', 'SYNCED', 'REJECTED', 'REVOKED')),
    verified_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    rejection_code VARCHAR(64),
    rejection_reason TEXT,
    outbox_event_id UUID REFERENCES public.viread_ocr_outbox(id) ON DELETE SET NULL,
    sample_id UUID,
    revoked_at TIMESTAMPTZ,
    revoke_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_parent_flow2_candidate_verified_requires_admin
        CHECK (
            status NOT IN ('VERIFIED', 'SYNC_QUEUED', 'SYNCED')
            OR (
                verified_by IS NOT NULL
                AND verified_at IS NOT NULL
                AND verified_label IS NOT NULL
                AND verified_label_sha256 IS NOT NULL
                AND pii_check_status = 'CLEAR'
            )
        )
);

CREATE INDEX IF NOT EXISTS ix_parent_flow2_candidates_status_created
    ON public.parent_book_flow2_candidates (status, created_at ASC);

CREATE INDEX IF NOT EXISTS ix_parent_flow2_candidates_book_status
    ON public.parent_book_flow2_candidates (book_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_parent_flow2_candidates_page_status
    ON public.parent_book_flow2_candidates (page_id, status);

CREATE INDEX IF NOT EXISTS ix_parent_flow2_candidates_rev_line
    ON public.parent_book_flow2_candidates (revision_id, line_index);

CREATE INDEX IF NOT EXISTS ix_parent_flow2_candidates_image_sha
    ON public.parent_book_flow2_candidates (image_sha256);

-- ---------------------------------------------------------------------------
-- 4. Extend viread_ocr_outbox to support PARENT_CONTRIBUTION_CANDIDATE safely
-- ---------------------------------------------------------------------------
ALTER TABLE public.viread_ocr_outbox
    ADD COLUMN IF NOT EXISTS candidate_id UUID REFERENCES public.parent_book_flow2_candidates(id) ON DELETE CASCADE;

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
      AND pg_get_constraintdef(c.oid) LIKE '%event_type%';

    IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.viread_ocr_outbox DROP CONSTRAINT %I', con_name);
    END IF;
END $$;

ALTER TABLE public.viread_ocr_outbox
    ADD CONSTRAINT viread_ocr_outbox_event_type_check
    CHECK (event_type IN ('VERIFIED_REVISION', 'PARENT_CONTRIBUTION_CANDIDATE'));

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
      AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) LIKE '%event_type%revision_id%';

    IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.viread_ocr_outbox DROP CONSTRAINT %I', con_name);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_viread_ocr_outbox_verified_revision
    ON public.viread_ocr_outbox (event_type, revision_id)
    WHERE event_type = 'VERIFIED_REVISION';

CREATE UNIQUE INDEX IF NOT EXISTS uq_viread_ocr_outbox_parent_candidate
    ON public.viread_ocr_outbox (event_type, candidate_id)
    WHERE event_type = 'PARENT_CONTRIBUTION_CANDIDATE' AND candidate_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Row-Level Security & Server-Only Privileges
-- ---------------------------------------------------------------------------
ALTER TABLE public.parent_book_ocr_contribution_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_book_ocr_contribution_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_book_flow2_candidates ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
    public.parent_book_ocr_contribution_consents,
    public.parent_book_ocr_contribution_consent_events,
    public.parent_book_flow2_candidates
FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT ALL PRIVILEGES ON TABLE public.parent_book_ocr_contribution_consents TO service_role';
        EXECUTE 'GRANT ALL PRIVILEGES ON TABLE public.parent_book_ocr_contribution_consent_events TO service_role';
        EXECUTE 'GRANT ALL PRIVILEGES ON TABLE public.parent_book_flow2_candidates TO service_role';

        EXECUTE 'DROP POLICY IF EXISTS parent_ocr_consents_server_only ON public.parent_book_ocr_contribution_consents';
        EXECUTE 'CREATE POLICY parent_ocr_consents_server_only ON public.parent_book_ocr_contribution_consents FOR ALL TO service_role USING (true) WITH CHECK (true)';

        EXECUTE 'DROP POLICY IF EXISTS parent_ocr_consent_events_server_only ON public.parent_book_ocr_contribution_consent_events';
        EXECUTE 'CREATE POLICY parent_ocr_consent_events_server_only ON public.parent_book_ocr_contribution_consent_events FOR ALL TO service_role USING (true) WITH CHECK (true)';

        EXECUTE 'DROP POLICY IF EXISTS parent_flow2_candidates_server_only ON public.parent_book_flow2_candidates';
        EXECUTE 'CREATE POLICY parent_flow2_candidates_server_only ON public.parent_book_flow2_candidates FOR ALL TO service_role USING (true) WITH CHECK (true)';
    END IF;
END $$;

COMMIT;
