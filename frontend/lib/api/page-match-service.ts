import { requestApi } from "@/lib/api/api-client";
import { readingPageDtoSchema } from "@/lib/api/reading-service";
import type { ReadingPageDTO } from "@/types/reading";

export interface PageMatchService {
  retryCurrentPage(sessionId: string): Promise<ReadingPageDTO>;
  selectPage(
    sessionId: string,
    selectedPageId: string,
  ): Promise<ReadingPageDTO>;
}

export function createPageMatchService(): PageMatchService {
  return {
    async retryCurrentPage(sessionId: string): Promise<ReadingPageDTO> {
      return requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/page`,
        readingPageDtoSchema,
      );
    },

    async selectPage(
      sessionId: string,
      selectedPageId: string,
    ): Promise<ReadingPageDTO> {
      const query = new URLSearchParams({ session_id: sessionId });
      return requestApi(
        `/reading/pages/${encodeURIComponent(selectedPageId)}?${query.toString()}`,
        readingPageDtoSchema,
      );
    },
  };
}
