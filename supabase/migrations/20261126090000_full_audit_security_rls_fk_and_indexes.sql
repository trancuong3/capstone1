-- Full Audit Security Hardening: RLS tightening, Smart Studio V2 FK & lease indexes,
-- Flow 2 parent-deletion FK cascades, server-owned table REVOKE ALL, and avatar bucket
-- restrictive browser-denial policy.
-- Strictly additive, idempotent, and safe on both full production/staging databases
-- and minimal CI databases.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1. Tighten book_presentation_assets_owner_or_catalog_reads RLS policy via a
--    non-PostgREST internal SECURITY DEFINER predicate (locked search_path='')
--    so RLS evaluation accurately checks server-owned books/adminaiworkflows/
--    auditlogs without granting authenticated clients direct table reads or
--    allowing NOT EXISTS(auditlogs) to fail open under strict RLS:
--    - Private book owners may read ONLY when their book is ACTIVE, not SUSPENDED,
--      and not soft-deleted.
--    - Catalog reads require active + APPROVED assets, text_free_verified = true
--      for PAGE_ILLUSTRATION, and book eligibility consistent with CatalogRepository
--      (ACTIVE, not SUSPENDED, not soft-deleted, at least one ACTIVE/PROCESSING page,
--      every ACTIVE/PROCESSING page ACTIVE + VERIFIED + Admin AI safety approved,
--      and latest book.children.* decision not book.children.rejected).
-- ---------------------------------------------------------------------------
DO $tighten_presentation_assets_rls$
BEGIN
  IF to_regclass('public.book_presentation_assets') IS NOT NULL
     AND to_regclass('public.books') IS NOT NULL
     AND to_regclass('public.bookpages') IS NOT NULL
     AND to_regclass('public.pagerevisions') IS NOT NULL
     AND to_regclass('public.adminaiworkflows') IS NOT NULL
     AND to_regclass('public.auditlogs') IS NOT NULL
     AND to_regprocedure('auth.uid()') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
  THEN
    CREATE SCHEMA IF NOT EXISTS viread_internal;
    REVOKE ALL ON SCHEMA viread_internal FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON SCHEMA viread_internal FROM anon;
    END IF;
    GRANT USAGE ON SCHEMA viread_internal TO authenticated;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      GRANT USAGE ON SCHEMA viread_internal TO service_role;
    END IF;

    CREATE OR REPLACE FUNCTION viread_internal.can_read_book_presentation_asset(
      p_book_id uuid,
      p_owner_id uuid,
      p_asset_role text,
      p_is_active boolean,
      p_text_free_verified boolean,
      p_moderation_status text
    )
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = ''
    AS $fn$
      SELECT
        (
          p_owner_id IS NOT NULL
          AND p_owner_id = (SELECT auth.uid())
          AND EXISTS (
            SELECT 1
            FROM public.books b
            WHERE b.id = p_book_id
              AND b.visibility_scope = 'PARENT_PRIVATE'
              AND b.owner_parent_id = (SELECT auth.uid())
              AND b.lifecyclestatus = 'ACTIVE'
              AND b.moderation_status <> 'SUSPENDED'
              AND coalesce(b.is_deleted, false) = false
          )
        )
        OR (
          p_owner_id IS NULL
          AND p_is_active IS TRUE
          AND p_moderation_status = 'APPROVED'
          AND (p_asset_role <> 'PAGE_ILLUSTRATION' OR p_text_free_verified IS TRUE)
          AND EXISTS (
            SELECT 1
            FROM public.books b
            WHERE b.id = p_book_id
              AND b.visibility_scope = 'CATALOG'
              AND b.lifecyclestatus = 'ACTIVE'
              AND b.moderation_status <> 'SUSPENDED'
              AND coalesce(b.is_deleted, false) = false
              AND EXISTS (
                SELECT 1
                FROM public.bookpages bp
                WHERE bp.bookid = b.id
                  AND bp.lifecyclestatus IN ('ACTIVE', 'PROCESSING')
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.bookpages bp
                WHERE bp.bookid = b.id
                  AND bp.lifecyclestatus IN ('ACTIVE', 'PROCESSING')
                  AND (
                    bp.lifecyclestatus <> 'ACTIVE'
                    OR NOT EXISTS (
                      SELECT 1
                      FROM public.pagerevisions pr
                      WHERE pr.id = bp.currentverifiedrevisionid
                        AND pr.pageid = bp.id
                        AND pr.verificationstatus = 'VERIFIED'
                    )
                    OR NOT EXISTS (
                      SELECT 1
                      FROM public.adminaiworkflows aw
                      JOIN public.pagerevisions pr
                        ON pr.id = bp.currentverifiedrevisionid
                      WHERE pr.pageid = bp.id
                        AND aw.pageid = bp.id
                        AND aw.pagerevisionid = bp.currentverifiedrevisionid
                        AND aw.status = 'READY_FOR_ADMIN_REVIEW'
                        AND aw.safetyconfirmedat IS NOT NULL
                        AND aw.safetyinputhash = aw.candidatehash
                        AND aw.finalapprovedtexthash = aw.candidatehash
                        AND aw.ocrapprovedat IS NOT NULL
                        AND aw.ocrapprovedby IS NOT NULL
                        AND aw.findings = '[]'::jsonb
                        AND (
                          aw.imagesafetystatus IS NULL
                          OR aw.imagesafetystatus <> 'ADMIN_FLAGGED_UNSAFE'
                        )
                        AND (
                          (
                            aw.safetystatus = 'CONFIRMED'
                            AND aw.safetyconfirmedby IS NOT NULL
                            AND aw.suitability IN ('SUITABLE', 'SUITABLE_WITH_GUIDANCE')
                          )
                          OR (
                            aw.safetystatus = 'AUTO_CONFIRMED'
                            AND aw.safetyconfirmedby IS NULL
                            AND aw.suitability = 'SUITABLE'
                          )
                        )
                        AND (pr.processingmeta -> 'admin_ai_workflow' ->> 'workflow_id') = aw.id::text
                        AND (pr.processingmeta -> 'admin_ai_workflow' ->> 'candidate_hash') = aw.candidatehash
                        AND (pr.processingmeta -> 'admin_ai_workflow' ->> 'safety_input_hash') = aw.candidatehash
                    )
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.auditlogs al
                WHERE al.id = (
                  SELECT al2.id
                  FROM public.auditlogs al2
                  WHERE al2.resourcetype = 'book'
                    AND al2.resourceid = b.id
                    AND al2.action LIKE 'book.children.%'
                  ORDER BY al2.createdat DESC, al2.id DESC
                  LIMIT 1
                )
                AND al.action = 'book.children.rejected'
              )
          )
        );
    $fn$;

    REVOKE ALL ON FUNCTION viread_internal.can_read_book_presentation_asset(
      uuid, uuid, text, boolean, boolean, text
    ) FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON FUNCTION viread_internal.can_read_book_presentation_asset(
        uuid, uuid, text, boolean, boolean, text
      ) FROM anon;
    END IF;
    GRANT EXECUTE ON FUNCTION viread_internal.can_read_book_presentation_asset(
      uuid, uuid, text, boolean, boolean, text
    ) TO authenticated;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      GRANT EXECUTE ON FUNCTION viread_internal.can_read_book_presentation_asset(
        uuid, uuid, text, boolean, boolean, text
      ) TO service_role;
    END IF;

    DROP POLICY IF EXISTS book_presentation_assets_owner_or_catalog_reads
      ON public.book_presentation_assets;

    CREATE POLICY book_presentation_assets_owner_or_catalog_reads
      ON public.book_presentation_assets
      FOR SELECT
      TO authenticated
      USING (
        viread_internal.can_read_book_presentation_asset(
          book_id,
          owner_id,
          asset_role,
          is_active,
          text_free_verified,
          moderation_status
        )
      );
  END IF;
END;
$tighten_presentation_assets_rls$;

-- ---------------------------------------------------------------------------
-- 2. Missing Smart Book Studio V2 FK & lease indexes.
-- ---------------------------------------------------------------------------
DO $smart_studio_indexes$
BEGIN
  IF to_regclass('public.smart_studio_jobs') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS ix_smart_studio_jobs_book_id
      ON public.smart_studio_jobs (book_id);
    CREATE INDEX IF NOT EXISTS ix_smart_studio_jobs_book_page_id
      ON public.smart_studio_jobs (book_page_id);
    CREATE INDEX IF NOT EXISTS ix_smart_studio_jobs_source_revision_id
      ON public.smart_studio_jobs (source_revision_id);

    DROP INDEX IF EXISTS public.ix_smart_studio_jobs_lease;
    CREATE INDEX IF NOT EXISTS ix_smart_studio_jobs_lease
      ON public.smart_studio_jobs (status, lease_expires_at)
      WHERE status IN ('RUNNING', 'CANCEL_REQUESTED');
  END IF;

  IF to_regclass('public.book_style_bibles') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS ix_book_style_bibles_owner_id
      ON public.book_style_bibles (owner_id);
  END IF;

  IF to_regclass('public.page_ocr_extractions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS ix_page_ocr_extractions_owner_id
      ON public.page_ocr_extractions (owner_id);
    CREATE INDEX IF NOT EXISTS ix_page_ocr_extractions_page_revision_id
      ON public.page_ocr_extractions (page_revision_id);
  END IF;

  IF to_regclass('public.book_presentation_assets') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS ix_book_presentation_assets_source_revision_id
      ON public.book_presentation_assets (source_revision_id);
    CREATE INDEX IF NOT EXISTS ix_book_presentation_assets_job_id
      ON public.book_presentation_assets (job_id);
  END IF;
END;
$smart_studio_indexes$;

-- ---------------------------------------------------------------------------
-- 3. Fix Flow 2 profiles(id) ON DELETE RESTRICT foreign keys so parent/actor
--    account deletion never fails on 23503 foreign_key_violation.
--    - owner_parent_id columns -> ON DELETE CASCADE
--    - parent_book_ocr_contribution_consent_events.actor_id -> nullable + ON DELETE SET NULL
-- ---------------------------------------------------------------------------
DO $fix_flow2_profile_fks$
DECLARE
  target RECORD;
  con_rec RECORD;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RETURN;
  END IF;

  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('parent_book_ocr_contribution_consents', 'owner_parent_id', 'parent_book_ocr_contribution_consents_owner_parent_id_fkey', 'CASCADE', false),
        ('parent_book_ocr_contribution_consent_events', 'owner_parent_id', 'parent_book_ocr_contribution_consent_events_owner_parent_id_fk', 'CASCADE', false),
        ('parent_book_ocr_contribution_consent_events', 'actor_id', 'parent_book_ocr_contribution_consent_events_actor_id_fkey', 'SET NULL', true),
        ('parent_book_flow2_candidates', 'owner_parent_id', 'parent_book_flow2_candidates_owner_parent_id_fkey', 'CASCADE', false)
    ) AS t(tbl_name, col_name, con_name, delete_action, drop_not_null)
  LOOP
    IF to_regclass('public.' || target.tbl_name) IS NULL THEN
      CONTINUE;
    END IF;

    IF target.drop_not_null THEN
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL',
        target.tbl_name,
        target.col_name
      );
    END IF;

    -- Drop any existing FK constraint(s) on (tbl_name, col_name) referencing public.profiles.
    FOR con_rec IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class tbl ON tbl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = c.conkey[1]
      WHERE ns.nspname = 'public'
        AND tbl.relname = target.tbl_name
        AND c.contype = 'f'
        AND array_length(c.conkey, 1) = 1
        AND att.attname = target.col_name
        AND c.confrelid = 'public.profiles'::regclass
    LOOP
      EXECUTE format(
        'ALTER TABLE public.%I DROP CONSTRAINT %I',
        target.tbl_name,
        con_rec.conname
      );
    END LOOP;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.profiles(id) ON DELETE %s',
      target.tbl_name,
      target.con_name,
      target.col_name,
      target.delete_action
    );
  END LOOP;
