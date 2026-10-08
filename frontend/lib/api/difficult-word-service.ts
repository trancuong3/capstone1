import type {
  DifficultWordDTO,
  DifficultWordPracticeResultUI,
  ReportDateWindow,
} from "@/types/reports";
import { z } from "zod";
import {
  apiQuery,
  requestApi,
  unavailableOperation,
} from "@/lib/api/api-client";

export interface DifficultWordService {
  list(childId: string, window?: ReportDateWindow): Promise<DifficultWordDTO[]>;
  practice(
    childId: string,
    normalizedWord: string,
  ): Promise<DifficultWordPracticeResultUI>;
}

export const difficultWordSchema = z.object({
  normalized_word: z.string(),
  display_text: z.string(),
  difficulty_score: z.number(),
  omission_count: z.number().int().nonnegative(),
  repetition_count: z.number().int().nonnegative(),
  long_pause_count: z.number().int().nonnegative(),
  read_example_count: z.number().int().nonnegative(),
  session_count: z.number().int().nonnegative(),
  last_seen_at: z.iso.datetime({ offset: true }),
  evidence_word_ids: z.array(z.uuid()),
});

export function createDifficultWordService(): DifficultWordService {
  return {
    list: (childId, window) =>
      requestApi(
        `/system/difficult-words/${encodeURIComponent(childId)}${apiQuery({ period_start: window?.period_start, period_end: window?.period_end })}`,
        z.array(difficultWordSchema),
      ),
    practice: unavailableOperation,
  };
}
