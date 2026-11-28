-- =============================================================================
-- Feature #2: Co-Reading Role-Play, Turn-Taking & Parent Storyteller Voice
-- Migration: public.parent_page_narrations + public.family_reading_postcards
-- Strictly PARENT_PRIVATE (household-scoped, zero public URLs or external links)
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1. Table: public.parent_page_narrations
-- Mom/Dad storyteller voice recordings per private book page (PARENT_PRIVATE).
-- Unique per (book_id, page_id); CASCADE-deleted when book, page, or parent is deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.parent_page_narrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES public.bookpages(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  audio_format varchar(8) NOT NULL,
  file_size_bytes integer NOT NULL,
  duration_ms integer NOT NULL,
  word_timings jsonb NOT NULL DEFAULT '[]'::jsonb,
  visibility varchar(24) NOT NULL DEFAULT 'PARENT_PRIVATE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_parent_page_narrations_audio_format CHECK (
    audio_format IN ('webm', 'ogg', 'wav', 'mp3', 'm4a', 'aac')
  ),
  CONSTRAINT ck_parent_page_narrations_file_size CHECK (
    file_size_bytes > 0 AND file_size_bytes <= 2097152
  ),
  CONSTRAINT ck_parent_page_narrations_duration CHECK (
    duration_ms > 0
  ),
  CONSTRAINT ck_parent_page_narrations_visibility CHECK (
    visibility = 'PARENT_PRIVATE'
  ),
  CONSTRAINT ck_parent_page_narrations_storage_path_relative CHECK (
    char_length(btrim(storage_path)) > 0
    AND position('://' in storage_path) = 0
  ),
  CONSTRAINT uq_parent_page_narrations_book_page UNIQUE (book_id, page_id)
);

CREATE INDEX IF NOT EXISTS ix_parent_page_narrations_parent_id
  ON public.parent_page_narrations (parent_id);
CREATE INDEX IF NOT EXISTS ix_parent_page_narrations_book_id
  ON public.parent_page_narrations (book_id);

-- ---------------------------------------------------------------------------
-- 2. Table: public.family_reading_postcards
-- Internal PARENT_PRIVATE keepsakes celebrating a child's best passage.
-- CASCADE-deleted when parent or child profile is deleted. Never shared publicly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.family_reading_postcards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  child_id uuid NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  title varchar(240) NOT NULL,
  passage_text text NOT NULL,
  source_book_id uuid REFERENCES public.books(id) ON DELETE SET NULL,
  source_page_id uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  audio_clip_path text NULL,
  audio_format varchar(8) NULL,
  audio_size_bytes integer NULL,
  emoji_badge varchar(16) NOT NULL DEFAULT '🌟',
  visibility varchar(24) NOT NULL DEFAULT 'PARENT_PRIVATE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_family_reading_postcards_audio_format CHECK (
    audio_format IS NULL OR audio_format IN ('webm', 'ogg', 'wav', 'mp3', 'm4a', 'aac')
  ),
  CONSTRAINT ck_family_reading_postcards_audio_size CHECK (
    audio_size_bytes IS NULL OR (audio_size_bytes > 0 AND audio_size_bytes <= 262144)
  ),
  CONSTRAINT ck_family_reading_postcards_visibility CHECK (
    visibility = 'PARENT_PRIVATE'
  ),
  CONSTRAINT ck_family_reading_postcards_nonempty CHECK (
    char_length(btrim(title)) > 0
    AND char_length(btrim(passage_text)) > 0
  ),
  CONSTRAINT ck_family_reading_postcards_clip_path_relative CHECK (
    audio_clip_path IS NULL
    OR (char_length(btrim(audio_clip_path)) > 0 AND position('://' in audio_clip_path) = 0)
  )
);

CREATE INDEX IF NOT EXISTS ix_family_reading_postcards_parent_id
  ON public.family_reading_postcards (parent_id);
CREATE INDEX IF NOT EXISTS ix_family_reading_postcards_child_id
  ON public.family_reading_postcards (child_id);
CREATE INDEX IF NOT EXISTS ix_family_reading_postcards_child_created
  ON public.family_reading_postcards (child_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Strict RLS + Privilege Hardening (PARENT_PRIVATE)
-- ---------------------------------------------------------------------------
ALTER TABLE public.parent_page_narrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_reading_postcards ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.parent_page_narrations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.family_reading_postcards FROM PUBLIC;

DO $feat2_co_reading_rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.parent_page_narrations FROM anon;
    REVOKE ALL PRIVILEGES ON TABLE public.family_reading_postcards FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.parent_page_narrations FROM authenticated;
    REVOKE ALL PRIVILEGES ON TABLE public.family_reading_postcards FROM authenticated;

    IF to_regprocedure('auth.uid()') IS NOT NULL THEN
      DROP POLICY IF EXISTS parent_page_narrations_parent_owns ON public.parent_page_narrations;
      CREATE POLICY parent_page_narrations_parent_owns
        ON public.parent_page_narrations
        FOR ALL
        TO authenticated
        USING (
          parent_id = (SELECT auth.uid())
          AND visibility = 'PARENT_PRIVATE'
          AND EXISTS (
            SELECT 1
            FROM public.books b
            JOIN public.profiles p ON p.id = b.owner_parent_id
            WHERE b.id = parent_page_narrations.book_id
              AND b.owner_parent_id = (SELECT auth.uid())
              AND b.visibility_scope = 'PARENT_PRIVATE'
              AND b.is_deleted = false
              AND p.active = 1
          )
        )
        WITH CHECK (
          parent_id = (SELECT auth.uid())
          AND visibility = 'PARENT_PRIVATE'
        );

      DROP POLICY IF EXISTS family_reading_postcards_parent_owns ON public.family_reading_postcards;
      CREATE POLICY family_reading_postcards_parent_owns
        ON public.family_reading_postcards
        FOR ALL
        TO authenticated
        USING (
          parent_id = (SELECT auth.uid())
          AND visibility = 'PARENT_PRIVATE'
          AND EXISTS (
            SELECT 1
            FROM public.childprofiles cp
            JOIN public.profiles p ON p.id = cp.parentid
            WHERE cp.id = family_reading_postcards.child_id
              AND cp.parentid = (SELECT auth.uid())
              AND p.active = 1
          )
        )
        WITH CHECK (
          parent_id = (SELECT auth.uid())
          AND visibility = 'PARENT_PRIVATE'
        );
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.parent_page_narrations TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.family_reading_postcards TO service_role;
  END IF;
END
$feat2_co_reading_rls$;

COMMIT;
