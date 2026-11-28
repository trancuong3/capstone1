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
  "CHILD_SAFETY_CONCERN",
  "COPYRIGHT_CONCERN",
  "OTHER",
]);

export const bookRightsStatusSchema = z.enum([
  "UNASSESSED",
  "INSUFFICIENT_EVIDENCE",
  "CONCERN_FLAGGED",
  "RIGHTS_REVIEWED",
]);

export const bookRightsScopeSchema = z.enum(["BOOK", "PAGE"]);

export const bookPageDiagnosticCodeSchema = z.enum([
  "OK",
  "MISSING_IMAGE",
  "EMPTY_OCR",
  "OCR_ERROR",
  "DUPLICATE_PAGE",
  "SUSPECTED_MISSING_PAGE",
  "UNVERIFIED_PAGE",
  "IMAGE_ONLY_PAGE",
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
  progress_pct: z.number().min(0).max(100).nullable().optional(),
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
  "PUBLISHED",
  "APPROVED_BY_ADMIN",
  "REJECTED_FOR_CHILDREN",
  "STALE",
]);

export const bookReadabilitySchema = z.object({
  syllable_count: z.number().int().nonnegative(),
  sentence_count: z.number().int().nonnegative(),
  avg_syllables_per_sentence: z.number().nonnegative(),
  complex_phonics_ratio: z.number().nonnegative(),
  multisyllable_ratio: z.number().nonnegative(),
  decodable_syllable_ratio: z.number().nonnegative(),
  estimated_grade_band: z.enum([
    "GRADE_1",
    "GRADE_2",
    "GRADE_3",
    "GRADE_4_5",
    "UNRATED",
  ]),
  estimated_min_grade: z.number().int().min(1).max(5),
  estimated_max_grade: z.number().int().min(1).max(5),
  grade_match_status: z.enum(["MATCHED", "TOO_HARD", "TOO_EASY", "UNRATED"]),
  phonics_readiness_score: z.number().nonnegative(),
  sample_complex_syllables: z.array(z.string()).optional(),
  explanation_vi: z.string().optional(),
});
export type BookReadabilityDTO = z.infer<typeof bookReadabilitySchema>;

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
  publication_source: z
    .enum(["AUTO_APPROVAL", "ADMIN_APPROVAL"])
    .nullable()
    .default(null),
  rights_confirmed: z.boolean(),
  blockers: z.array(z.string()),
  readability: bookReadabilitySchema.nullable().optional(),
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

export const bookRightsEvidenceHistorySchema = z.object({
  id: z.guid(),
  version: z.number().int().positive(),
  from_status: z.string().nullable(),
  to_status: bookRightsStatusSchema,
  source_description: z.string().nullable().optional(),
  author_or_rights_holder: z.string().nullable().optional(),
  usage_basis: z.string().nullable().optional(),
  evidence_url_or_ref: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  content_fingerprint: z.string().nullable().optional(),
  actor_id: z.guid().nullable().optional(),
  actor_name: z.string().nullable().optional(),
  created_at: z.iso.datetime({ offset: true }),
});

export const bookRightsEvidenceSchema = z.object({
  id: z.guid().nullable().optional(),
  book_id: z.guid(),
  page_id: z.guid().nullable().optional(),
  scope: bookRightsScopeSchema.default("BOOK"),
  status: bookRightsStatusSchema.default("UNASSESSED"),
  effective_status: z.string().default("UNASSESSED"),
  is_stale: z.boolean().default(false),
  source_description: z.string().nullable().optional(),
  author_or_rights_holder: z.string().nullable().optional(),
  usage_basis: z.string().nullable().optional(),
  evidence_url_or_ref: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  version: z.number().int().nonnegative().default(0),
  content_fingerprint: z.string().nullable().optional(),
  current_content_fingerprint: z.string().nullable().optional(),
  reviewed_by: z.guid().nullable().optional(),
  reviewed_by_name: z.string().nullable().optional(),
  reviewed_at: z.iso.datetime({ offset: true }).nullable().optional(),
  updated_at: z.iso.datetime({ offset: true }).nullable().optional(),
  history: z.array(bookRightsEvidenceHistorySchema).default([]),
});

export const bookRightsEvidenceUpsertSchema = z.object({
  scope: bookRightsScopeSchema.default("BOOK"),
  page_id: z.guid().nullable().optional(),
  status: bookRightsStatusSchema,
  source_description: z.string().max(500).nullable().optional(),
  author_or_rights_holder: z.string().max(300).nullable().optional(),
  usage_basis: z.string().max(120).nullable().optional(),
  evidence_url_or_ref: z.string().max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const bookPageDiagnosticSchema = z.object({
  page_id: z.guid().nullable().optional(),
  page_number: z.number().int(),
  lifecycle_status: z.string().nullable().optional(),
  verification_status: z.string().nullable().optional(),
  codes: z.array(bookPageDiagnosticCodeSchema).default([]),
  image_safety_status: z.string().nullable().optional(),
  text_safety_status: z.string().nullable().optional(),
  summary: z.string(),
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
  rights_evidence: bookRightsEvidenceSchema.nullable().optional(),
  page_diagnostics: z.array(bookPageDiagnosticSchema).optional().default([]),
  completeness_disclaimer: z.string().optional(),
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
export type BookRightsStatus = z.infer<typeof bookRightsStatusSchema>;
export type BookRightsScope = z.infer<typeof bookRightsScopeSchema>;
export type BookRightsEvidenceDTO = z.infer<typeof bookRightsEvidenceSchema>;
export type BookRightsEvidenceUpsertRequest = z.input<
  typeof bookRightsEvidenceUpsertSchema
>;
export type BookPageDiagnosticCode = z.infer<
  typeof bookPageDiagnosticCodeSchema
>;
export type BookPageDiagnosticDTO = z.infer<typeof bookPageDiagnosticSchema>;
