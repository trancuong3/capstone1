import { z } from "zod";

export const readingAssessmentSchema = z.object({
  first_pass_correct: z.number().int().nonnegative(),
  first_pass_incorrect: z.number().int().nonnegative(),
  self_corrected_words: z.number().int().nonnegative(),
  unresolved_words: z.number().int().nonnegative(),
  retry_attempts: z.number().int().nonnegative(),
  skipped_after_retry_limit: z.number().int().nonnegative(),
  recognition_uncertain: z.number().int().nonnegative(),
});
