import type { TutorAction } from "@/types/reading";

export interface TutorService {
  requestReadExample(sessionId: string, wordId: string): Promise<TutorAction>;
  retryReadExample(action: TutorAction): Promise<TutorAction>;
}
