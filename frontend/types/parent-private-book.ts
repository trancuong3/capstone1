import { z } from "zod";

export const sourceUsageTypeSchema = z.enum([
  "SELF_AUTHORED",
  "OWNED_PHYSICAL_BOOK",
  "PUBLIC_DOMAIN",
  "LICENSED_OR_PERMISSION",
  "OTHER",
]);
export type SourceUsageType = z.infer<typeof sourceUsageTypeSchema>;

export const submissionWorkflowStatusSchema = z.enum([
  "CHECKING",
  "PASSED_READY_TO_ADD",
  "NEEDS_ADMIN_REVIEW",
  "CHECK_FAILED",
  "PENDING_ADMIN",
  "APPROVED_READY_TO_ADD",
  "REJECTED",
  "NEEDS_RECHECK",
  "ADDED_TO_BOOK",
  "CANCELLED",
]);
export type SubmissionWorkflowStatus = z.infer<
  typeof submissionWorkflowStatusSchema
>;

export const adminUserBookQueueFilterSchema = z.enum([
  "PENDING_ADMIN",
  "FLAGGED",
  "CHECK_FAILED",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
]);
export type AdminUserBookQueueFilter = z.infer<
  typeof adminUserBookQueueFilterSchema
>;

export const adminUserBookDecisionTypeSchema = z.enum([
  "APPROVE",
  "REQUEST_CHANGES",
  "REJECT",
  "SUSPEND",
]);
export type AdminUserBookDecisionType = z.infer<
  typeof adminUserBookDecisionTypeSchema
>;

export const SOURCE_USAGE_OPTIONS: ReadonlyArray<{
  readonly value: SourceUsageType;
  readonly label: string;
}> = [
  {
    value: "OWNED_PHYSICAL_BOOK",
    label: "Sách giấy gia đình đã mua để con luyện đọc tại nhà",
  },
  {
    value: "SELF_AUTHORED",
    label: "Tự biên soạn / gia đình tự viết",
  },
  {
    value: "PUBLIC_DOMAIN",
    label: "Tác phẩm thuộc phạm vi công cộng",
  },
  {
    value: "LICENSED_OR_PERMISSION",
    label: "Có giấy phép hoặc sự đồng ý của tác giả/nhà xuất bản",
  },
  {
    value: "OTHER",
    label: "Nguồn khác (cần ghi rõ căn cứ)",
  },
];

export const ADMIN_USER_BOOK_FILTER_LABELS: Record<
  AdminUserBookQueueFilter,
  string
> = {
  PENDING_ADMIN: "Chờ duyệt",
  FLAGGED: "Có cảnh báo",
  CHECK_FAILED: "Kiểm tra lỗi",
  APPROVED: "Đã duyệt",
  REJECTED: "Bị từ chối",
  SUSPENDED: "Đang đình chỉ",
};

const safeMediaUrlSchema = z.string().min(1).refine((value) => {
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
});

export const toolCheckScopeSchema = z.object({
  modality: z.string(),
  covers_all_chunks: z.boolean(),
  chunks_checked: z.number().int(),
  total_chunks: z.number().int(),
  image_visual_safety_checked: z.boolean(),
  requires_admin_visual_review: z.boolean(),
  copyright_scanner_status: z.string(),
  local_ai_enforced: z.boolean(),
});
export type ToolCheckScopeDTO = z.infer<typeof toolCheckScopeSchema>;

export const proofreadSuggestionSchema = z.object({
  word_index: z.number().int().nonnegative(),
  original: z.string(),
  suggested: z.string(),
  uncertain: z.boolean(),
});
export type ProofreadSuggestionDTO = z.infer<typeof proofreadSuggestionSchema>;

export const providerEventSummarySchema = z.object({
  provider: z.string(),
  model: z.string().nullable().optional(),
  stage: z.string(),
  chunk_id: z.number().int().nullable().optional(),
  availability: z.boolean().nullable().optional(),
  error_code: z.string().nullable().optional(),
  duration_ms: z.number().int().nullable().optional(),
});
export type ProviderEventSummaryDTO = z.infer<typeof providerEventSummarySchema>;

export const toolCheckFindingSchema = z.object({
  finding_id: z.string().nullable().optional(),
  source: z.string(),
  category: z.string(),
  severity: z.string(),
  content_type: z.string().nullable().optional(),
  excerpt: z.string(),
  explanation: z.string(),
  recommendation: z.string().nullable().optional(),
});
export type ToolCheckFindingDTO = z.infer<typeof toolCheckFindingSchema>;

export const parentPrivatePageSchema = z.object({
  page_id: z.guid(),
  page_number: z.number().int().positive(),
  current_verified_revision_id: z.guid().nullable(),
  verified_text_preview: z.string(),
  image_url: safeMediaUrlSchema,
  created_at: z.string(),
});
export type ParentPrivatePageDTO = z.infer<typeof parentPrivatePageSchema>;

