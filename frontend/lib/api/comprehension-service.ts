import type {
  ComprehensionAnswerResultDTO,
  ComprehensionQuestionViewModelUI,
} from "@/types/reading";

export interface ComprehensionService {
  /** Creates the AI tutor questions for a finished session; resolves to the count. */
  prepareQuestions?(sessionId: string): Promise<number>;
  getQuestion(sessionId: string): Promise<ComprehensionQuestionViewModelUI>;
  submitAnswer(
    sessionId: string,
    questionId: string,
    answer: string,
  ): Promise<ComprehensionAnswerResultDTO>;
}
