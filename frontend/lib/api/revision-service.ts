import type {
  AdminPageProcessingDTO,
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
  AdminRevisionVerifyRequestDTO,
} from "@/types/admin";
import { z } from "zod";
import { requestApi, unavailableOperation } from "@/lib/api/api-client";

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
    verify: unavailableOperation,
    reprocess: unavailableOperation,
  };
}
