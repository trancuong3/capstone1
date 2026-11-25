-- Precomputed & cached TTS audio metadata + private Storage buckets.
-- Additive & idempotent: safe on full production/staging DBs and minimal CI DBs.
-- Privacy invariant (#48): PRIVATE book TTS clips MUST carry non-null owner_parent_id
-- and NEVER deduplicate across families; CATALOG/COACHING clips have NULL owner_parent_id.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tts_audio_cache_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope TEXT NOT NULL CHECK (scope IN ('CATALOG', 'PRIVATE', 'COACHING')),
    owner_parent_id UUID NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    book_id UUID NULL REFERENCES public.books(id) ON DELETE CASCADE,
    page_id UUID NULL REFERENCES public.bookpages(id) ON DELETE CASCADE,
    page_revision_id UUID NULL REFERENCES public.pagerevisions(id) ON DELETE CASCADE,
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    normalized_text TEXT NOT NULL,
    voice_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    speed NUMERIC(3, 2) NOT NULL DEFAULT 1.00 CHECK (speed >= 0.70 AND speed <= 1.20),
    audio_format TEXT NOT NULL CHECK (audio_format IN ('audio/mpeg', 'audio/ogg', 'audio/wav')),
    storage_bucket TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    byte_size BIGINT NOT NULL CHECK (byte_size > 0),
    duration_seconds DOUBLE PRECISION NULL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    word_timings_json JSONB NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'STALE', 'DELETED')),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    hit_count BIGINT NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_tts_cache_scope_owner CHECK (
        (scope = 'PRIVATE' AND owner_parent_id IS NOT NULL)
        OR (scope IN ('CATALOG', 'COACHING') AND owner_parent_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tts_cache_active_key
    ON public.tts_audio_cache_entries (
        scope,
        COALESCE(owner_parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
        content_sha256,
        voice_id,
        model_version,
        speed,
        audio_format
    )
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS ix_tts_cache_book_page_rev
    ON public.tts_audio_cache_entries (book_id, page_id, page_revision_id)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS ix_tts_cache_lru
    ON public.tts_audio_cache_entries (status, last_accessed_at ASC)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS ix_tts_cache_owner_scope
    ON public.tts_audio_cache_entries (owner_parent_id, scope)
    WHERE owner_parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.tts_audio_cache_daily_usage (
    usage_date DATE PRIMARY KEY,
    bytes_served BIGINT NOT NULL DEFAULT 0 CHECK (bytes_served >= 0),
    hit_count BIGINT NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
    miss_count BIGINT NOT NULL DEFAULT 0 CHECK (miss_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.tts_audio_cache_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tts_audio_cache_daily_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
    public.tts_audio_cache_entries,
    public.tts_audio_cache_daily_usage
FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT ALL PRIVILEGES ON TABLE public.tts_audio_cache_entries TO service_role';
        EXECUTE 'GRANT ALL PRIVILEGES ON TABLE public.tts_audio_cache_daily_usage TO service_role';

        EXECUTE 'DROP POLICY IF EXISTS tts_audio_cache_server_only ON public.tts_audio_cache_entries';
        EXECUTE 'CREATE POLICY tts_audio_cache_server_only ON public.tts_audio_cache_entries FOR ALL TO service_role USING (true) WITH CHECK (true)';

        EXECUTE 'DROP POLICY IF EXISTS tts_audio_cache_daily_usage_server_only ON public.tts_audio_cache_daily_usage';
        EXECUTE 'CREATE POLICY tts_audio_cache_daily_usage_server_only ON public.tts_audio_cache_daily_usage FOR ALL TO service_role USING (true) WITH CHECK (true)';
    END IF;
END $$;

-- Ensure private Storage buckets accept compressed TTS audio (audio/mpeg, audio/ogg, audio/wav)
-- and deny browser direct access (served strictly via FastAPI).
DO $$
BEGIN
    IF to_regclass('storage.buckets') IS NOT NULL
       AND to_regclass('storage.objects') IS NOT NULL THEN

        IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'viread-private-books') THEN
            UPDATE storage.buckets
            SET allowed_mime_types = (
                SELECT ARRAY(
                    SELECT DISTINCT mime
                    FROM unnest(
                        COALESCE(allowed_mime_types, ARRAY[]::text[])
                        || ARRAY['audio/mpeg', 'audio/ogg', 'audio/wav']::text[]
                    ) AS mime
                )
            )
            WHERE id = 'viread-private-books'
              AND allowed_mime_types IS NOT NULL;
        END IF;

        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES (
            'viread-tts-cache',
            'viread-tts-cache',
            false,
            52428800,
            ARRAY['audio/mpeg', 'audio/ogg', 'audio/wav']::text[]
        )
        ON CONFLICT (id) DO UPDATE
            SET public = false,
                file_size_limit = excluded.file_size_limit,
                allowed_mime_types = excluded.allowed_mime_types;

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            EXECUTE 'DROP POLICY IF EXISTS tts_cache_objects_server_only ON storage.objects';
            EXECUTE $p$
                CREATE POLICY tts_cache_objects_server_only
                    ON storage.objects
                    FOR ALL TO service_role
                    USING (bucket_id = 'viread-tts-cache')
                    WITH CHECK (bucket_id = 'viread-tts-cache')
            $p$;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
           AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE 'DROP POLICY IF EXISTS tts_cache_objects_browser_denied ON storage.objects';
            EXECUTE $p$
                CREATE POLICY tts_cache_objects_browser_denied
                    ON storage.objects AS RESTRICTIVE
                    FOR ALL TO anon, authenticated
                    USING (bucket_id <> 'viread-tts-cache')
                    WITH CHECK (bucket_id <> 'viread-tts-cache')
            $p$;
        END IF;
    END IF;
END $$;

COMMIT;
