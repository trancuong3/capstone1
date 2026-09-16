import type {
  ComprehensionAnswerResultDTO,
  ComprehensionQuestionViewModelUI,
} from "@/types/reading";

export interface ComprehensionService {
  getQuestion(sessionId: string): Promise<ComprehensionQuestionViewModelUI>;
  submitAnswer(
    sessionId: string,
    questionId: string,
    answer: string,
  ): Promise<ComprehensionAnswerResultDTO>;
}
