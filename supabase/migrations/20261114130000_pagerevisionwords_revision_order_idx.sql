-- Sentence Shooter loads word rows by revision and preserves line/word order.
-- PostgreSQL does not automatically index foreign-key columns.
CREATE INDEX IF NOT EXISTS ix_pagerevisionwords_revision_line_word_id
    ON public.pagerevisionwords (pagerevisionid, lineindex, wordindex, id);
