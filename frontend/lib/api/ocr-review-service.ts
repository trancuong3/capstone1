import type {
  AdminPageRevisionDetailDTO,
  AdminRevisionWordDTO,
} from "@/types/admin";
import { z } from "zod";
import { requestApi, unavailableOperation } from "@/lib/api/api-client";

export interface OcrReviewService {
  getRevision(
    pageId: string,
    revisionId: string,
  ): Promise<AdminPageRevisionDetailDTO>;
  saveDraft(
    pageId: string,
    revisionId: string,
    draftText: string,
    words: readonly AdminRevisionWordDTO[],
  ): Promise<AdminPageRevisionDetailDTO>;
}

const revisionSchema = z.object({
  page_id: z.uuid(),
  page_revision_id: z.uuid(),
  revision_no: z.number().int().positive(),
  verification_status: z.enum(["PROCESSING", "NEEDS_REVIEW", "VERIFIED"]),
  lifecycle_status: z.enum(["ACTIVE", "RETIRED"]),
  draft_text: z.string().nullable(),
  words: z.array(
    z.object({
      word_index: z.number().int().nonnegative(),
      line_index: z.number().int().nonnegative(),
      text: z.string(),
      normalized_text: z.string(),
      bbox: z.tuple([
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
      ]),
      ocr_confidence: z.number().min(0).max(1).nullable(),
    }),
  ),
  ocr_metadata: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime({ offset: true }),
  verified_at: z.iso.datetime({ offset: true }).nullable(),
  verified_by: z.uuid().nullable(),
});

export function createOcrReviewService(): OcrReviewService {
  return {
    getRevision: (pageId, revisionId) =>
      requestApi(
        `/books/admin/pages/${encodeURIComponent(pageId)}/revisions/${encodeURIComponent(revisionId)}`,
        revisionSchema.refine(
          (item) =>
            item.page_id === pageId && item.page_revision_id === revisionId,
        ),
      ),
    saveDraft: unavailableOperation,
  };
}
