import type { ProgressReportDTO, ReportDateWindow } from "@/types/reports";
import { z } from "zod";
import { apiQuery, requestApi } from "@/lib/api/api-client";
import { difficultWordSchema } from "@/lib/api/difficult-word-service";

export interface ReportService {
  get(childId: string, window?: ReportDateWindow): Promise<ProgressReportDTO>;
}

const periodSchema = z.object({
  completed_sessions: z.number().int().nonnegative(),
  reading_duration_ms: z.number().int().nonnegative(),
  omission_count: z.number().int().nonnegative(),
  repetition_count: z.number().int().nonnegative(),
  long_pause_count: z.number().int().nonnegative(),
  omission_rate: z.number().nullable(),
  repetition_rate: z.number().nullable(),
  long_pause_rate: z.number().nullable(),
  comprehension_accuracy: z.number().nullable(),
});
const reportSchema = periodSchema.extend({
  child_id: z.uuid(),
  period_start: z.iso.date(),
  period_end: z.iso.date(),
  difficult_words: z.array(difficultWordSchema),
  previous_period: periodSchema.nullable(),
  trend_deltas: z.object({
    completed_sessions: z.number().nullable(),
    reading_duration_ms: z.number().nullable(),
    omission_rate: z.number().nullable(),
    repetition_rate: z.number().nullable(),
    long_pause_rate: z.number().nullable(),
    comprehension_accuracy: z.number().nullable(),
  }),
});

export function createReportService(): ReportService {
  return {
    get: (childId, window) =>
      requestApi(
        `/system/progress/${encodeURIComponent(childId)}${apiQuery({ period_start: window?.period_start, period_end: window?.period_end })}`,
        reportSchema.refine(
          (report) =>
            report.child_id === childId &&
            report.period_start <= report.period_end &&
            (!window ||
              (report.period_start === window.period_start &&
                report.period_end === window.period_end)),
        ),
      ),
  };
}
