-- Preserve RETIRED page numbers for history while requiring unique ACTIVE page numbers.
-- Service operations lock the owning Book row and keep active page numbers contiguous.
DO $$
DECLARE
    constraint_row RECORD;
    index_row RECORD;
BEGIN
    IF to_regclass('public.bookpages') IS NULL THEN
        RAISE EXCEPTION 'Expected public.bookpages to exist before applying page numbering migration';
    END IF;

    -- Replace an exact UNIQUE(bookid, pagenumber) table constraint with ACTIVE-only uniqueness.
    FOR constraint_row IN
        SELECT con.conname
        FROM pg_constraint AS con
        WHERE con.conrelid = 'public.bookpages'::regclass
          AND con.contype = 'u'
          AND (
              SELECT array_agg(att.attname::text ORDER BY key.ordinality)
              FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS att
                ON att.attrelid = con.conrelid AND att.attnum = key.attnum
          ) = ARRAY['bookid', 'pagenumber']::text[]
    LOOP
        EXECUTE format('ALTER TABLE public.bookpages DROP CONSTRAINT %I', constraint_row.conname);
    END LOOP;

    -- Remove an equivalent standalone, non-partial unique index if one exists.
    FOR index_row IN
        SELECT idx.indexrelid::regclass AS index_name
        FROM pg_index AS idx
        WHERE idx.indrelid = 'public.bookpages'::regclass
          AND idx.indisunique
          AND NOT idx.indisprimary
          AND idx.indpred IS NULL
          AND idx.indexprs IS NULL
          AND (
              SELECT array_agg(att.attname::text ORDER BY key.ordinality)
              FROM unnest(idx.indkey) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute AS att
                ON att.attrelid = idx.indrelid AND att.attnum = key.attnum
              WHERE key.ordinality <= idx.indnkeyatts
          ) = ARRAY['bookid', 'pagenumber']::text[]
          AND NOT EXISTS (
              SELECT 1 FROM pg_constraint AS con WHERE con.conindid = idx.indexrelid
          )
    LOOP
        EXECUTE format('DROP INDEX %s', index_row.index_name);
    END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bookpages_active_book_pagenumber
    ON public.bookpages (bookid, pagenumber)
    WHERE lifecyclestatus = 'ACTIVE';
