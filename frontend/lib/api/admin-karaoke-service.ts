import { apiQuery, requestApi } from "@/lib/api/api-client";
import { isServiceError } from "@/lib/api/service-error";
import {
  adminKaraokeDetailSchema,
  adminKaraokeListSchema,
  karaokePreviewSchema,
  karaokeValidationSchema,
  type KaraokeSongCreate,
  type KaraokeDraftWrite,
} from "@/types/karaoke";
import { z } from "zod";
import {
  draftReferencePreviewSchema,
  fingerprintSchema,
  processingCapabilitiesSchema,
  processingCancelSchema,
  processingDraftRequestSchema,
  processingJobListSchema,
  processingJobSchema,
  processingPreviewSchema,
  processingRetrySchema,
  processingReviewRequestSchema,
  processingStartSchema,
  type ProcessingDraftRequest,
  type ProcessingJob,
  type ProcessingRetry,
  type ProcessingReviewRequest,
  type ProcessingStart,
} from "@/types/karaoke-processing";

const root = "/karaoke/admin/songs";
function path(id: string) {
  return `${root}/${z.guid().parse(id)}`;
}
const detail = (id: string) =>
  adminKaraokeDetailSchema.refine((value) => value.song_id === id);
function jobPath(id: string, jobId?: string) {
  return `${path(id)}/processing-jobs${jobId ? `/${z.guid().parse(jobId)}` : ""}`;
}
const jobResponse = (songId: string, draftId: string, jobId?: string) =>
  processingJobSchema.refine(
    (job) =>
      job.song_id === songId &&
      job.draft_version_id === draftId &&
      (!jobId || job.id === jobId),
  );

