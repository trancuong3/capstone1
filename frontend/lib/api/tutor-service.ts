import type { TutorAction } from "@/types/reading";

export interface TutorService {
  requestReadExample(sessionId: string, wordId: string): Promise<TutorAction>;
  retryReadExample(action: TutorAction): Promise<TutorAction>;
}

export function createTutorService(): TutorService {
  return {
    async requestReadExample(
      _sessionId: string,
      wordId: string,
    ): Promise<TutorAction> {
      return {
        action: "READ_EXAMPLE",
        page_revision_word_id: wordId,
      };
    },

    async retryReadExample(action: TutorAction): Promise<TutorAction> {
      return action;
    },
  };
}
