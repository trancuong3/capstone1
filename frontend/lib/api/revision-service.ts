import type {
  AdminPageProcessingDTO,
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
  AdminRevisionVerifyRequestDTO,
} from "@/types/admin";
import { z } from "zod";
import {
  AdminOcrJobQueuedSignal,
  adminOcrJobSchema,
  adminProcessingSchema,
  pollAdminOcrJob,
} from "@/lib/api/admin-page-service";
import { requestApi } from "@/lib/api/api-client";
import { adminRevisionDetailSchema } from "@/lib/api/ocr-review-service";
import { isServiceError, ServiceError } from "@/lib/api/service-error";
import { translateRuntime } from "@/lib/i18n/runtime";

export interface RevisionService {
  list(pageId: string): Promise<readonly AdminRevisionSummaryUI[]>;
  createDraft(
    pageId: string,
    expectedSourceRevisionId: string,
  ): Promise<AdminPageRevisionDetailDTO>;
  verify(
    pageId: string,
    request: AdminRevisionVerifyRequestDTO,
  ): Promise<AdminPageRevisionDetailDTO>;
  reprocess(
    pageId: string,
    onStatus?: (status: AdminPageProcessingDTO) => void,
  ): Promise<AdminPageRevisionDetailDTO>;
}

export function createRevisionService(options?: {
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
}): RevisionService {
  const pollIntervalMs = options?.pollIntervalMs ?? 1_500;
  const maxPollAttempts = options?.maxPollAttempts ?? 60;
  return {
    list: (pageId) =>
      requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}/revisions`,
        z.array(
          z.object({
            page_revision_id: z.uuid(),
            revision_no: z.number().int().positive(),
            verification_status: z.enum([
              "PROCESSING",
              "NEEDS_REVIEW",
              "VERIFIED",
            ]),
            created_at: z.iso.datetime({ offset: true }),
            is_current_verified: z.boolean(),
          }),
        ),
      ),
    createDraft: (pageId, expectedSourceRevisionId) =>
      requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}/revisions/draft`,
        adminRevisionDetailSchema.refine((item) => item.page_id === pageId),
        undefined,
        {
          method: "POST",
          body: {
            expected_source_revision_id: expectedSourceRevisionId,
          },
        },
      ),
    verify: (pageId, request) =>
      requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}/verify`,
        adminRevisionDetailSchema.refine(
          (item) =>
            item.page_id === pageId &&
            item.page_revision_id === request.page_revision_id,
        ),
        undefined,
        {
          method: "POST",
          body: {
            page_revision_id: request.page_revision_id,
            workflow_id: request.workflow_id,
            corrected_text: request.corrected_text,
            words: request.words.map((word) => ({
              word_index: word.word_index,
              line_index: word.line_index,
              text: word.text,
              normalized_text: word.normalized_text,
              bbox: [...word.bbox],
              ocr_confidence: word.ocr_confidence,
            })),
            proofread_audit: request.proofread_audit,
          },
        },
      ),
    reprocess: async (pageId, onStatus) => {
      let detail: AdminPageRevisionDetailDTO;
      try {
        const job = await requestApi(
          `/books/admin/pages/${encodeURIComponent(pageId)}/reprocess/jobs`,
          adminOcrJobSchema,
          undefined,
          { method: "POST" },
        );
        const finalJob = await pollAdminOcrJob(job, {
          pollIntervalMs,
          maxAttempts: maxPollAttempts,
        });
        if (
          finalJob.status === "DEAD_LETTER" ||
          finalJob.status === "CANCELLED"
        ) {
          throw new ServiceError({
            code: "NETWORK_ERROR",
            status: 503,
            request_id: finalJob.id,
            retryable: finalJob.status !== "CANCELLED",
            message:
              finalJob.error_message ||
              translateRuntime("admin.pageUploadRuntime.reprocessIncomplete"),
          });
        }
        if (finalJob.status !== "SUCCEEDED") {
          throw new AdminOcrJobQueuedSignal(
            finalJob,
            translateRuntime("admin.pageUploadRuntime.reprocessQueuedWindows"),
          );
        }
        if (finalJob.revision_id) {
          detail = await requestApi(
            `/books/admin/pages/${encodeURIComponent(pageId)}/revisions/${encodeURIComponent(finalJob.revision_id)}`,
            adminRevisionDetailSchema.refine((item) => item.page_id === pageId),
          );
        } else {
          const processing = await requestApi(
            `/books/admin/pages/${encodeURIComponent(pageId)}/processing`,
            adminProcessingSchema.refine((item) => item.page_id === pageId),
          );
          detail = await requestApi(
            `/books/admin/pages/${encodeURIComponent(pageId)}/revisions/${encodeURIComponent(processing.page_revision_id)}`,
            adminRevisionDetailSchema.refine((item) => item.page_id === pageId),
          );
        }
      } catch (error) {
        const shouldFallbackSync =
          isServiceError(error) &&
          (error.status === 404 ||
            error.status === 405 ||
            error.status === 501);
        if (!shouldFallbackSync) throw error;
        detail = await requestApi(
          `/books/admin/pages/${encodeURIComponent(pageId)}/reprocess`,
          adminRevisionDetailSchema.refine((item) => item.page_id === pageId),
          undefined,
          { method: "POST" },
        );
      }
      if (onStatus) {
        try {
          const status = await requestApi(
            `/books/admin/pages/${encodeURIComponent(pageId)}/processing`,
            adminProcessingSchema,
          );
          onStatus(status);
        } catch {
          // The revision response is authoritative; status refresh can be retried by the UI.
        }
      }
      return detail;
    },
  };
}
