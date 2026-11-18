-- 1. Index cho pagerevisions (khớp truy vấn tìm bản ghi mới nhất và bản ghi VERIFIED)
CREATE INDEX IF NOT EXISTS idx_pagerevisions_page_created_id
    ON public.pagerevisions (pageid, createdat DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_pagerevisions_page_verified_created_id
    ON public.pagerevisions (pageid, createdat DESC, id DESC)
    WHERE verificationstatus = 'VERIFIED';

-- 2. Index bổ sung cho pagerevisionwords khớp các nơi ORDER BY (wordindex, id) không kèm lineindex
CREATE INDEX IF NOT EXISTS idx_pagerevisionwords_revision_word_id
    ON public.pagerevisionwords (pagerevisionid, wordindex, id);

-- 3. Index cho bookpages phục vụ lọc trang ACTIVE/PROCESSING theo thứ tự trang
CREATE INDEX IF NOT EXISTS idx_bookpages_book_lifecycle_page
    ON public.bookpages (bookid, lifecyclestatus, pagenumber, id);

-- 4. Bộ Index chặn Seq Scan trên viread_ocr_samples (cho dataset_version_id và verified_holdout)
CREATE INDEX IF NOT EXISTS idx_viread_ocr_samples_dataset_split_group
    ON public.viread_ocr_samples (dataset_version_id, split, source_group_id, id)
    WHERE dataset_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_viread_ocr_samples_image_sha_split
    ON public.viread_ocr_samples (image_sha256, split);

CREATE INDEX IF NOT EXISTS idx_viread_ocr_samples_page_id
    ON public.viread_ocr_samples (source_page_id)
    WHERE source_page_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_viread_ocr_samples_unversioned_holdout
    ON public.viread_ocr_samples (source_flow, split, source_page_id, source_revision_id)
    WHERE dataset_version_id IS NULL AND source_page_id IS NOT NULL;

-- 5. Index khớp chính xác ORDER BY created_at, id và kiểm tra DONE trên viread_ocr_outbox
CREATE INDEX IF NOT EXISTS idx_viread_ocr_outbox_claim_order
    ON public.viread_ocr_outbox (created_at, id)
    WHERE status IN ('PENDING', 'RETRY', 'PROCESSING');

CREATE INDEX IF NOT EXISTS idx_viread_ocr_outbox_done_page_rev
    ON public.viread_ocr_outbox (page_id, revision_id)
    WHERE status = 'DONE';

-- 6. Partial Index bao phủ đủ các trạng thái chưa hoàn tất mới của viread_ocr_training_jobs
CREATE INDEX IF NOT EXISTS idx_viread_ocr_training_jobs_unresolved
    ON public.viread_ocr_training_jobs (target, status, available_at, created_at, id)
    WHERE status IN (
        'QUEUED', 'LOCAL_RUNNING', 'FALLBACK_QUEUED_COLAB', 'COLAB_RUNNING',
        'WAITING_FOR_DATA', 'WAITING_FOR_COLAB_WORKER', 'COLAB_SUBMITTING',
        'COLAB_SUBMITTED', 'COLAB_EXECUTING', 'BLOCKED_CONFIGURATION'
    );

-- 7. Đồng bộ profiles.role sang auth.users.raw_app_meta_data (an toàn với cả profile legacy)
CREATE OR REPLACE FUNCTION public.sync_profile_role_to_auth_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE auth.users
       SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                               || pg_catalog.jsonb_build_object('role', NEW.role)
     WHERE id = NEW.id;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_profile_role_to_auth_metadata() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_profile_role_sync_auth ON public.profiles;
CREATE TRIGGER on_profile_role_sync_auth
    AFTER INSERT OR UPDATE OF role ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_profile_role_to_auth_metadata();

UPDATE auth.users AS u
   SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('role', p.role)
  FROM public.profiles AS p
 WHERE u.id = p.id
   AND COALESCE(u.raw_app_meta_data ->> 'role', '') IS DISTINCT FROM p.role;