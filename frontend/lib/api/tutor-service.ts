import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";
import { ServiceError } from "@/lib/api/service-error";
import type { TutorAction } from "@/types/reading";
import type {
  TutorExplanationDTO,
  TutorExplainWordRequest,
} from "@/types/tutor";

const requestSchema = z.strictObject({
  page_revision_id: z.uuid(),
  word_id: z.uuid(),
});

const explanationSchema = z.strictObject({
  page_revision_id: z.uuid(),
  word_id: z.uuid(),
  word: z.string().trim().min(1).max(500),
  explanation: z.string().trim().min(1).max(600),
  reading_hint: z.string().trim().min(1).max(180),
});

function invalidTutorRequest(status: number): ServiceError {
  return new ServiceError({
    code: status === 409 ? "CONTENT_INACTIVE" : "VALIDATION_ERROR",
    status,
    message: "Bé hãy chọn lại một từ trên trang đang đọc nhé.",
    request_id: "",
    retryable: false,
  });
}

export interface TutorService {
  explainWord(
    sessionId: string,
    input: TutorExplainWordRequest,
    signal?: AbortSignal,
  ): Promise<TutorExplanationDTO>;
  requestReadExample(sessionId: string, wordId: string): Promise<TutorAction>;
  retryReadExample(action: TutorAction): Promise<TutorAction>;
}

export function createTutorService(): TutorService {
  return {
    async explainWord(sessionId, input, signal) {
      const parsed = requestSchema.safeParse(input);
      if (!z.uuid().safeParse(sessionId).success || !parsed.success) {
        throw invalidTutorRequest(422);
      }
      const result = await requestApi(
        `/tutor/sessions/${encodeURIComponent(sessionId)}/explain-word`,
        explanationSchema,
        signal,
        { method: "POST", body: parsed.data },
      );
      if (
        result.word_id !== parsed.data.word_id ||
        result.page_revision_id !== parsed.data.page_revision_id
      ) {
        throw invalidTutorRequest(409);
      }
      return result;
    },

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
