import type {
  AdminPageRevisionDetailDTO,
  AdminRevisionWordDTO,
} from "@/types/admin";

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
