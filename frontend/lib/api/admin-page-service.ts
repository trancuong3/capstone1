import type {
  AdminPageImageUI,
  AdminPageListItemUI,
  AdminPageProcessingDTO,
  AdminPageUploadInputUI,
  AdminPageUploadProgressUI,
  StatusPatchDTO,
} from "@/types/admin";

export interface AdminPageService {
  list(bookId: string): Promise<readonly AdminPageListItemUI[]>;
  getImage(pageId: string): Promise<AdminPageImageUI>;
  upload(
    bookId: string,
    pages: readonly AdminPageUploadInputUI[],
    onProgress?: (progress: AdminPageUploadProgressUI) => void,
  ): Promise<readonly AdminPageListItemUI[]>;
  reload(pageId: string): Promise<AdminPageProcessingDTO>;
  updateStatus(
    pageId: string,
    request: StatusPatchDTO,
  ): Promise<AdminPageProcessingDTO>;
}
