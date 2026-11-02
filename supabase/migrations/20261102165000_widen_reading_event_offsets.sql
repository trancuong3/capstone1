-- Preserve millisecond offsets for long reading sessions.
-- Widening SMALLINT to INTEGER is non-destructive and retains existing values.
ALTER TABLE public.readingevents
  ALTER COLUMN startms TYPE INTEGER USING startms::INTEGER;

ALTER TABLE public.readingevents
  ALTER COLUMN endms TYPE INTEGER USING endms::INTEGER;
