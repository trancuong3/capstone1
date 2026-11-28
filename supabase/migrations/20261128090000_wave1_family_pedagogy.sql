-- Wave 1 Pedagogy & Family Companion Tables:
-- 1. public.parent_security_pins: PBKDF2-hashed 4-digit Parent PIN + Child-Safe Mode default & lockout state.
-- 2. public.parent_encouragement_notes: Metadata for short (<=10s, <=256 KB) parent-recorded audio encouragement clips in private Supabase Storage (zero child audio persisted).
-- 3. public.child_warmup_stories: Daily lazy cache for 2-3 sentence Spaced Difficult-Word Warm-Up Micro-Stories.
-- All tables are server-only (RLS enabled, anon/authenticated privileges revoked, service_role granted).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.parent_security_pins (
  parent_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  pin_hash VARCHAR(256) NOT NULL,
  pin_salt VARCHAR(64) NOT NULL,
  child_mode_default BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.parent_encouragement_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  parent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title VARCHAR(100) NULL,
  storage_bucket VARCHAR(80) NOT NULL,
  storage_path VARCHAR(320) NOT NULL,
  mime_type VARCHAR(64) NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_ms INTEGER NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_parent_encouragement_notes_path_safe CHECK (
    storage_path !~* '^https?://' AND position('..' in storage_path) = 0
  ),
  CONSTRAINT ck_parent_encouragement_notes_size CHECK (
    size_bytes > 0 AND size_bytes <= 262144
  ),
  CONSTRAINT ck_parent_encouragement_notes_duration CHECK (
    duration_ms IS NULL OR (duration_ms > 0 AND duration_ms <= 10500)
  )
);

CREATE INDEX IF NOT EXISTS ix_parent_encouragement_notes_child_active
  ON public.parent_encouragement_notes (child_id, is_active, created_at DESC);

CREATE TABLE IF NOT EXISTS public.child_warmup_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  parent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  local_date DATE NOT NULL,
  words_signature VARCHAR(64) NOT NULL,
  target_words JSONB NOT NULL DEFAULT '[]'::jsonb,
  title_vi VARCHAR(120) NOT NULL,
  sentences_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  source VARCHAR(24) NOT NULL DEFAULT 'RULE_BASED',
  tts_prewarmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_child_warmup_stories_source CHECK (
    source IN ('AI', 'RULE_BASED')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_child_warmup_stories_daily
  ON public.child_warmup_stories (child_id, local_date, words_signature);

CREATE INDEX IF NOT EXISTS ix_child_warmup_stories_child_recent
  ON public.child_warmup_stories (child_id, created_at DESC);

DO $secure_wave1_tables$
DECLARE
  tbl_name TEXT;
  has_anon BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
  has_authenticated BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
  has_service_role BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  FOREACH tbl_name IN ARRAY ARRAY[
    'parent_security_pins',
    'parent_encouragement_notes',
    'child_warmup_stories'
  ]
  LOOP
    IF to_regclass('public.' || tbl_name) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC', tbl_name);
    IF has_anon THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon', tbl_name);
    END IF;
    IF has_authenticated THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM authenticated', tbl_name);
    END IF;
    IF has_service_role THEN
      EXECUTE format('GRANT ALL PRIVILEGES ON TABLE public.%I TO service_role', tbl_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl_name || '_service_role_all', tbl_name);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        tbl_name || '_service_role_all',
        tbl_name
      );
    END IF;
  END LOOP;
END;
$secure_wave1_tables$;

DO $provision_parent_encouragement_bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (
      id,
      name,
      public,
      file_size_limit,
      allowed_mime_types
    )
    VALUES (
      'viread-parent-encouragements',
      'viread-parent-encouragements',
      false,
      262144,
      ARRAY[
        'audio/mpeg',
        'audio/mp3',
        'audio/mp4',
        'audio/x-m4a',
        'audio/aac',
        'audio/webm',
        'audio/ogg',
        'audio/wav'
      ]::text[]
    )
    ON CONFLICT (id) DO UPDATE
    SET
      public = false,
      file_size_limit = 262144,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
  END IF;
END;
$provision_parent_encouragement_bucket$;

COMMIT;
