-- Keep avatar objects private and record only their stable Storage paths.
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS avatar_path TEXT;

ALTER TABLE public.childprofiles
    ADD COLUMN IF NOT EXISTS avatar_path TEXT;

COMMENT ON COLUMN public.profiles.avatar_path IS
    'Private Supabase Storage object path for the parent's ViRead avatar.';

COMMENT ON COLUMN public.childprofiles.avatar_path IS
    'Private Supabase Storage object path for the child profile avatar.';

INSERT INTO storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
VALUES (
    'viread-avatars',
    'viread-avatars',
    FALSE,
    5242880,
    ARRAY['image/webp']::TEXT[]
)
ON CONFLICT (id) DO UPDATE
SET
    name = EXCLUDED.name,
    public = FALSE,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY viread_avatars_service_role_only
    ON storage.objects
    FOR ALL
    TO service_role
    USING (bucket_id = 'viread-avatars')
    WITH CHECK (bucket_id = 'viread-avatars');
