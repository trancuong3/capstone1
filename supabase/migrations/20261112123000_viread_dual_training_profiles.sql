-- Add product-facing names for two independent VietOCR training flows.
-- The sample source_flow identifiers stay unchanged to preserve existing rows.

ALTER TABLE public.viread_ocr_training_runs
    DROP CONSTRAINT IF EXISTS viread_ocr_training_runs_profile_check;
ALTER TABLE public.viread_ocr_training_runs
    ADD CONSTRAINT viread_ocr_training_runs_profile_check
    CHECK (profile IN (
        'FLOW1_EXTERNAL_TRDG', 'FLOW2_ADMIN_VERIFIED',
        'FLOW1_VERIFIED', 'FLOW2_EXTERNAL_TRDG'
    ));

ALTER TABLE public.viread_ocr_model_decisions
    DROP CONSTRAINT IF EXISTS viread_ocr_model_decisions_candidate_profile_check;
ALTER TABLE public.viread_ocr_model_decisions
    ADD CONSTRAINT viread_ocr_model_decisions_candidate_profile_check
    CHECK (candidate_profile IN (
        'ORIGINAL', 'FLOW1_EXTERNAL_TRDG', 'FLOW2_ADMIN_VERIFIED',
        'FLOW1_VERIFIED', 'FLOW2_EXTERNAL_TRDG'
    ));

ALTER TABLE public.viread_ocr_model_decisions
    DROP CONSTRAINT IF EXISTS viread_ocr_model_decisions_previous_profile_check;
ALTER TABLE public.viread_ocr_model_decisions
    ADD CONSTRAINT viread_ocr_model_decisions_previous_profile_check
    CHECK (previous_profile IN (
        'ORIGINAL', 'FLOW1_EXTERNAL_TRDG', 'FLOW2_ADMIN_VERIFIED',
        'FLOW1_VERIFIED', 'FLOW2_EXTERNAL_TRDG'
    ));

ALTER TABLE public.viread_ocr_active_model
    DROP CONSTRAINT IF EXISTS viread_ocr_active_model_profile_check;
ALTER TABLE public.viread_ocr_active_model
    ADD CONSTRAINT viread_ocr_active_model_profile_check
    CHECK (profile IN (
        'ORIGINAL', 'FLOW1_EXTERNAL_TRDG', 'FLOW2_ADMIN_VERIFIED',
        'FLOW1_VERIFIED', 'FLOW2_EXTERNAL_TRDG'
    ));