export function createAdminKaraokeService() {
  return {
    getProcessingCapabilities(signal?: AbortSignal) {
      return requestApi(
        "/karaoke/admin/processing-capabilities",
        processingCapabilitiesSchema,
        signal,
      );
    },
    uploadReference(
      id: string,
      file: File,
      revision: number,
      draftId: string,
      signal?: AbortSignal,
    ) {
      const body = new FormData();
      body.set("file", file);
      body.set("expected_revision", String(revision));
      body.set("draft_version_id", z.guid().parse(draftId));
      return requestApi(
        `${path(id)}/draft/reference-audio`,
        detail(id),
        signal,
        { method: "POST", body },
      );
    },
    removeReference(
      id: string,
      body: ProcessingDraftRequest,
      signal?: AbortSignal,
    ) {
      return requestApi(
        `${path(id)}/draft/reference-audio`,
        detail(id),
        signal,
        { method: "DELETE", body: processingDraftRequestSchema.parse(body) },
      );
    },
    startProcessing(id: string, body: ProcessingStart, signal?: AbortSignal) {
      const parsed = processingStartSchema.parse(body);
      return requestApi(
        jobPath(id),
        jobResponse(id, parsed.draft_version_id).refine(
          (job) =>
            job.base_revision === parsed.expected_revision &&
            job.mode === parsed.mode &&
            job.source_kind === parsed.source_kind,
        ),
        signal,
        { method: "POST", body: parsed },
      );
    },
    listProcessing(
      id: string,
      query: { limit?: number; offset?: number } = {},
      signal?: AbortSignal,
    ) {
      const limit = z
        .number()
        .int()
        .min(1)
        .max(50)
        .parse(query.limit ?? 10);
      const offset = z
        .number()
        .int()
        .nonnegative()
        .parse(query.offset ?? 0);
      return requestApi(
        `${jobPath(id)}${apiQuery({ limit, offset })}`,
        processingJobListSchema.refine(
          (list) =>
            list.limit === limit &&
            list.offset === offset &&
            list.items.every((job) => job.song_id === id),
        ),
        signal,
      );
    },
    getProcessing(
      id: string,
      jobId: string,
      draftId: string,
      signal?: AbortSignal,
    ) {
      return requestApi(
        jobPath(id, jobId),
        jobResponse(id, z.guid().parse(draftId), jobId),
        signal,
      );
    },
    cancelProcessing(
      id: string,
      jobId: string,
      draftId: string,
      signal?: AbortSignal,
    ) {
      const body = processingCancelSchema.parse({ draft_version_id: draftId });
      return requestApi(
        `${jobPath(id, jobId)}/cancel`,
        jobResponse(id, draftId, jobId),
        signal,
        { method: "POST", body },
      );
    },
    retryProcessing(
      id: string,
      jobId: string,
      body: ProcessingRetry,
      signal?: AbortSignal,
    ) {
      const parsed = processingRetrySchema.parse(body);
      return requestApi(
        `${jobPath(id, jobId)}/retry`,
        jobResponse(id, parsed.draft_version_id).refine(
          (job) =>
            job.base_revision === parsed.expected_revision && job.id !== jobId,
        ),
        signal,
        { method: "POST", body: parsed },
      );
    },
    getProcessingPreview(job: ProcessingJob, signal?: AbortSignal) {
      return requestApi(
        `${jobPath(job.song_id, job.id)}/preview`,
        processingPreviewSchema.refine(
          (preview) =>
            preview.job_id === job.id &&
            preview.song_id === job.song_id &&
            preview.draft_version_id === job.draft_version_id &&
            preview.base_revision === job.base_revision &&
            preview.input_fingerprint === job.input_fingerprint,
        ),
        signal,
      );
    },
    getDraftReferencePreview(
      id: string,
      revision: number,
      draftId: string,
      fingerprint: string,
      signal?: AbortSignal,
    ) {
      z.guid().parse(draftId);
      fingerprintSchema.parse(fingerprint);
      return requestApi(
        `${path(id)}/draft/reference-preview`,
        draftReferencePreviewSchema.refine(
          (preview) =>
            preview.song_id === id &&
            preview.draft_version_id === draftId &&
            preview.revision === revision &&
            preview.content_fingerprint === fingerprint,
        ),
        signal,
      );
    },
    applyProcessing(
      id: string,
      jobId: string,
      body: ProcessingDraftRequest,
      signal?: AbortSignal,
    ) {
      const parsed = processingDraftRequestSchema.parse(body);
      return requestApi(
        `${jobPath(id, jobId)}/apply`,
        detail(id).refine(
          (value) => value.draft?.id === parsed.draft_version_id,
        ),
        signal,
        { method: "POST", body: parsed },
      );
    },
    confirmReview(
      id: string,
      body: ProcessingReviewRequest,
      signal?: AbortSignal,
    ) {
      const parsed = processingReviewRequestSchema.parse(body);
      return requestApi(
        `${path(id)}/draft/review`,
        detail(id).refine(
          (value) =>
            value.draft?.id === parsed.draft_version_id &&
            value.processing_review?.reviewed === true &&
            value.processing_review.current_content_fingerprint ===
              parsed.content_fingerprint,
        ),
        signal,
        { method: "POST", body: parsed },
      );
    },
    list(
      query: {
        search?: string;
        status?: "DRAFT" | "PUBLISHED" | "HIDDEN";
        offset?: number;
      },
      signal?: AbortSignal,
    ) {
      return requestApi(
        `${root}${apiQuery({ ...query, limit: 12 })}`,
        adminKaraokeListSchema,
        signal,
      );
    },
    get(id: string, signal?: AbortSignal) {
      return requestApi(path(id), detail(id), signal);
    },
    create(body: KaraokeSongCreate, signal?: AbortSignal) {
      return requestApi(root, adminKaraokeDetailSchema, signal, {
        method: "POST",
        body,
      });
    },
    createDraft(id: string, revision: number, signal?: AbortSignal) {
      return requestApi(`${path(id)}/draft`, detail(id), signal, {
        method: "POST",
        body: { expected_revision: revision },
      });
    },
    save(id: string, body: KaraokeDraftWrite, signal?: AbortSignal) {
      return requestApi(`${path(id)}/draft`, detail(id), signal, {
        method: "PUT",
        body,
      });
    },
    upload(
      id: string,
      kind: "audio" | "cover",
      file: File,
      revision: number,
      draftId: string,
      signal?: AbortSignal,
    ) {
      const body = new FormData();
      body.set("file", file);
      body.set("expected_revision", String(revision));
      body.set("draft_version_id", draftId);
      return requestApi(`${path(id)}/draft/${kind}`, detail(id), signal, {
        method: "POST",
        body,
      });
    },
    validate(
      id: string,
      revision: number,
      draftId: string,
      signal?: AbortSignal,
    ) {
      return requestApi(
        `${path(id)}/draft/validation`,
        karaokeValidationSchema.refine(
          (v) => v.revision === revision && v.draft_version_id === draftId,
        ),
        signal,
      );
    },
    preview(
      id: string,
      revision: number,
      draftId: string,
      signal?: AbortSignal,
    ) {
      return requestApi(
        `${path(id)}/draft/preview`,
        karaokePreviewSchema.refine(
          (v) =>
            v.song_id === id &&
            v.revision === revision &&
            v.version_id === draftId,
        ),
        signal,
      );
    },
    publish(
      id: string,
      revision: number,
      draftId: string,
      signal?: AbortSignal,
    ) {
      return requestApi(`${path(id)}/publish`, detail(id), signal, {
        method: "POST",
        body: { expected_revision: revision, draft_version_id: draftId },
      });
    },
    visibility(
      id: string,
      revision: number,
      visible: boolean,
      signal?: AbortSignal,
    ) {
      return requestApi(`${path(id)}/visibility`, detail(id), signal, {
        method: "PATCH",
        body: { expected_revision: revision, visible },
      });
    },
  };
}
export type AdminKaraokeService = ReturnType<typeof createAdminKaraokeService>;

export function karaokeErrorMessage(error: unknown) {
  if (isServiceError(error)) {
    switch (error.status) {
      case 401:
        return "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.";
      case 403:
        return "Tài khoản không có quyền quản lý bài hát.";
      case 404:
        return "Không tìm thấy bài hát hoặc bản nháp.";
      case 409:
        return "Bài hát vừa thay đổi. Bản đang nhập được giữ lại; hãy tải lại để đối chiếu trước khi sửa tiếp.";
      case 413:
        return "File vượt quá giới hạn cho phép.";
      case 415:
        return "Định dạng file không được hỗ trợ hoặc file bị hỏng.";
      case 422:
        return "Nội dung chưa hợp lệ. Hãy kiểm tra thông tin, lời và thời gian từng dòng.";
      case 429:
        return "Đã đạt giới hạn xử lý karaoke. Hãy đợi trước khi gửi lại.";
      case 503:
        return "Dịch vụ karaoke chưa sẵn sàng. Kiểm tra migration và Storage ở backend.";
    }
  }
  return "Chưa hoàn tất yêu cầu. Nội dung đang nhập được giữ lại; vui lòng thử lại.";
}
