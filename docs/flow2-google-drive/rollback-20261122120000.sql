-- Rollback for 20261122120000_parent_private_book_flow2_contribution.sql
-- Safe to run if no PARENT_CONTRIBUTION_CANDIDATE outbox events exist (deletes them first).

BEGIN;

DELETE FROM public.viread_ocr_outbox WHERE event_type = 'PARENT_CONTRIBUTION_CANDIDATE';

DROP INDEX IF EXISTS public.uq_viread_ocr_outbox_parent_candidate;
DROP INDEX IF EXISTS public.uq_viread_ocr_outbox_verified_revision;

ALTER TABLE public.viread_ocr_outbox
    DROP CONSTRAINT IF EXISTS viread_ocr_outbox_event_type_check;
ALTER TABLE public.viread_ocr_outbox
    ADD CONSTRAINT viread_ocr_outbox_event_type_check
    CHECK (event_type IN ('VERIFIED_REVISION'));

ALTER TABLE public.viread_ocr_outbox
    ADD CONSTRAINT viread_ocr_outbox_event_type_revision_id_key
    UNIQUE (event_type, revision_id);

ALTER TABLE public.viread_ocr_outbox
    DROP COLUMN IF EXISTS candidate_id;

DROP TABLE IF EXISTS public.parent_book_flow2_candidates;
DROP TABLE IF EXISTS public.parent_book_ocr_contribution_consent_events;
DROP TRIGGER IF EXISTS trg_validate_parent_ocr_consent_book ON public.parent_book_ocr_contribution_consents;
DROP FUNCTION IF EXISTS public.validate_parent_ocr_consent_book();
DROP TABLE IF EXISTS public.parent_book_ocr_contribution_consents;

COMMIT;