END;
$fix_flow2_profile_fks$;

-- ---------------------------------------------------------------------------
-- 4. Revoke direct PostgREST privileges on server-owned reading management,
--    session-page, and presence tables from PUBLIC, anon, and authenticated
--    while preserving full service_role access.
-- ---------------------------------------------------------------------------
DO $revoke_server_owned_reading_tables$
DECLARE
  tbl_name TEXT;
  has_anon BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
  has_authenticated BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
  has_service_role BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  FOREACH tbl_name IN ARRAY ARRAY[
    'readingreminderoccurrences',
    'readinggoals',
    'readingplans',
    'readingreminders',
    'readingsessionpages',
    'readingpresencesettings',
    'readingpresencealerts'
  ]
  LOOP
    IF to_regclass('public.' || tbl_name) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC', tbl_name);
    IF has_anon THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon', tbl_name);
    END IF;
    IF has_authenticated THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM authenticated', tbl_name);
    END IF;
    IF has_service_role THEN
      EXECUTE format('GRANT ALL PRIVILEGES ON TABLE public.%I TO service_role', tbl_name);
    END IF;
  END LOOP;
END;
$revoke_server_owned_reading_tables$;

-- ---------------------------------------------------------------------------
-- 5. Add idempotent AS RESTRICTIVE browser-denial policy on storage.objects
--    for the private 'viread-avatars' bucket (defense-in-depth alongside
--    viread_avatars_service_role_only).
-- ---------------------------------------------------------------------------
DO $harden_avatar_storage_rls$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      DROP POLICY IF EXISTS viread_avatars_service_role_only ON storage.objects;
      CREATE POLICY viread_avatars_service_role_only
        ON storage.objects
        FOR ALL
        TO service_role
        USING (bucket_id = 'viread-avatars')
        WITH CHECK (bucket_id = 'viread-avatars');
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
    THEN
      DROP POLICY IF EXISTS viread_avatars_deny_browser_clients ON storage.objects;
      CREATE POLICY viread_avatars_deny_browser_clients
        ON storage.objects
        AS RESTRICTIVE
        FOR ALL
        TO anon, authenticated
        USING (bucket_id <> 'viread-avatars')
        WITH CHECK (bucket_id <> 'viread-avatars');
    END IF;
  END IF;
END;
$harden_avatar_storage_rls$;

COMMIT;
