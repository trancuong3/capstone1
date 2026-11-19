import { z } from "zod";
import { adminAiWorkflowSchema } from "@/lib/api/ocr-review-service";

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

export const bookApprovalStatusSchema = z.enum([
  "PROCESSING",
  "SCAN_FAILED",
  "PENDING_ADMIN_REVIEW",
  "READY_FOR_CHILDREN",
  "APPROVED_BY_ADMIN",
  "REJECTED_FOR_CHILDREN",
  "STALE",
]);

export const bookApprovalAssessmentSchema = z.object({
  status: bookApprovalStatusSchema,
  page_count: z.number().int().nonnegative(),
  ocr_completed_pages: z.number().int().nonnegative(),
  ocr_approval_valid_pages: z.number().int().nonnegative(),
  proofreading_status: z.string(),
  proofreading_completed_pages: z.number().int().nonnegative(),
  proofreading_suggestion_count: z.number().int().nonnegative(),
  child_safety_status: z.string(),
  child_safety_completed_pages: z.number().int().nonnegative(),
  processing_pages: z.number().int().nonnegative(),
  failed_pages: z.number().int().nonnegative(),
  stale_pages: z.number().int().nonnegative(),
  copyright_status: z.string(),
  copyright_finding_count: z.number().int().nonnegative().nullable(),
  finding_count: z.number().int().nonnegative(),
  high_finding_count: z.number().int().nonnegative(),
  medium_finding_count: z.number().int().nonnegative(),
  warning_page_count: z.number().int().nonnegative(),
  failed_or_unscanned_page_count: z.number().int().nonnegative(),
  finding_groups: z.array(
    z.object({
      category: z.string(),
      severity: z.string(),
      finding_count: z.number().int().nonnegative(),
      page_count: z.number().int().nonnegative(),
      page_numbers: z.array(z.number().int()),
      examples: z.array(
        z.object({
          page_number: z.number().int(),
          evidence_text: z.string(),
          explanation: z.string(),
          recommendation: z.string(),
        }),
      ),
    }),
  ),
  assessment_hash: z.string(),
  assessed_at: z.iso.datetime({ offset: true }),
  admin_approved_at: z.iso.datetime({ offset: true }).nullable(),
  admin_approved_by: z.guid().nullable(),
  admin_approved_by_name: z.string().nullable(),
  admin_reason: z.string().nullable(),
  rights_confirmed: z.boolean(),
  blockers: z.array(z.string()),
});

export const bookQualityBookSummarySchema = z.object({
  book_id: z.guid(),
  book_title: z.string(),
  report_count: z.number().int().nonnegative(),
  open_report_count: z.number().int().nonnegative(),
  finding_count: z.number().int().nonnegative(),
  needs_review_finding_count: z.number().int().nonnegative(),
  latest_scan: bookQualityScanSchema.nullable(),
  assessment: bookApprovalAssessmentSchema,
});

export const bookQualityBookPageSchema = z.object({
  items: z.array(bookQualityBookSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  summary: z.record(z.string(), z.number().int().nonnegative()).default({}),
  alert_summary: z
    .record(z.string(), z.number().int().nonnegative())
    .default({}),
});

export const bookQualityBookDecisionReadSchema = z.object({
  book_id: z.guid(),
  assessment: bookApprovalAssessmentSchema,
  decision_history: z.array(
    z.object({
      action: z.string(),
      actor_id: z.string().nullable(),
      actor_name: z.string().nullable(),
      created_at: z.string().nullable(),
      reason: z.string().nullable(),
      assessment_hash: z.string().nullable(),
      category: z.string().nullable(),
      rights_confirmed: z.boolean(),
    }),
  ),
});

export const bookQualityBookDetailSchema = z.object({
  book_id: z.guid(),
  book_title: z.string(),
  reports: z.array(bookContentReportSchema),
  scans: z.array(bookQualityScanSchema),
  latest_scan_detail: bookQualityScanDetailSchema.nullable(),
  ai_workflows: z.array(adminAiWorkflowSchema).default([]),
  ai_workflow_summary: z
    .record(z.string(), z.number().int().nonnegative())
    .default({}),
  assessment: bookApprovalAssessmentSchema,
  decision_history: bookQualityBookDecisionReadSchema.shape.decision_history,
});

export const bookQualityBookDecisionRequestSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "REQUEST_RESCAN", "FALSE_POSITIVE"]),
  reason: z.string().min(1).max(2000),
  rights_confirmed: z.boolean().default(false),
  category: z.string().max(80).optional(),
});

export type BookContentIssueType = z.infer<typeof bookContentIssueTypeSchema>;
export type BookContentReportStatus = z.infer<
  typeof bookContentReportStatusSchema
>;
export type BookQualityFindingStatus = z.infer<
  typeof bookQualityFindingStatusSchema
>;
export type BookContentReportDTO = z.infer<typeof bookContentReportSchema>;
export type BookContentReportDetailDTO = z.infer<
  typeof bookContentReportDetailSchema
>;
export type BookContentReportPageDTO = z.infer<
  typeof bookContentReportPageSchema
>;
export type BookQualityFindingDTO = z.infer<typeof bookQualityFindingSchema>;
export type BookQualityScanDTO = z.infer<typeof bookQualityScanSchema>;
export type BookQualityScanDetailDTO = z.infer<
  typeof bookQualityScanDetailSchema
>;
export type BookQualityBookSummaryDTO = z.infer<
  typeof bookQualityBookSummarySchema
>;
export type BookQualityBookPageDTO = z.infer<typeof bookQualityBookPageSchema>;
export type BookQualityBookDetailDTO = z.infer<
  typeof bookQualityBookDetailSchema
>;
export type BookApprovalAssessmentDTO = z.infer<
  typeof bookApprovalAssessmentSchema
>;
export type BookApprovalStatus = z.infer<typeof bookApprovalStatusSchema>;
export type BookQualityBookDecisionReadDTO = z.infer<
  typeof bookQualityBookDecisionReadSchema
>;
export type BookQualityBookDecisionRequest = z.infer<
  typeof bookQualityBookDecisionRequestSchema
>;
export type BookQualityReportAdminPageDTO = z.infer<
  typeof bookQualityReportAdminPageSchema
>;
