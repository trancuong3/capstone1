-- Independent karaoke catalog. Apply to a disposable database before deployment.
BEGIN;

CREATE TABLE public.karaoke_songs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status varchar(16) NOT NULL DEFAULT 'DRAFT',
    published_version_id uuid,
    revision integer NOT NULL DEFAULT 1,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT karaoke_song_status CHECK (status IN ('DRAFT','PUBLISHED','HIDDEN')),
    CONSTRAINT karaoke_song_revision CHECK (revision >= 1),
    CONSTRAINT karaoke_song_publication CHECK (
        (status = 'DRAFT' AND published_version_id IS NULL) OR
        (status IN ('PUBLISHED','HIDDEN') AND published_version_id IS NOT NULL)
    )
);

CREATE TABLE public.karaoke_song_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    song_id uuid NOT NULL REFERENCES public.karaoke_songs(id) ON DELETE RESTRICT,
    version_no integer NOT NULL,
    state varchar(16) NOT NULL DEFAULT 'DRAFT',
    title varchar(200) NOT NULL DEFAULT '',
    author varchar(200) NOT NULL DEFAULT '',
    min_grade smallint NOT NULL DEFAULT 1,
    max_grade smallint NOT NULL DEFAULT 5,
    source_note text NOT NULL DEFAULT '',
    usage_note text NOT NULL DEFAULT '',
    audio_path text,
    cover_path text,
    audio_sha256 varchar(64),
    timed_audio_sha256 varchar(64),
    audio_size_bytes integer,
    duration_ms integer,
    lyrics jsonb NOT NULL DEFAULT '{"format_version":1,"lines":[]}'::jsonb,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    CONSTRAINT karaoke_version_song_id_key UNIQUE (song_id, id),
    CONSTRAINT karaoke_version_number_key UNIQUE (song_id, version_no),
    CONSTRAINT karaoke_version_number CHECK (version_no >= 1),
    CONSTRAINT karaoke_version_state CHECK (state IN ('DRAFT','PUBLISHED','SUPERSEDED')),
    CONSTRAINT karaoke_version_grades CHECK (1 <= min_grade AND min_grade <= max_grade AND max_grade <= 5),
    CONSTRAINT karaoke_version_title CHECK (char_length(title) <= 200 AND char_length(author) <= 200),
    CONSTRAINT karaoke_version_source CHECK (char_length(source_note) <= 1000 AND char_length(usage_note) <= 1000),
    CONSTRAINT karaoke_version_duration CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 300000),
    CONSTRAINT karaoke_version_audio_size CHECK (audio_size_bytes IS NULL OR audio_size_bytes BETWEEN 1 AND 20971520)
);

ALTER TABLE public.karaoke_songs
    ADD CONSTRAINT karaoke_song_published_version_fk
    FOREIGN KEY (id, published_version_id)
    REFERENCES public.karaoke_song_versions(song_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX karaoke_one_draft_idx ON public.karaoke_song_versions(song_id)
    WHERE state = 'DRAFT';
CREATE INDEX karaoke_song_catalog_idx ON public.karaoke_songs(status, created_at, id);

ALTER TABLE public.karaoke_songs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.karaoke_song_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.karaoke_songs, public.karaoke_song_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.karaoke_songs, public.karaoke_song_versions TO service_role;
CREATE POLICY karaoke_songs_server_only ON public.karaoke_songs FOR ALL TO service_role
    USING (true) WITH CHECK (true);
CREATE POLICY karaoke_versions_server_only ON public.karaoke_song_versions FOR ALL TO service_role
    USING (true) WITH CHECK (true);

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('viread-karaoke', 'viread-karaoke', false, 20971520, ARRAY['audio/mpeg','image/webp']::text[])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
CREATE POLICY karaoke_objects_server_only ON storage.objects FOR ALL TO service_role
    USING (bucket_id = 'viread-karaoke') WITH CHECK (bucket_id = 'viread-karaoke');
-- A permissive legacy policy on another bucket must not expose these objects.
CREATE POLICY karaoke_objects_browser_denied ON storage.objects AS RESTRICTIVE
    FOR ALL TO anon, authenticated
    USING (bucket_id <> 'viread-karaoke') WITH CHECK (bucket_id <> 'viread-karaoke');

COMMIT;
