import type {
  ReadingSessionDetailDTO,
  SessionHistoryResponseDTO,
} from "@/types/reading";

export interface SessionHistoryQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SessionService {
  list(
    childId: string,
    query?: SessionHistoryQuery,
  ): Promise<SessionHistoryResponseDTO>;
  get(sessionId: string): Promise<ReadingSessionDetailDTO>;
}
