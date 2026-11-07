import { z } from "zod";

export const bookContentIssueTypeSchema = z.enum([
  "BOOK_METADATA_ERROR",
  "SPELLING_ERROR",
  "MISSING_CONTENT",
  "OCR_MISMATCH",
  "IMAGE_QUALITY_ERROR",
  "DUPLICATE_PAGE",
  "PAGE_ORDER_ERROR",
  "OTHER",
]);

export const bookContentReportStatusSchema = z.enum([
  "OPEN",
  "UNDER_REVIEW",
  "RESOLVED",
  "REJECTED",
]);

export const bookQualityScanStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
]);

export const bookQualityFindingStatusSchema = z.enum([
  "NEEDS_REVIEW",
  "CONFIRMED",
  "DISMISSED",
  "RESOLVED",
  "STALE",
]);

export const bookContentReportSchema = z.object({
  id: z.guid(),
  book_id: z.guid().nullable(),
  book_title: z.string(),
  reporter_name: z.string().nullable().optional(),
  page_id: z.guid().nullable(),
  page_number: z.number().int().nullable(),
  page_revision_id: z.guid().nullable(),
  issue_type: bookContentIssueTypeSchema,
  description: z.string(),
  reported_text: z.string().nullable(),
  suggested_correction: z.string().nullable(),
  status: bookContentReportStatusSchema,
  scan_run_id: z.guid().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export const bookQualityFindingSchema = z.object({
  id: z.guid(),
  page_scan_id: z.guid(),
  book_id: z.guid().nullable(),
  page_id: z.guid().nullable(),
  page_number: z.number().int(),
  page_revision_id: z.guid().nullable(),
  issue_type: z.string(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  original_excerpt: z.string(),
  excerpt_start: z.number().int().nonnegative(),
  excerpt_end: z.number().int().nonnegative(),
  suggested_correction: z.string().nullable(),
  explanation: z.string(),
  detection_source: z.enum(["RULE", "OLLAMA_TEXT"]),
  model_name: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  status: bookQualityFindingStatusSchema,
  review_note: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
});

export const bookContentReportDetailSchema = bookContentReportSchema.extend({
  reporter_id: z.guid().nullable(),
  reporter_name: z.string().nullable(),
  verified_text_snapshot: z.string().nullable(),
  content_hash_snapshot: z.string().nullable(),
  admin_resolution_note: z.string().nullable(),
  reviewed_by: z.guid().nullable(),
  reviewed_by_name: z.string().nullable(),
  resolved_at: z.iso.datetime({ offset: true }).nullable(),
  history: z.array(
    z.object({
      actor_name: z.string().nullable(),
      from_status: bookContentReportStatusSchema.nullable(),
      to_status: bookContentReportStatusSchema,
      note: z.string().nullable(),
      created_at: z.iso.datetime({ offset: true }),
    }),
  ),
  related_findings: z.array(bookQualityFindingSchema),
});

export const bookContentReportPageSchema = z.object({
  items: z.array(bookContentReportSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const bookQualityReportAdminPageSchema = z.object({
  items: z.array(bookContentReportSchema),
  total: z.number().int().nonnegative(),
  summary: z.record(z.string(), z.number().int().nonnegative()),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const bookQualityScanSchema = z.object({
  id: z.guid(),
  book_id: z.guid().nullable(),
  book_title: z.string(),
  trigger_type: z.string(),
  scope: z.enum(["BOOK", "PAGE"]),
  target_page_id: z.guid().nullable(),
  status: bookQualityScanStatusSchema,
  total_pages: z.number().int().nonnegative(),
  completed_pages: z.number().int().nonnegative(),
  skipped_pages: z.number().int().nonnegative(),
  failed_pages: z.number().int().nonnegative(),
  ai_completed_pages: z.number().int().nonnegative(),
  ai_unavailable_pages: z.number().int().nonnegative(),
  error_summary: z.string().nullable(),
  started_at: z.iso.datetime({ offset: true }).nullable(),
  completed_at: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
});

export const bookQualityScanDetailSchema = bookQualityScanSchema.extend({
  pages: z.array(
    z.object({
      id: z.guid(),
      page_id: z.guid().nullable(),
      page_number: z.number().int(),
      page_lifecycle_status: z.string(),
      page_revision_id: z.guid().nullable(),
      content_hash: z.string().nullable(),
      status: z.string(),
      rule_check_status: z.string(),
      ai_analysis_status: z.string(),
      rejected_ai_finding_count: z.number().int().nonnegative(),
      error_code: z.string().nullable(),
      error_summary: z.string().nullable(),
      findings: z.array(bookQualityFindingSchema),
    }),
  ),
});

export const bookQualityBookSummarySchema = z.object({
  book_id: z.guid(),
  book_title: z.string(),
  report_count: z.number().int().nonnegative(),
  open_report_count: z.number().int().nonnegative(),
  finding_count: z.number().int().nonnegative(),
  needs_review_finding_count: z.number().int().nonnegative(),
  latest_scan: bookQualityScanSchema.nullable(),
});

export const bookQualityBookPageSchema = z.object({
  items: z.array(bookQualityBookSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const bookQualityBookDetailSchema = z.object({
  book_id: z.guid(),
  book_title: z.string(),
  reports: z.array(bookContentReportSchema),
  scans: z.array(bookQualityScanSchema),
  latest_scan_detail: bookQualityScanDetailSchema.nullable(),
});

export type BookContentIssueType = z.infer<typeof bookContentIssueTypeSchema>;
export type BookContentReportStatus = z.infer<typeof bookContentReportStatusSchema>;
export type BookQualityFindingStatus = z.infer<typeof bookQualityFindingStatusSchema>;
export type BookContentReportDTO = z.infer<typeof bookContentReportSchema>;
export type BookContentReportDetailDTO = z.infer<typeof bookContentReportDetailSchema>;
export type BookContentReportPageDTO = z.infer<typeof bookContentReportPageSchema>;
export type BookQualityFindingDTO = z.infer<typeof bookQualityFindingSchema>;
export type BookQualityScanDTO = z.infer<typeof bookQualityScanSchema>;
export type BookQualityScanDetailDTO = z.infer<typeof bookQualityScanDetailSchema>;
export type BookQualityBookSummaryDTO = z.infer<typeof bookQualityBookSummarySchema>;
export type BookQualityBookPageDTO = z.infer<typeof bookQualityBookPageSchema>;
export type BookQualityBookDetailDTO = z.infer<typeof bookQualityBookDetailSchema>;
export type BookQualityReportAdminPageDTO = z.infer<typeof bookQualityReportAdminPageSchema>;
