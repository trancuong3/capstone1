-- Rollback for ViRead AI Smart Book Studio V2 additive satellite schema.
-- Strictly preserves all existing books, pages, revisions, reading sessions, and Flow 1/Flow 2 OCR training data.
begin;

drop table if exists public.smart_studio_jobs cascade;
drop table if exists public.page_ocr_extractions cascade;
drop table if exists public.book_style_bibles cascade;
drop table if exists public.book_presentation_assets cascade;

commit;
