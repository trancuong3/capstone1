import type {
  AdminPageProcessingDTO,
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
  AdminRevisionVerifyRequestDTO,
} from "@/types/admin";
import { z } from "zod";
import { requestApi } from "@/lib/api/api-client";
import { adminRevisionDetailSchema } from "@/lib/api/ocr-review-service";

export interface RevisionService {
  list(pageId: string): Promise<readonly AdminRevisionSummaryUI[]>;
  verify(
    pageId: string,
    request: AdminRevisionVerifyRequestDTO,
  ): Promise<AdminPageRevisionDetailDTO>;
  reprocess(
    pageId: string,
    onStatus?: (status: AdminPageProcessingDTO) => void,
  ): Promise<AdminPageRevisionDetailDTO>;
}

export function createRevisionService(): RevisionService {
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
            corrected_text: request.corrected_text,
            words: request.words.map((word) => ({
              word_index: word.word_index,
              line_index: word.line_index,
              text: word.text,
              normalized_text: word.normalized_text,
              bbox: [...word.bbox],
              ocr_confidence: word.ocr_confidence,
            })),
          },
        },
      ),
    reprocess: async (pageId, onStatus) => {
      const detail = await requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}/reprocess`,
        adminRevisionDetailSchema.refine((item) => item.page_id === pageId),
        undefined,
        { method: "POST" },
      );
      if (onStatus) {
        try {
          const status = await requestApi(
            `/books/admin/pages/${encodeURIComponent(pageId)}/processing`,
            z.object({
              page_id: z.uuid(),
              page_revision_id: z.uuid(),
              revision_no: z.number().int().positive(),
              verification_status: z.enum([
                "PROCESSING",
                "NEEDS_REVIEW",
                "VERIFIED",
              ]),
              lifecycle_status: z.enum(["ACTIVE", "RETIRED"]),
              ocr_preview_metadata: z.record(z.string(), z.unknown()),
              verified_at: z.iso.datetime({ offset: true }).nullable(),
              current_verified_revision_id: z.uuid().nullable(),
            }),
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
