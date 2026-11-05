# Private profile avatar storage

Parent and child avatars use the dedicated `viread-avatars` private bucket. The
backend validates JPEG, PNG, and WebP uploads up to 5 MB, removes metadata,
normalizes them to centered square WebP images, and stores only the object path
in `profiles.avatar_path` or `childprofiles.avatar_path`.

Apply `20261105062055_add_profile_avatar_storage.sql` to the connected Supabase
project before deploying the API. The migration creates the private bucket with
a 5 MB limit and permits Storage object access through the server-side
`service_role`; it adds no browser access policy. The API creates one-hour signed
URLs when returning profile data. Signed URLs are never stored in PostgreSQL.

The backend accepts this optional setting, which defaults to the bucket created
by the migration:

```env
SUPABASE_AVATAR_BUCKET=viread-avatars
```

If you choose a different bucket name, create that bucket as private and grant
Storage object access to the backend's `service_role` before deploying. The SQL
migration configures only the default `viread-avatars` bucket.

Keep `SUPABASE_SECRET_KEY` or the existing `SUPABASE_SERVICE_ROLE_KEY` on the
backend only. The existing `SUPABASE_STORAGE_BUCKET` setting remains dedicated
to book images and is unchanged.
