-- Align reading event CHECK constraints with the event/status vocabulary used by the API.
-- In particular, word retries persist as WORD_RETRY with CONFIRMED or FAILED status.

DO $$
DECLARE
    existing_definition text;
BEGIN
    IF to_regclass('public.readingevents') IS NULL THEN
        RAISE EXCEPTION 'Expected public.readingevents to exist before expanding event checks';
    END IF;

    SELECT pg_get_constraintdef(con.oid)
      INTO existing_definition
      FROM pg_constraint AS con
     WHERE con.conrelid = 'public.readingevents'::regclass
       AND con.conname = 'readingevents_type_check'
       AND con.contype = 'c';

    IF existing_definition IS NULL THEN
        ALTER TABLE public.readingevents
            ADD CONSTRAINT readingevents_type_check
            CHECK (type IN (
                'OMISSION', 'REPETITION', 'LONG_PAUSE', 'MISPRONUNCIATION',
                'SUBSTITUTION', 'SELF_CORRECTION', 'READ_EXAMPLE', 'WORD_RETRY'
            ));
    ELSIF position('WORD_RETRY' IN existing_definition) = 0
       OR position('SUBSTITUTION' IN existing_definition) = 0
       OR position('SELF_CORRECTION' IN existing_definition) = 0
       OR position('READ_EXAMPLE' IN existing_definition) = 0 THEN
        ALTER TABLE public.readingevents
            DROP CONSTRAINT readingevents_type_check;

        ALTER TABLE public.readingevents
            ADD CONSTRAINT readingevents_type_check
            CHECK (type IN (
                'OMISSION', 'REPETITION', 'LONG_PAUSE', 'MISPRONUNCIATION',
                'SUBSTITUTION', 'SELF_CORRECTION', 'READ_EXAMPLE', 'WORD_RETRY'
            ));
    END IF;

    SELECT pg_get_constraintdef(con.oid)
      INTO existing_definition
      FROM pg_constraint AS con
     WHERE con.conrelid = 'public.readingevents'::regclass
       AND con.conname = 'readingevents_status_check'
       AND con.contype = 'c';

    IF existing_definition IS NULL THEN
        ALTER TABLE public.readingevents
            ADD CONSTRAINT readingevents_status_check
            CHECK (status IN (
                'DETECTED', 'IGNORED_BY_GATE', 'FEEDBACK_GIVEN', 'CANDIDATE',
                'CONFIRMED', 'FAILED', 'UNCERTAIN', 'DISMISSED'
            ));
    ELSIF position('CANDIDATE' IN existing_definition) = 0
       OR position('CONFIRMED' IN existing_definition) = 0
       OR position('FAILED' IN existing_definition) = 0
       OR position('UNCERTAIN' IN existing_definition) = 0
       OR position('DISMISSED' IN existing_definition) = 0 THEN
        ALTER TABLE public.readingevents
            DROP CONSTRAINT readingevents_status_check;

        ALTER TABLE public.readingevents
            ADD CONSTRAINT readingevents_status_check
            CHECK (status IN (
                'DETECTED', 'IGNORED_BY_GATE', 'FEEDBACK_GIVEN', 'CANDIDATE',
                'CONFIRMED', 'FAILED', 'UNCERTAIN', 'DISMISSED'
            ));
    END IF;
END
$$;
