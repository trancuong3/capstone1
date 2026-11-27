-- Post-Audit Security Hardening:
-- 1. Revoke redundant anon/authenticated table-level grants on server-only public tables
--    (frontend Supabase client queries only public.profiles).
-- 2. Restrict public.book_presentation_assets to SELECT only for authenticated clients
--    (governed by viread_internal.can_read_book_presentation_asset).
-- 3. Require profiles.active = 1 on profiles_update_own and parentemailpreferences_parent_owns.
-- 4. Set size & MIME constraints on private bucket 'readalong-book-pages'.
-- 5. Validate bookpages_imagepath_object_key_chk when present and not yet validated.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $revoke_server_only_tables$
DECLARE
  tbl_name TEXT;
  has_anon BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
  has_authenticated BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
  has_service_role BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  FOREACH tbl_name IN ARRAY ARRAY[
    'books',
    'bookpages',
    'pagerevisions',
    'pagerevisionwords',
    'auditlogs',
    'bookdeletionjobs',
    'bookcontentreports',
    'bookcontentreporthistory',
    'bookqualityfindings',
    'bookqualitypagescans',
    'bookqualityreportfindings',
    'bookqualityscanruns',
    'childprofiles',
    'childbookcollections',
    'comprehensionanswers',
    'comprehensionquestions',
    'consentrecords',
    'fluencyassessments',
    'progressreports',
    'readingcomparisonreports',
    'readingevents',
    'readingreminderemaildeliveries',
    'readingsessions',
    'gamesessions',
    'gamerounds',
    'gameattempts',
    'picturedescriptionsessions',
    'picturedescriptionattempts',
    'difficult_word_practice_attempts',
    'book_style_bibles',
    'page_ocr_extractions',
    'smart_studio_jobs',
    'parentemaildeliveries',
    'parentemailpreferences'
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

  IF to_regclass('public.book_presentation_assets') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
      ON TABLE public.book_presentation_assets FROM PUBLIC;
    IF has_anon THEN
      REVOKE ALL PRIVILEGES ON TABLE public.book_presentation_assets FROM anon;
    END IF;
    IF has_authenticated THEN
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
        ON TABLE public.book_presentation_assets FROM authenticated;
      GRANT SELECT ON TABLE public.book_presentation_assets TO authenticated;
    END IF;
    IF has_service_role THEN
      GRANT ALL PRIVILEGES ON TABLE public.book_presentation_assets TO service_role;
    END IF;
  END IF;
END;
$revoke_server_only_tables$;

DO $require_active_profiles_rls$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL
     AND to_regprocedure('auth.uid()') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
  THEN
    DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
    CREATE POLICY profiles_update_own
      ON public.profiles
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT auth.uid()) IS NOT NULL
        AND (SELECT auth.uid()) = id
        AND active = 1
      )
      WITH CHECK (
        (SELECT auth.uid()) IS NOT NULL
        AND (SELECT auth.uid()) = id
        AND active = 1
      );
  END IF;

  IF to_regclass('public.parentemailpreferences') IS NOT NULL
     AND to_regclass('public.profiles') IS NOT NULL
     AND to_regprocedure('auth.uid()') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
  THEN
    DROP POLICY IF EXISTS parentemailpreferences_parent_owns ON public.parentemailpreferences;
    CREATE POLICY parentemailpreferences_parent_owns
      ON public.parentemailpreferences
      FOR ALL
      TO authenticated
      USING (
        parentid = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.active = 1
        )
      )
      WITH CHECK (
        parentid = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.active = 1
        )
      );
  END IF;
END;
$require_active_profiles_rls$;

DO $harden_book_pages_bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    UPDATE storage.buckets
    SET
      file_size_limit = COALESCE(file_size_limit, 15728640),
      allowed_mime_types = COALESCE(
        allowed_mime_types,
        ARRAY[
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/tiff',
          'image/bmp',
          'application/pdf'
        ]::text[]
      )
    WHERE id = 'readalong-book-pages';
  END IF;
END;
$harden_book_pages_bucket$;

DO $validate_bookpages_imagepath_chk$
BEGIN
  IF to_regclass('public.bookpages') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conrelid = 'public.bookpages'::regclass
         AND conname = 'bookpages_imagepath_object_key_chk'
         AND NOT convalidated
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.bookpages
       WHERE imagepath IS NOT NULL
         AND (imagepath ~* '^https?://' OR position('..' in imagepath) > 0)
     )
  THEN
    ALTER TABLE public.bookpages
      VALIDATE CONSTRAINT bookpages_imagepath_object_key_chk;
  END IF;
END;
$validate_bookpages_imagepath_chk$;

COMMIT;
