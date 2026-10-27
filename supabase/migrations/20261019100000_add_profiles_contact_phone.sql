-- Store a parent's contact phone separately from Supabase Auth phone.
-- This field is informational and does not represent a verified sign-in identity.
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS contact_phone TEXT;

COMMENT ON COLUMN public.profiles.contact_phone IS
'Parent contact phone for profile communication; not a Supabase Auth phone or verified identity.';
