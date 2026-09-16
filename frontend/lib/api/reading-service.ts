import type {
  ReadingCompletionSummaryUI,
  ReadingPageDTO,
  ReadingSessionCreateDTO,
  ReadingSessionCreateResponseDTO,
  ReadingSessionSummaryDTO,
} from "@/types/reading";

export interface ReadingService {
  create(
    input: ReadingSessionCreateDTO,
  ): Promise<ReadingSessionCreateResponseDTO>;
  get(sessionId: string): Promise<ReadingSessionSummaryDTO>;
  getCurrentPage(sessionId: string): Promise<ReadingPageDTO>;
  getCompletionSummary(sessionId: string): Promise<ReadingCompletionSummaryUI>;
  finish(sessionId: string): Promise<ReadingSessionSummaryDTO>;
}
