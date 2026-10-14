-- Non-destructive migration: persist OCR/editor draft text separately from verified ground truth.
ALTER TABLE public.pagerevisions
    ADD COLUMN IF NOT EXISTS drafttext TEXT;
