import type { ReadingPageDTO } from "@/types/reading";

export interface PageMatchService {
  retryCurrentPage(sessionId: string): Promise<ReadingPageDTO>;
  selectPage(
    sessionId: string,
    selectedPageId: string,
  ): Promise<ReadingPageDTO>;
}
