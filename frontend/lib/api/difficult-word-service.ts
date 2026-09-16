import type {
  DifficultWordDTO,
  DifficultWordPracticeResultUI,
  ReportDateWindow,
} from "@/types/reports";

export interface DifficultWordService {
  list(childId: string, window?: ReportDateWindow): Promise<DifficultWordDTO[]>;
  practice(
    childId: string,
    normalizedWord: string,
  ): Promise<DifficultWordPracticeResultUI>;
}
