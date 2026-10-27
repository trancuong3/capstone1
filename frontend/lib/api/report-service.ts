import type {
  ProgressReportDTO,
  ProgressPeriodsDTO,
  ReportDateWindow,
} from "@/types/reports";
import { z } from "zod";
import { apiQuery, requestApi } from "@/lib/api/api-client";
import { difficultWordSchema } from "@/lib/api/difficult-word-service";

export interface ReportService {
  get(childId: string, window?: ReportDateWindow): Promise<ProgressReportDTO>;
  listPeriods(
    childId: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<ProgressPeriodsDTO>;
}

const periodSchema = z.object({
  completed_sessions: z.number().int().nonnegative().nullable(),
  reading_duration_ms: z.number().int().nonnegative().nullable(),
  omission_count: z.number().int().nonnegative().nullable(),
  repetition_count: z.number().int().nonnegative().nullable(),
  long_pause_count: z.number().int().nonnegative().nullable(),
  omission_rate: z.number().min(0).max(100).nullable(),
  repetition_rate: z.number().min(0).max(100).nullable(),
  long_pause_rate: z.number().min(0).max(100).nullable(),
  comprehension_accuracy: z.number().min(0).max(100).nullable(),
});
const availability = z.enum(["available", "absent", "partial", "unsupported"]);
const periodOptionSchema = z
  .object({
    id: z.uuid(),
    child_id: z.uuid(),
    period_start: z.iso.date(),
    period_end: z.iso.date(),
    generated_at: z.iso.datetime({ offset: true }),
  })
  .refine((item) => item.period_start <= item.period_end);
const reportSchema = periodSchema.extend({
  id: z.uuid(),
  generated_at: z.iso.datetime({ offset: true }),
  child_id: z.uuid(),
  period_start: z.iso.date(),
  period_end: z.iso.date(),
  difficult_words: z.array(difficultWordSchema).nullable(),
  previous_period: periodSchema.nullable(),
  trend_deltas: z
    .object({
      completed_sessions: z.number().nullable(),
      reading_duration_ms: z.number().nullable(),
      omission_rate: z.number().nullable(),
      repetition_rate: z.number().nullable(),
      long_pause_rate: z.number().nullable(),
      comprehension_accuracy: z.number().nullable(),
    })
    .nullable(),
  legacy: z
    .object({
      avg_fluency: z.number().nullable(),
      total_books: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  data_status: z.enum(["complete", "partial", "unsupported"]),
  availability: z.object({
    metrics: availability,
    difficult_words: availability,
    comparison: availability,
  }),
});

export function createReportService(): ReportService {
  return {
    listPeriods: (childId, options) =>
      requestApi(
        `/system/progress/${encodeURIComponent(childId)}/periods${apiQuery({ cursor: options?.cursor, limit: options?.limit })}`,
        z
          .object({
            items: z.array(periodOptionSchema),
            next_cursor: z
              .string()
              .regex(/^page-[1-9][0-9]{0,5}$/)
              .nullable(),
          })
          .refine(
            (page) =>
              page.items.every((item) => item.child_id === childId) &&
              new Set(
                page.items.map(
                  (item) => `${item.period_start}/${item.period_end}`,
                ),
              ).size === page.items.length &&
              (page.next_cursor === null ||
                Number(page.next_cursor.slice(5)) <= 100000),
          ),
      ),
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
