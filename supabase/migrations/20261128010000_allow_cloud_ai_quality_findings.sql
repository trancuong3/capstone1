-- Allow CLOUD_AI as a DetectionSource on bookqualityfindings alongside RULE and OLLAMA_TEXT.
DO $$
DECLARE
  constraint_rec RECORD;
BEGIN
  FOR constraint_rec IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bookqualityfindings'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%detectionsource%'
  LOOP
    EXECUTE format('ALTER TABLE public.bookqualityfindings DROP CONSTRAINT IF EXISTS %I', constraint_rec.conname);
  END LOOP;

  ALTER TABLE public.bookqualityfindings
    ADD CONSTRAINT ck_bookqualityfindings_source
    CHECK (detectionsource IN ('RULE', 'OLLAMA_TEXT', 'CLOUD_AI'));
END $$;
