import type {
  AdminPageProcessingDTO,
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
  AdminRevisionVerifyRequestDTO,
} from "@/types/admin";

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
