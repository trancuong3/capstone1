-- ============================================================================
-- Audit Wave 3: Storage key guardrails, parent deletion cascades, reading event
-- millisecond range widening, and hot-path indexes.
-- ============================================================================

-- 1. Prevent authenticated clients from overwriting profiles.avatar_path directly
--    via PostgREST (avatars are managed exclusively through the backend upload API).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'avatar_path'
     )
  THEN
    EXECUTE 'REVOKE UPDATE (avatar_path) ON TABLE public.profiles FROM authenticated';
  END IF;
END $$;

-- 2. Enforce object-key-only storage paths (reject signed/external URLs and .. traversal)
--    using NOT VALID so all new INSERT/UPDATE rows are strictly checked without
--    blocking deployment if historical seed rows exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'avatar_path'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_avatar_path_object_key_chk'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_avatar_path_object_key_chk
      CHECK (
        avatar_path IS NULL
        OR (avatar_path !~* '^https?://' AND position('..' in avatar_path) = 0)
      ) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'childprofiles' AND column_name = 'avatar_path'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'childprofiles_avatar_path_object_key_chk'
  ) THEN
    ALTER TABLE public.childprofiles
      ADD CONSTRAINT childprofiles_avatar_path_object_key_chk
      CHECK (
        avatar_path IS NULL
        OR (avatar_path !~* '^https?://' AND position('..' in avatar_path) = 0)
      ) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bookpages' AND column_name = 'imagepath'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookpages_imagepath_object_key_chk'
  ) THEN
    ALTER TABLE public.bookpages
      ADD CONSTRAINT bookpages_imagepath_object_key_chk
      CHECK (
        imagepath IS NULL
        OR (imagepath !~* '^https?://' AND position('..' in imagepath) = 0)
      ) NOT VALID;
  END IF;
END $$;

-- 3. Allow parent account deletion to cascade private-book ownership rows cleanly
--    instead of failing on ON DELETE RESTRICT.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'books' AND column_name = 'owner_parent_id'
  ) THEN
    ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_owner_parent_id_fkey;
    ALTER TABLE public.books
      ADD CONSTRAINT books_owner_parent_id_fkey
      FOREIGN KEY (owner_parent_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'parent_book_page_submissions'
  ) THEN
    ALTER TABLE public.parent_book_page_submissions
      DROP CONSTRAINT IF EXISTS parent_book_page_submissions_owner_parent_id_fkey;
    ALTER TABLE public.parent_book_page_submissions
      ADD CONSTRAINT parent_book_page_submissions_owner_parent_id_fkey
      FOREIGN KEY (owner_parent_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'parent_book_moderation_requests'
  ) THEN
    ALTER TABLE public.parent_book_moderation_requests
      DROP CONSTRAINT IF EXISTS parent_book_moderation_requests_owner_parent_id_fkey;
    ALTER TABLE public.parent_book_moderation_requests
      ADD CONSTRAINT parent_book_moderation_requests_owner_parent_id_fkey
      FOREIGN KEY (owner_parent_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'viread_ocr_model_decisions' AND column_name = 'actor_id'
  ) THEN
    ALTER TABLE public.viread_ocr_model_decisions ALTER COLUMN actor_id DROP NOT NULL;
    ALTER TABLE public.viread_ocr_model_decisions
      DROP CONSTRAINT IF EXISTS viread_ocr_model_decisions_actor_id_fkey;
    ALTER TABLE public.viread_ocr_model_decisions
      ADD CONSTRAINT viread_ocr_model_decisions_actor_id_fkey
      FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Widen readingevents.startms / endms from SMALLINT (32.7s ceiling) to INTEGER.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'readingevents'
      AND column_name = 'startms' AND data_type = 'smallint'
  ) THEN
    ALTER TABLE public.readingevents
      ALTER COLUMN startms TYPE integer,
      ALTER COLUMN endms TYPE integer;
  END IF;
END $$;

-- 5. Add composite indexes for hot book-decision audit queries and page-revision workflows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'auditlogs'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_auditlogs_book_decisions
      ON public.auditlogs (resourcetype, resourceid, createdat DESC, id DESC);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'adminaiworkflows'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_adminaiworkflows_pagerevisionid
      ON public.adminaiworkflows (pagerevisionid);
  END IF;
END $$;
