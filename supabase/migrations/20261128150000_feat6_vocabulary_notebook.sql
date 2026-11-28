-- Feature #6: Contextual Kids Glossary ("Chạm Từ Hỏi Nghĩa") & Vocabulary Notebook ("Sổ Từ Hay")
-- Strictly additive migration:
-- 1. public.word_glossary_cache: grade-banded (GRADE_1_2 / GRADE_3_5) child-safe Vietnamese word explanations.
--    Never stores parent_id, child_id, or private book text.
-- 2. public.child_favorite_words: strictly PARENT_PRIVATE per-child saved vocabulary notebook with
--    unique (child_profile_id, normalized_word), FK cascade on child/profile delete, and strict RLS.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.word_glossary_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_word varchar(120) NOT NULL,
  display_word varchar(120) NOT NULL,
  grade_band varchar(16) NOT NULL,
  part_of_speech_vi varchar(48),
  definition_vi text NOT NULL,
  example_sentence_vi text NOT NULL,
  nuance_note_vi text,
  source_provider varchar(64) NOT NULL DEFAULT 'FALLBACK',
  safety_suitability varchar(32) NOT NULL DEFAULT 'SUITABLE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_word_glossary_cache_grade_band CHECK (
    grade_band IN ('GRADE_1_2', 'GRADE_3_5')
  ),
  CONSTRAINT ck_word_glossary_cache_safety CHECK (
    safety_suitability IN ('SUITABLE', 'SUITABLE_WITH_GUIDANCE')
  ),
  CONSTRAINT ck_word_glossary_cache_nonempty CHECK (
    char_length(btrim(normalized_word)) > 0
    AND char_length(btrim(definition_vi)) > 0
    AND char_length(btrim(example_sentence_vi)) > 0
  ),
  CONSTRAINT uq_word_glossary_cache_word_band UNIQUE (normalized_word, grade_band)
);

CREATE INDEX IF NOT EXISTS ix_word_glossary_cache_lookup
  ON public.word_glossary_cache (normalized_word, grade_band);

CREATE TABLE IF NOT EXISTS public.child_favorite_words (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_profile_id uuid NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  parent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  word varchar(120) NOT NULL,
  normalized_word varchar(120) NOT NULL,
  grade_band varchar(16) NOT NULL DEFAULT 'GRADE_1_2',
  definition_vi text NOT NULL,
  example_sentence_vi text NOT NULL,
  nuance_note_vi text,
  source_book_id uuid REFERENCES public.books(id) ON DELETE SET NULL,
  source_page_id uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  visibility varchar(24) NOT NULL DEFAULT 'PARENT_PRIVATE',
  times_used_in_games integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_child_favorite_words_grade_band CHECK (
    grade_band IN ('GRADE_1_2', 'GRADE_3_5')
  ),
  CONSTRAINT ck_child_favorite_words_visibility CHECK (
    visibility = 'PARENT_PRIVATE'
  ),
  CONSTRAINT ck_child_favorite_words_times_used CHECK (
    times_used_in_games >= 0
  ),
  CONSTRAINT ck_child_favorite_words_nonempty CHECK (
    char_length(btrim(word)) > 0
    AND char_length(btrim(normalized_word)) > 0
    AND char_length(btrim(definition_vi)) > 0
    AND char_length(btrim(example_sentence_vi)) > 0
  ),
  CONSTRAINT uq_child_favorite_words_child_norm UNIQUE (child_profile_id, normalized_word)
);

CREATE INDEX IF NOT EXISTS ix_child_favorite_words_child_created
  ON public.child_favorite_words (child_profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_child_favorite_words_parent_id
  ON public.child_favorite_words (parent_id);

-- Enable Row-Level Security on both tables.
ALTER TABLE public.word_glossary_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.child_favorite_words ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.word_glossary_cache FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.child_favorite_words FROM PUBLIC;

DO $feat6_vocab_rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.word_glossary_cache FROM anon;
    REVOKE ALL PRIVILEGES ON TABLE public.child_favorite_words FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- Server-managed via FastAPI require_parent_id; revoke direct client table privileges
    -- and enforce strict PARENT_PRIVATE ownership policy for defense-in-depth.
    REVOKE ALL PRIVILEGES ON TABLE public.word_glossary_cache FROM authenticated;
    REVOKE ALL PRIVILEGES ON TABLE public.child_favorite_words FROM authenticated;

    IF to_regprocedure('auth.uid()') IS NOT NULL THEN
      DROP POLICY IF EXISTS child_favorite_words_parent_owns ON public.child_favorite_words;
      CREATE POLICY child_favorite_words_parent_owns
        ON public.child_favorite_words
        FOR ALL
        TO authenticated
        USING (
          parent_id = (SELECT auth.uid())
          AND visibility = 'PARENT_PRIVATE'
          AND EXISTS (
            SELECT 1
            FROM public.childprofiles cp
            JOIN public.profiles p ON p.id = cp.parentid
            WHERE cp.id = child_favorite_words.child_profile_id
              AND cp.parentid = (SELECT auth.uid())
              AND p.active = 1
          )
        )
        WITH CHECK (
          parent_id = (SELECT auth.uid())
          AND visibility = 'PARENT_PRIVATE'
          AND EXISTS (
            SELECT 1
            FROM public.childprofiles cp
            JOIN public.profiles p ON p.id = cp.parentid
            WHERE cp.id = child_favorite_words.child_profile_id
              AND cp.parentid = (SELECT auth.uid())
              AND p.active = 1
          )
        );
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL PRIVILEGES ON TABLE public.word_glossary_cache TO service_role;
    GRANT ALL PRIVILEGES ON TABLE public.child_favorite_words TO service_role;

    DROP POLICY IF EXISTS word_glossary_cache_server_only ON public.word_glossary_cache;
    CREATE POLICY word_glossary_cache_server_only
      ON public.word_glossary_cache
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);

    DROP POLICY IF EXISTS child_favorite_words_server_only ON public.child_favorite_words;
    CREATE POLICY child_favorite_words_server_only
      ON public.child_favorite_words
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END;
$feat6_vocab_rls$;

COMMIT;
