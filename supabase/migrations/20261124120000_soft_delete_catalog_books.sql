-- Add a reversible soft-delete marker to shared catalog books.
-- Historical book rows and every referencing record remain intact.
BEGIN;

ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.books'::regclass
      AND conname = 'books_deleted_by_fkey'
  ) THEN
    ALTER TABLE public.books
      ADD CONSTRAINT books_deleted_by_fkey
      FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.books'::regclass
      AND conname = 'books_soft_delete_metadata_check'
  ) THEN
    ALTER TABLE public.books
      ADD CONSTRAINT books_soft_delete_metadata_check
      CHECK (
        (is_deleted = false AND deleted_at IS NULL AND deleted_by IS NULL)
        OR (is_deleted = true AND deleted_at IS NOT NULL)
      );
  END IF;
END;
$$;

COMMIT;
