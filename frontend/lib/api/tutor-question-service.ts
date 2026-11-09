import { z } from "zod";

import type { ComprehensionService } from "@/lib/api/comprehension-service";
import { requestApi } from "@/lib/api/api-client";
import { ServiceError } from "@/lib/api/service-error";
import type {
  ComprehensionAnswerResultDTO,
  ComprehensionQuestionViewModelUI,
} from "@/types/reading";

/**
 * AI tutor questions. The backend generates the questions after a session is
 * finished, grades answers on the server and never returns the expected answer.
 */

const questionSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["FACTUAL", "CLOZE", "VOCABULARY"]),
  prompt: z.string().min(1),
  page_revision_id: z.string().uuid(),
  source_span: z.object({
    start_word_index: z.number().int().nonnegative(),
    end_word_index_exclusive: z.number().int().nonnegative(),
    sentence_index: z.number().int().nullable(),
  }),
  difficulty: z.number().int().min(1).max(3),
  answered: z.boolean(),
});

const generateSchema = z.object({
  session_id: z.string().uuid(),
  total: z.number().int().nonnegative(),
  source: z.enum(["AI", "RULE_BASED"]).nullable(),
  created: z.boolean(),
});

const nextSchema = z.object({
  question: questionSchema.nullable(),
  choices: z.array(
    z.object({ id: z.string().min(1), label: z.string(), value: z.string() }),
  ),
  progress_label: z.string(),
  position: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  completed: z.boolean(),
});

const answerSchema = z.object({
  answer_id: z.string().uuid(),
  question_id: z.string().uuid(),
  submitted_answer: z.string(),
  is_correct: z.boolean(),
  score: z.number(),
  feedback_code: z.enum(["CORRECT", "TRY_AGAIN"]),
});

function sessionPath(sessionId: string): string {
  return `/tutor/sessions/${encodeURIComponent(sessionId)}/questions`;
}

export function createComprehensionService(): ComprehensionService {
  return {
    /** Idempotent: returns how many questions exist for the finished session. */
    async prepareQuestions(sessionId: string): Promise<number> {
      const result = await requestApi(
        `${sessionPath(sessionId)}/generate`,
        generateSchema,
        undefined,
        { method: "POST" },
      );
      return result.total;
    },

    async getQuestion(
      sessionId: string,
    ): Promise<ComprehensionQuestionViewModelUI> {
      const next = await requestApi(
        `${sessionPath(sessionId)}/next`,
        nextSchema,
      );
      if (next.completed || next.question === null) {
        throw new ServiceError({
          code: "RESOURCE_NOT_FOUND",
          message: "Bé đã trả lời hết các câu hỏi.",
          status: 404,
          request_id: "",
          retryable: false,
        });
      }
      return {
        question: next.question,
        progress_label: next.progress_label,
        choices: next.choices,
        position: next.position,
        total: next.total,
      };
    },

    async submitAnswer(
      sessionId: string,
      questionId: string,
      answer: string,
    ): Promise<ComprehensionAnswerResultDTO> {
      const result = await requestApi(
        `${sessionPath(sessionId)}/${encodeURIComponent(questionId)}/answer`,
        answerSchema,
        undefined,
        { method: "POST", body: { answer } },
      );
      return {
        answer_id: result.answer_id,
        question_id: result.question_id,
        submitted_answer: result.submitted_answer,
        is_correct: result.is_correct,
        score: result.score,
        feedback_code: result.feedback_code,
      };
    },
  };
}