export const parentPageSubmissionSchema = z.object({
  id: z.guid(),
  book_id: z.guid(),
  batch_id: z.guid(),
  batch_total_pages: z.number().int().positive(),
  source_page_number: z.number().int().positive(),
  target_page_number: z.number().int().positive().nullable(),
  source_file_name: z.string(),
  source_format: z.string(),
  image_width: z.number().int().positive(),
  image_height: z.number().int().positive(),
  image_url: safeMediaUrlSchema,
  source_type: sourceUsageTypeSchema,
  source_type_label: z.string(),
  source_note: z.string().nullable(),
  submission_version: z.number().int().positive(),
  optimistic_lock_version: z.number().int().positive(),
  workflow_status: submissionWorkflowStatusSchema,
  workflow_status_label: z.string(),
  ocr_status: z.string(),
  ocr_text: z.string().nullable(),
  ocr_error_code: z.string().nullable(),
  is_image_only: z.boolean(),
  proofread_status: z.string(),
  proofread_text: z.string().nullable(),
  proofread_suggestions: z.array(proofreadSuggestionSchema),
  uncertain_word_indices: z.array(z.number().int()),
  proofread_error_code: z.string().nullable(),
  spelling_accepted: z.boolean(),
  candidate_text: z.string().nullable(),
  candidate_hash: z.string().nullable(),
  tool_check_status: z.string(),
  tool_check_suitability: z.string().nullable(),
  tool_check_scope: toolCheckScopeSchema,
  tool_check_findings_count: z.number().int().nonnegative(),
  tool_check_parent_notice: z.string().nullable(),
  tool_check_policy_blocked: z.boolean(),
  tool_check_workflow_id: z.guid().nullable(),
  tool_check_error_code: z.string().nullable(),
  provider_events: z.array(providerEventSummarySchema),
  can_add_to_book: z.boolean(),
  can_request_admin_review: z.boolean(),
  can_retry: z.boolean(),
  admin_decision: z.string().nullable(),
  admin_decision_reason: z.string().nullable(),
  approved_snapshot_hash: z.string().nullable(),
  approved_submission_version: z.number().int().nullable(),
  committed_page_id: z.guid().nullable(),
  committed_revision_id: z.guid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ParentPageSubmissionDTO = z.infer<typeof parentPageSubmissionSchema>;

export const parentPrivateBookSummarySchema = z.object({
  id: z.guid(),
  title: z.string(),
  author: z.string().nullable(),
  min_grade: z.number().int().min(1).max(5),
  max_grade: z.number().int().min(1).max(5),
  lifecycle_status: z.enum(["ACTIVE", "RETIRED"]),
  visibility_scope: z.literal("PARENT_PRIVATE"),
  moderation_status: z.enum(["ACTIVE", "SUSPENDED"]),
  suspended_reason: z.string().nullable(),
  source_declaration: z.string().nullable(),
  committed_page_count: z.number().int().nonnegative(),
  pending_submission_count: z.number().int().nonnegative(),
  flagged_submission_count: z.number().int().nonnegative(),
  failed_submission_count: z.number().int().nonnegative(),
  ready_to_add_count: z.number().int().nonnegative(),
  readable_for_children: z.boolean(),
  has_held_multipage_batch: z.boolean(),
  privacy_notice: z.string(),
  created_at: z.string(),
});
export type ParentPrivateBookSummaryDTO = z.infer<
  typeof parentPrivateBookSummarySchema
>;

export const parentPrivateBookDetailSchema = z.object({
  book: parentPrivateBookSummarySchema,
  pages: z.array(parentPrivatePageSchema),
  submissions: z.array(parentPageSubmissionSchema),
});
export type ParentPrivateBookDetailDTO = z.infer<
  typeof parentPrivateBookDetailSchema
>;

export const parentSubmitPagesResponseSchema = z.object({
  book_id: z.guid(),
  batch_id: z.guid(),
  source_format: z.string(),
  total_pages: z.number().int().positive(),
  replayed_idempotency: z.boolean(),
  submissions: z.array(parentPageSubmissionSchema),
});
export type ParentSubmitPagesResponseDTO = z.infer<
  typeof parentSubmitPagesResponseSchema
>;

export const parentAddPageResponseSchema = z.object({
  book_id: z.guid(),
  page_id: z.guid(),
  page_number: z.number().int().positive(),
  revision_id: z.guid(),
  submission: parentPageSubmissionSchema,
  book_readable_for_children: z.boolean(),
});
export type ParentAddPageResponseDTO = z.infer<
  typeof parentAddPageResponseSchema
>;

export const adminUserBookQueueItemSchema = z.object({
  book_id: z.guid(),
  book_title: z.string(),
  book_author: z.string().nullable(),
  owner_label: z.string(),
  moderation_status: z.enum(["ACTIVE", "SUSPENDED"]),
  queue_status: adminUserBookQueueFilterSchema,
  pending_count: z.number().int().nonnegative(),
  flagged_count: z.number().int().nonnegative(),
  failed_count: z.number().int().nonnegative(),
  committed_page_count: z.number().int().nonnegative(),
  latest_submission_id: z.guid().nullable(),
  latest_request_id: z.guid().nullable(),
  latest_submission_version: z.number().int().nullable(),
  latest_submitted_at: z.string(),
  policy_blocked: z.boolean(),
});
export type AdminUserBookQueueItemDTO = z.infer<
  typeof adminUserBookQueueItemSchema
>;

export const adminUserBookQueuePageSchema = z.object({
  items: z.array(adminUserBookQueueItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  summary: z.record(z.string(), z.number().int().nonnegative()),
});
export type AdminUserBookQueuePageDTO = z.infer<
  typeof adminUserBookQueuePageSchema
>;

export const adminModerationHistoryItemSchema = z.object({
  request_id: z.guid(),
  submission_version: z.number().int().positive(),
  snapshot_hash: z.string(),
  status: z.string(),
  previous_status: z.string().nullable(),
  parent_source_type: z.string(),
  parent_source_note: z.string().nullable(),
  parent_request_note: z.string().nullable(),
  decision_reason: z.string().nullable(),
  decided_by_label: z.string().nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
});
export type AdminModerationHistoryItemDTO = z.infer<
  typeof adminModerationHistoryItemSchema
>;

export const adminUserBookSubmissionDetailSchema = z.object({
  submission_id: z.guid(),
  request_id: z.guid().nullable(),
  book_id: z.guid(),
  book_title: z.string(),
  book_author: z.string().nullable(),
  book_moderation_status: z.enum(["ACTIVE", "SUSPENDED"]),
  book_suspended_reason: z.string().nullable(),
  owner_label: z.string(),
  source_file_name: z.string(),
  source_format: z.string(),
  source_page_number: z.number().int().positive(),
  batch_total_pages: z.number().int().positive(),
  submission_version: z.number().int().positive(),
  optimistic_lock_version: z.number().int().positive(),
  snapshot_hash: z.string().nullable(),
  source_sha256: z.string(),
  image_width: z.number().int().positive(),
  image_height: z.number().int().positive(),
  image_url: safeMediaUrlSchema,
  workflow_status: submissionWorkflowStatusSchema,
  workflow_status_label: z.string(),
  request_status: z.string().nullable(),
  ocr_status: z.string(),
  ocr_text: z.string().nullable(),
  ocr_error_code: z.string().nullable(),
  is_image_only: z.boolean(),
  proofread_status: z.string(),
  proofread_text: z.string().nullable(),
  proofread_suggestions: z.array(proofreadSuggestionSchema),
  uncertain_word_indices: z.array(z.number().int()),
  proofread_error_code: z.string().nullable(),
  candidate_text: z.string().nullable(),
  tool_check_status: z.string(),
  tool_check_suitability: z.string().nullable(),
  tool_check_scope: toolCheckScopeSchema,
  tool_check_findings: z.array(toolCheckFindingSchema),
  tool_check_policy_blocked: z.boolean(),
  tool_check_error_code: z.string().nullable(),
  tool_check_workflow_id: z.guid().nullable(),
  provider_events: z.array(providerEventSummarySchema),
  source_type: sourceUsageTypeSchema,
  source_type_label: z.string(),
  source_note: z.string().nullable(),
  parent_request_note: z.string().nullable(),
  can_approve: z.boolean(),
  approve_blocked_reason: z.string().nullable(),
  approved_snapshot_hash: z.string().nullable(),
  approved_submission_version: z.number().int().nullable(),
  admin_decision: z.string().nullable(),
  admin_decision_reason: z.string().nullable(),
  history: z.array(adminModerationHistoryItemSchema),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AdminUserBookSubmissionDetailDTO = z.infer<
  typeof adminUserBookSubmissionDetailSchema
>;

export const adminUserBookDecisionResponseSchema = z.object({
  submission_id: z.guid(),
  book_id: z.guid(),
  decision: adminUserBookDecisionTypeSchema,
  previous_status: z.string(),
  new_workflow_status: submissionWorkflowStatusSchema,
  book_moderation_status: z.enum(["ACTIVE", "SUSPENDED"]),
  approved_snapshot_hash: z.string().nullable(),
  approved_submission_version: z.number().int().nullable(),
  optimistic_lock_version: z.number().int().positive(),
  decided_at: z.string(),
  reason: z.string(),
  audit_log_id: z.guid(),
});
export type AdminUserBookDecisionResponseDTO = z.infer<
  typeof adminUserBookDecisionResponseSchema
>;
