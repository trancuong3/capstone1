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
  "CHILD_UNSAFE_CONTENT",
  "COPYRIGHT_CONCERN",
  "OTHER",
]);

export const contentRightsStatusSchema = z.enum([
  "NOT_ASSESSED",
  "MISSING_EVIDENCE",
  "CONCERNS_FOUND",
  "REVIEWED",
]);

export const contentRightsUsageBasisSchema = z.enum([
  "OWN_ORIGINAL",
  "WRITTEN_LICENSE",
  "PUBLIC_DOMAIN",
  "OPEN_LICENSE",
  "EDUCATIONAL_PERMISSION",
  "UNKNOWN",
  "OTHER",
]);

export const contentRightsReferenceCheckStatusSchema = z.enum([
  "NOT_RUN",
  "NO_MATCH_IN_ALLOWED_CORPUS",
  "OVERLAP_CONCERN",
]);

export const bookQualityIssueFilterSchema = z.enum([
  "MISSING_CONTENT",
  "SAFETY_ALERTS",
  "MISSING_RIGHTS",
  "OPEN_REPORTS",
  "READY_FOR_APPROVAL",
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
  current_page_revision_id: z.guid().nullable().optional().default(null),
  page_revision_changed: z.boolean().optional().default(false),
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

export const bookContentRightsProfileSchema = z.object({
  id: z.guid().nullable().default(null),
  book_id: z.guid(),
  page_id: z.guid().nullable().default(null),
  scope: z.enum(["BOOK", "PAGE_OVERRIDE"]).default("BOOK"),
  status: contentRightsStatusSchema.default("NOT_ASSESSED"),
  source_name: z.string().nullable().default(null),
  rights_holder: z.string().nullable().default(null),
  usage_basis: z.string().nullable().default(null),
  evidence_url: z.string().nullable().default(null),
  evidence_reference: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  source_fingerprint: z.string().nullable().default(null),
  profile_version: z.number().int().nonnegative().default(0),
  reference_check_status:
    contentRightsReferenceCheckStatusSchema.default("NOT_RUN"),
  reference_check_evidence: z
    .array(z.record(z.string(), z.unknown()))
    .default([]),
  reviewed_by: z.guid().nullable().default(null),
  reviewed_by_name: z.string().nullable().default(null),
  reviewed_at: z.iso.datetime({ offset: true }).nullable().default(null),
  history: z.array(z.record(z.string(), z.unknown())).default([]),
  updated_at: z.iso.datetime({ offset: true }).nullable().default(null),
});

export const bookContentRightsProfileUpsertSchema = z.object({
  status: contentRightsStatusSchema,
  source_name: z.string().max(300).nullable().optional(),
  rights_holder: z.string().max(300).nullable().optional(),
  usage_basis: contentRightsUsageBasisSchema.nullable().optional(),
  evidence_url: z.string().max(1000).nullable().optional(),
  evidence_reference: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const bookQualityPageItemSchema = z.object({
  page_id: z.guid(),
  page_number: z.number().int(),
  lifecycle_status: z.string(),
  content_type: z
    .enum(["CONTENT", "COVER_OR_IMAGE_ONLY"])
    .default("CONTENT"),
  current_verified_revision_id: z.guid().nullable().default(null),
  latest_revision_id: z.guid().nullable().default(null),
  verification_status: z.string().default("MISSING"),
  content_issues: z.array(z.string()).default([]),
  proofreading_status: z.string().default("NOT_STARTED"),
  uncertain_word_count: z.number().int().nonnegative().default(0),
  safety_status: z.string().default("NOT_STARTED"),
  safety_suitability: z.string().nullable().default(null),
  safety_finding_count: z.number().int().nonnegative().default(0),
  high_finding_count: z.number().int().nonnegative().default(0),
  image_safety_status: z.string().default("NOT_REVIEWED"),
  rights_status: contentRightsStatusSchema.default("NOT_ASSESSED"),
  has_rights_override: z.boolean().default(false),
  open_report_count: z.number().int().nonnegative().default(0),
  latest_workflow_id: z.guid().nullable().default(null),
  has_issues: z.boolean().default(false),
});

export const bookApprovalStatusSchema = z.enum([
  "PROCESSING",
  "SCAN_FAILED",
  "PENDING_ADMIN_REVIEW",
  "READY_FOR_CHILDREN",
  "PUBLISHED",
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
  rights_profile_status: contentRightsStatusSchema.optional().default("NOT_ASSESSED"),
  rights_profile_version: z.number().int().nonnegative().nullable().optional().default(null),
  rights_profile_hash: z.string().nullable().optional().default(null),
  legacy_published_needs_rights_review: z.boolean().optional().default(false),
  expected_page_count: z.number().int().positive().nullable().optional().default(null),
  expected_page_count_status: z
    .enum([
      "MATCHED",
      "UNDER_EXPECTED",
      "OVER_EXPECTED",
      "UNKNOWN_SOURCE_PAGE_COUNT",
    ])
    .optional()
    .default("UNKNOWN_SOURCE_PAGE_COUNT"),
  missing_page_numbers: z.array(z.number().int()).optional().default([]),
  duplicate_page_numbers: z.array(z.number().int()).optional().default([]),
  empty_ocr_page_numbers: z.array(z.number().int()).optional().default([]),
  missing_image_page_numbers: z.array(z.number().int()).optional().default([]),
  image_only_page_numbers: z.array(z.number().int()).optional().default([]),
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
  publication_source: z
    .enum(["AUTO_APPROVAL", "ADMIN_APPROVAL"])
    .nullable()
    .default(null),
  rights_confirmed: z.boolean(),
  blockers: z.array(z.string()),
});

export const bookQualityBookSummarySchema = z.object({
  book_id: z.guid(),
  book_title: z.string(),
  report_count: z.number().int().nonnegative(),
  open_report_count: z.number().int().nonnegative(),
  open_safety_report_count: z.number().int().nonnegative().optional().default(0),
  finding_count: z.number().int().nonnegative(),
  needs_review_finding_count: z.number().int().nonnegative(),
  verified_page_count: z.number().int().nonnegative().optional().default(0),
  issue_page_count: z.number().int().nonnegative().optional().default(0),
  has_missing_content: z.boolean().optional().default(false),
  has_safety_alerts: z.boolean().optional().default(false),
  has_missing_rights: z.boolean().optional().default(false),
  ready_for_approval: z.boolean().optional().default(false),
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
  issue_filter_summary: z
    .record(z.string(), z.number().int().nonnegative())
    .optional()
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
  expected_page_count: z.number().int().positive().nullable().optional().default(null),
  reports: z.array(bookContentReportSchema),
  scans: z.array(bookQualityScanSchema),
  latest_scan_detail: bookQualityScanDetailSchema.nullable(),
  ai_workflows: z.array(adminAiWorkflowSchema).default([]),
  ai_workflow_summary: z
    .record(z.string(), z.number().int().nonnegative())
    .default({}),
  rights_profile: bookContentRightsProfileSchema.nullable().optional().default(null),
  page_rights_overrides: z.array(bookContentRightsProfileSchema).optional().default([]),
  pages: z.array(bookQualityPageItemSchema).optional().default([]),
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
export type ContentRightsStatus = z.infer<typeof contentRightsStatusSchema>;
export type ContentRightsUsageBasis = z.infer<
  typeof contentRightsUsageBasisSchema
>;
export type ContentRightsReferenceCheckStatus = z.infer<
  typeof contentRightsReferenceCheckStatusSchema
>;
export type BookQualityIssueFilter = z.infer<
  typeof bookQualityIssueFilterSchema
>;
export type BookContentRightsProfileDTO = z.infer<
  typeof bookContentRightsProfileSchema
>;
export type BookContentRightsProfileUpsert = z.infer<
  typeof bookContentRightsProfileUpsertSchema
>;
export type BookQualityPageItemDTO = z.infer<typeof bookQualityPageItemSchema>;
