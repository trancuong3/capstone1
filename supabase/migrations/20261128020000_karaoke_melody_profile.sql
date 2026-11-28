-- Additive migration: Reference Melody Profile for ViRead Pro Karaoke
-- Isolated strictly within karaoke catalog tables (never touches reading_sessions
-- or readingcomparisonreports). Safe, idempotent, backward compatible with legacy songs.

ALTER TABLE public.karaoke_song_versions
  ADD COLUMN IF NOT EXISTS melody_profile jsonb NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_karaoke_song_versions_melody_profile_object'
      AND conrelid = 'public.karaoke_song_versions'::regclass
  ) THEN
    ALTER TABLE public.karaoke_song_versions
      ADD CONSTRAINT ck_karaoke_song_versions_melody_profile_object
      CHECK (melody_profile IS NULL OR jsonb_typeof(melody_profile) = 'object');
  END IF;
END
$$;

COMMENT ON COLUMN public.karaoke_song_versions.melody_profile IS
  'Compact reference vocal melody profile (melody_version, min/max/median MIDI, BPM, syllable-aligned target notes, pitch_contour). NULL for legacy songs without extracted melody.';

-- Ensure karaoke_musical_profiles retains explicit RLS & service_role access if already created.
DO $$
BEGIN
  IF to_regclass('public.karaoke_musical_profiles') IS NOT NULL THEN
    ALTER TABLE public.karaoke_musical_profiles ENABLE ROW LEVEL SECURITY;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'karaoke_musical_profiles'
          AND policyname = 'karaoke_musical_profiles_service_role_all'
      ) THEN
        CREATE POLICY karaoke_musical_profiles_service_role_all
          ON public.karaoke_musical_profiles
          FOR ALL
          TO service_role
          USING (true)
          WITH CHECK (true);
      END IF;
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.karaoke_musical_profiles TO service_role;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'karaoke_musical_profiles'
          AND policyname = 'karaoke_musical_profiles_authenticated_published_read'
      ) THEN
        CREATE POLICY karaoke_musical_profiles_authenticated_published_read
          ON public.karaoke_musical_profiles
          FOR SELECT
          TO authenticated
          USING (
            EXISTS (
              SELECT 1
              FROM public.karaoke_song_versions v
              JOIN public.karaoke_songs s ON s.id = v.song_id
              WHERE v.id = karaoke_musical_profiles.song_version_id
                AND v.state = 'PUBLISHED'
                AND s.status = 'PUBLISHED'
            )
          );
      END IF;
      GRANT SELECT ON TABLE public.karaoke_musical_profiles TO authenticated;
    END IF;
  END IF;
END
$$;
