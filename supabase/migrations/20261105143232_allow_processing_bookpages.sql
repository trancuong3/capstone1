-- Keep the page lifecycle CHECK constraint aligned with the backend upload workflow.
-- PROCESSING is a reservation state used while an admin page image is being processed.
-- This migration is safe to run when the constraint already includes PROCESSING.

DO $$
DECLARE
    existing_definition text;
BEGIN
    IF to_regclass('public.bookpages') IS NULL THEN
        RAISE EXCEPTION 'Expected public.bookpages to exist before applying lifecycle status migration';
    END IF;

    SELECT pg_get_constraintdef(con.oid)
      INTO existing_definition
      FROM pg_constraint AS con
     WHERE con.conrelid = 'public.bookpages'::regclass
       AND con.conname = 'bookpages_lifecyclestatus_check'
       AND con.contype = 'c';

    IF existing_definition IS NULL THEN
        ALTER TABLE public.bookpages
            ADD CONSTRAINT bookpages_lifecyclestatus_check
            CHECK (lifecyclestatus IN ('PROCESSING', 'ACTIVE', 'RETIRED'));
    ELSIF position('PROCESSING' IN existing_definition) = 0 THEN
        ALTER TABLE public.bookpages
            DROP CONSTRAINT bookpages_lifecyclestatus_check;

        ALTER TABLE public.bookpages
            ADD CONSTRAINT bookpages_lifecyclestatus_check
            CHECK (lifecyclestatus IN ('PROCESSING', 'ACTIVE', 'RETIRED'));
    END IF;
END
$$;
