import type {
  AdminPageRevisionDetailDTO,
  AdminRevisionWordDTO,
} from "@/types/admin";
import { z } from "zod";
import { apiQuery, requestApi } from "@/lib/api/api-client";

export const aiCorrectResponseSchema = z.object({
  corrected_text: z.string(),
});

export const aiCorrectionJobSchema = z.object({
  job_id: z.uuid(),
  page_id: z.uuid(),
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]),
  completed_chunks: z.number().int().nonnegative(),
  total_chunks: z.number().int().positive(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export type AiCorrectionJobDTO = z.infer<typeof aiCorrectionJobSchema>;

export class AiCorrectionCancelledError extends Error {
  constructor() {
    super("AI_OCR_CANCELLED");
    this.name = "AiCorrectionCancelledError";
  }
}

export type AiCorrectionProgress = Pick<
  AiCorrectionJobDTO,
  "status" | "completed_chunks" | "total_chunks"
>;

export const adminAiWorkflowSchema = z.object({
  workflow_id: z.uuid(),
  page_id: z.uuid(),
  book_id: z.uuid(),
  page_revision_id: z.uuid(),
  status: z.enum([
    "QUEUED",
    "PROOFREADING",
    "CHILD_SAFETY_SCANNING",
    "READY_FOR_ADMIN_REVIEW",
    "FAILED",
  ]),
  stage: z.enum([
    "PROOFREADING",
    "CHILD_SAFETY_SCANNING",
    "READY_FOR_ADMIN_REVIEW",
    "FAILED",
  ]),
  progress: z.object({
    completed_chunks: z.number().int().nonnegative(),
    total_chunks: z.number().int().positive(),
  }),
  attempts: z.number().int().nonnegative(),
  error_code: z.string().nullable(),
  original_ocr_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  admin_input_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  image_hash: z.string().nullable().optional().default(null),
  proofread_text: z.string().nullable(),
  proofread_output_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  corrections: z.array(z.record(z.string(), z.unknown())),
  uncertain_word_indices: z.array(z.number().int().nonnegative()),
  proofread_metadata: z.record(z.string(), z.unknown()),
  safety_metadata: z.record(z.string(), z.unknown()),
  candidate_history: z.array(z.record(z.string(), z.unknown())),
  safety_history: z.array(z.record(z.string(), z.unknown())),
  review_history: z.array(z.record(z.string(), z.unknown())),
  candidate_text: z.string().nullable(),
  candidate_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  candidate_version: z.number().int().nonnegative(),
  safety_input_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  hash_match: z.boolean(),
  suitability: z
    .enum([
      "SUITABLE",
      "SUITABLE_WITH_GUIDANCE",
      "REVIEW_REQUIRED",
      "NOT_RECOMMENDED",
    ])
    .nullable(),
  safety_status: z.enum([
    "PENDING",
    "STALE",
    "PROVISIONAL",
    "CONFIRMED",
    "AUTO_CONFIRMED",
    "FAILED",
  ]),
  image_safety_status: z
    .enum(["NOT_REVIEWED", "MANUAL_REVIEWED_SAFE", "MANUAL_REVIEWED_CONCERN"])
    .optional()
    .default("NOT_REVIEWED"),
  image_safety_reviewed_at: z.iso
    .datetime({ offset: true })
    .nullable()
    .optional()
    .default(null),
  image_safety_review_note: z.string().nullable().optional().default(null),
  rights_profile_id: z.uuid().nullable().optional().default(null),
  rights_profile_version: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .default(null),
  rights_profile_hash: z.string().nullable().optional().default(null),
  findings: z.array(z.record(z.string(), z.unknown())),
  provider_events: z.array(z.record(z.string(), z.unknown())),
  ocr_approved_at: z.iso.datetime({ offset: true }).nullable(),
  final_approved_text_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export type AdminAiWorkflowDTO = z.infer<typeof adminAiWorkflowSchema>;
export type AdminAiWorkflowProgress = Pick<
  AdminAiWorkflowDTO,
  "status" | "progress"
>;

export const adminPageVerificationBlockerSchema = z.object({
  code: z.string(),
  stage: z.enum([
    "PROOFREADING",
    "CHILD_SAFETY",
    "IMAGE_SAFETY",
    "RIGHTS",
    "REVISION",
  ]),
  message: z.string(),
});

export const adminPageVerificationReadinessSchema = z.object({
  page_id: z.uuid(),
  page_revision_id: z.uuid(),
  workflow_id: z.uuid().nullable().default(null),
  ready_to_verify: z.boolean(),
  blockers: z.array(adminPageVerificationBlockerSchema).default([]),
  proofreading_status: z.string(),
  uncertain_word_count: z.number().int().nonnegative().default(0),
  uncertain_resolved: z.boolean().default(true),
  child_safety_status: z.string(),
  child_safety_scope: z.string().default("TEXT"),
  child_safety_coverage_complete: z.boolean().default(false),
  image_safety_status: z.string().default("NOT_REVIEWED"),
  image_safety_required: z.boolean().default(false),
  page_content_type: z
    .enum(["CONTENT", "COVER_OR_IMAGE_ONLY"])
    .default("CONTENT"),
  rights_status: z
    .enum(["NOT_ASSESSED", "MISSING_EVIDENCE", "CONCERNS_FOUND", "REVIEWED"])
    .default("NOT_ASSESSED"),
  rights_scope: z.enum(["BOOK", "PAGE_OVERRIDE"]).nullable().default(null),
  rights_profile_version: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .default(null),
});

export type AdminPageVerificationBlockerDTO = z.infer<
  typeof adminPageVerificationBlockerSchema
>;
export type AdminPageVerificationReadinessDTO = z.infer<
  typeof adminPageVerificationReadinessSchema
>;

export const adminPageContentTypeSchema = z.object({
  page_id: z.uuid(),
  content_type: z.enum(["CONTENT", "COVER_OR_IMAGE_ONLY"]),
});
export type AdminPageContentTypeDTO = z.infer<
  typeof adminPageContentTypeSchema
>;

function waitForJobPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 3000);
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new AiCorrectionCancelledError());
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface OcrReviewService {
  getRevision(
    pageId: string,
    revisionId: string,
  ): Promise<AdminPageRevisionDetailDTO>;
  saveDraft(
    pageId: string,
    revisionId: string,
    draftText: string,
    words: readonly AdminRevisionWordDTO[],
  ): Promise<AdminPageRevisionDetailDTO>;
  aiCorrectText(
    pageId: string,
    draftText: string,
    words: readonly AdminRevisionWordDTO[],
    onProgress?: (progress: AiCorrectionProgress) => void,
    signal?: AbortSignal,
  ): Promise<string>;
  runCombinedWorkflow(
    pageId: string,
    revisionId: string,
    draftText: string,
    words: readonly AdminRevisionWordDTO[],
    onProgress?: (progress: AdminAiWorkflowProgress) => void,
    signal?: AbortSignal,
  ): Promise<AdminAiWorkflowDTO>;
  getLatestWorkflow(
    pageId: string,
    revisionId: string,
  ): Promise<AdminAiWorkflowDTO | null>;
  updateWorkflowCandidate(
    pageId: string,
    workflowId: string,
    candidateVersion: number,
    candidateText: string,
  ): Promise<AdminAiWorkflowDTO>;
  decideWorkflowSafety(
    pageId: string,
    workflowId: string,
    candidateHash: string,
    confirmed: boolean,
    reason?: string,
  ): Promise<AdminAiWorkflowDTO>;
  retryWorkflow(
    pageId: string,
    workflowId: string,
  ): Promise<AdminAiWorkflowDTO>;
  getVerificationReadiness(
    pageId: string,
    revisionId: string,
    workflowId?: string | null,
  ): Promise<AdminPageVerificationReadinessDTO>;
  resolveUncertainWords(
    pageId: string,
    workflowId: string,
    expectedCandidateHash: string,
    note: string,
  ): Promise<AdminAiWorkflowDTO>;
  reviewImageSafety(
    pageId: string,
    workflowId: string,
    status: "MANUAL_REVIEWED_SAFE" | "MANUAL_REVIEWED_CONCERN",
    note: string,
    pageContentType?: "CONTENT" | "COVER_OR_IMAGE_ONLY",
  ): Promise<AdminAiWorkflowDTO>;
  updatePageContentType(
    pageId: string,
    contentType: "CONTENT" | "COVER_OR_IMAGE_ONLY",
  ): Promise<AdminPageContentTypeDTO>;
}

export const adminRevisionDetailSchema = z.object({
  page_id: z.uuid(),
  page_revision_id: z.uuid(),
  revision_no: z.number().int().positive(),
  verification_status: z.enum(["PROCESSING", "NEEDS_REVIEW", "VERIFIED"]),
  lifecycle_status: z.enum(["ACTIVE", "RETIRED"]),
  original_ocr_text: z.string().nullable().optional(),
  draft_text: z.string().nullable(),
  words: z.array(
    z.object({
      word_index: z.number().int().nonnegative(),
      line_index: z.number().int().nonnegative(),
      text: z.string(),
      normalized_text: z.string(),
      bbox: z
        .tuple([
          z.number().min(0).max(1),
          z.number().min(0).max(1),
          z.number().min(0).max(1),
          z.number().min(0).max(1),
        ])
        .refine(
          ([x, y, width, height]) =>
            width > 0 && height > 0 && x + width <= 1 && y + height <= 1,
          "Bounding box must have positive size and remain within the image.",
        ),
      ocr_confidence: z.number().min(0).max(1).nullable().catch(null),
      review_color_group: z
        .enum(["green", "yellow", "red"])
        .optional()
        .catch(undefined),
      geometry_quality: z
        .enum(["good", "weak", "invalid", "not_assessed"])
        .optional()
        .catch(undefined),
      punctuation_status: z
        .enum([
          "correct",
          "incorrect",
          "uncertain",
          "consistent",
          "not_assessed",
        ])
        .optional()
        .catch(undefined),
      ocr_review_status: z
        .enum([
          "matched",
          "suspect",
          "needs_review",
          "engine_agreement",
          "engine_disagreement",
          "reference_match",
          "confirmed_mismatch",
          "verified",
        ])
        .catch("needs_review"),
      ocr_score_source: z
        .enum([
          "tesseract_raw_word_score_v1",
          "dual_engine_consensus_v1",
          "paddle_line_score_v1",
          "ocr_calibrated_word_accuracy_v1",
        ])
        .nullable()
        .catch(null),
      ocr_evidence: z
        .object({
          contract: z.enum([
            "dual_engine_agreement_v2",
            "hybrid_ocr_evidence_v3",
            "hybrid_ocr_evidence_v4",
            "tesseract_raw_word_score_v1",
            "ocr_calibrated_word_accuracy_v1",
          ]),
          engine_outputs: z.record(z.string(), z.string().nullable()),
          engine_statuses: z
            .record(
              z.string(),
              z.enum([
                "not_installed",
                "not_initialized",
                "not_run",
                "processing",
                "success",
                "no_result",
                "error",
                "disabled",
              ]),
            )
            .optional()
            .catch({}),
          engine_errors: z.record(z.string(), z.string()).optional().catch({}),
          paddle_token_index: z
            .number()
            .int()
            .nonnegative()
            .nullable()
            .optional()
            .catch(null),
          vietocr_token_index: z
            .number()
            .int()
            .nonnegative()
            .nullable()
            .optional()
            .catch(null),
          source_text: z.string().nullable().optional(),
          alignment: z.string(),
          engine_agreement_score: z.number().min(0).max(1).nullable(),
          calibrated_word_accuracy: z.number().min(0).max(1).nullable(),
          verification_source: z
            .enum(["admin", "verified_revision"])
            .nullable(),
          reference_text: z.string().nullable(),
          reference_alignment: z.string().nullable().optional(),
          selected_engine: z
            .enum(["paddleocr", "vietocr", "tesseract"])
            .nullable()
            .optional(),
          selection_reason: z.string().nullable().optional(),
          bbox_quality: z.string().nullable().optional(),
          crop_quality: z.string().nullable().optional(),
          crop_evidence: z
            .record(z.string(), z.unknown())
            .nullable()
            .optional(),
          review_reason: z.string(),
        })
        .nullable()
        .optional()
        .catch(null),
    }),
  ),
  ocr_metadata: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime({ offset: true }),
  verified_at: z.iso.datetime({ offset: true }).nullable(),
  verified_by: z.uuid().nullable(),
});

export function createOcrReviewService(): OcrReviewService {
  const workflowPath = (pageId: string, workflowId?: string) =>
    "/books/admin/pages/" +
    encodeURIComponent(pageId) +
    "/ai-workflows" +
    (workflowId ? "/" + encodeURIComponent(workflowId) : "");
  return {
    getRevision: (pageId, revisionId) =>
      requestApi(
        "/books/admin/pages/" +
          encodeURIComponent(pageId) +
          "/revisions/" +
          encodeURIComponent(revisionId),
        adminRevisionDetailSchema.refine(
          (item) =>
            item.page_id === pageId && item.page_revision_id === revisionId,
        ),
      ),
    saveDraft: (pageId, revisionId, draftText, words) =>
      requestApi(
        "/books/admin/pages/" +
          encodeURIComponent(pageId) +
          "/revisions/" +
          encodeURIComponent(revisionId) +
          "/draft",
        adminRevisionDetailSchema.refine(
          (item) =>
            item.page_id === pageId && item.page_revision_id === revisionId,
        ),
        undefined,
        {
          method: "PUT",
          body: {
            idempotency_key: globalThis.crypto.randomUUID(),
            draft_text: draftText,
            words: words.map((word) => ({
              word_index: word.word_index,
              line_index: word.line_index,
              text: word.text,
              normalized_text: word.normalized_text,
              bbox: [...word.bbox],
              ocr_confidence: word.ocr_confidence,
            })),
          },
        },
      ),
    aiCorrectText: async (pageId, draftText, words, onProgress, signal) => {
      const basePath =
        "/books/admin/pages/" + encodeURIComponent(pageId) + "/ai-correct/jobs";
      const job = await requestApi(basePath, aiCorrectionJobSchema, undefined, {
        method: "POST",
        body: {
          idempotency_key: globalThis.crypto.randomUUID(),
          draft_text: draftText,
          words: words.map((word) => ({
            word_index: word.word_index,
            line_index: word.line_index,
            text: word.text,
            normalized_text: word.normalized_text,
            bbox: [...word.bbox],
            ocr_confidence: word.ocr_confidence,
          })),
        },
      });
      let current = job;
      onProgress?.(current);

      while (current.status === "QUEUED" || current.status === "RUNNING") {
        if (signal?.aborted) {
          await requestApi(
            `${basePath}/${current.job_id}`,
            aiCorrectionJobSchema,
            undefined,
            { method: "DELETE" },
          ).catch(() => undefined);
          throw new AiCorrectionCancelledError();
        }
        await waitForJobPoll(signal).catch(async (error: unknown) => {
          if (!(error instanceof AiCorrectionCancelledError)) throw error;
          await requestApi(
            `${basePath}/${current.job_id}`,
            aiCorrectionJobSchema,
            undefined,
            { method: "DELETE" },
          ).catch(() => undefined);
          throw error;
        });
        current = await requestApi(
          `${basePath}/${current.job_id}`,
          aiCorrectionJobSchema,
          signal,
        ).catch(async (error: unknown) => {
          if (!signal?.aborted) throw error;
          await requestApi(
            `${basePath}/${current.job_id}`,
            aiCorrectionJobSchema,
            undefined,
            { method: "DELETE" },
          ).catch(() => undefined);
          throw new AiCorrectionCancelledError();
        });
        onProgress?.(current);
      }

      if (current.status === "SUCCEEDED" && current.result !== null) {
        return current.result;
      }
      if (current.status === "CANCELLED") {
        throw new AiCorrectionCancelledError();
      }
      throw new Error(
        current.error ?? "AI OCR cục bộ không thể hoàn tất tác vụ.",
      );
    },
    runCombinedWorkflow: async (
      pageId,
      revisionId,
      draftText,
      words,
      onProgress,
      signal,
    ) => {
      const basePath = workflowPath(pageId);
      let current = await requestApi(
        basePath,
        adminAiWorkflowSchema,
        undefined,
        {
          method: "POST",
          body: {
            page_revision_id: revisionId,
            idempotency_key: globalThis.crypto.randomUUID(),
            draft_text: draftText,
            words: words.map((word) => ({
              word_index: word.word_index,
              line_index: word.line_index,
              text: word.text,
              normalized_text: word.normalized_text,
              bbox: [...word.bbox],
              ocr_confidence: word.ocr_confidence,
            })),
          },
        },
      );
      onProgress?.({ status: current.status, progress: current.progress });
      while (
        current.status !== "READY_FOR_ADMIN_REVIEW" &&
        current.status !== "FAILED"
      ) {
        if (signal?.aborted) throw new AiCorrectionCancelledError();
        await waitForJobPoll(signal);
        current = await requestApi(
          workflowPath(pageId, current.workflow_id),
          adminAiWorkflowSchema,
          signal,
        );
        onProgress?.({ status: current.status, progress: current.progress });
      }
      return current;
    },
    getLatestWorkflow: (pageId, revisionId) =>
      requestApi(
        "/books/admin/pages/" +
          encodeURIComponent(pageId) +
          "/revisions/" +
          encodeURIComponent(revisionId) +
          "/ai-workflows/latest",
        adminAiWorkflowSchema.nullable(),
      ),
    updateWorkflowCandidate: (
      pageId,
      workflowId,
      candidateVersion,
      candidateText,
    ) =>
      requestApi(
        workflowPath(pageId, workflowId) + "/candidate",
        adminAiWorkflowSchema,
        undefined,
        {
          method: "PATCH",
          body: {
            expected_candidate_version: candidateVersion,
            candidate_text: candidateText,
          },
        },
      ),
    decideWorkflowSafety: (
      pageId,
      workflowId,
      candidateHash,
      confirmed,
      reason,
    ) =>
      requestApi(
        workflowPath(pageId, workflowId) + "/safety-decision",
        adminAiWorkflowSchema,
        undefined,
        {
          method: "POST",
          body: { expected_candidate_hash: candidateHash, confirmed, reason },
        },
      ),
    retryWorkflow: (pageId, workflowId) =>
      requestApi(
        workflowPath(pageId, workflowId) + "/retry",
        adminAiWorkflowSchema,
        undefined,
        { method: "POST" },
      ),
    getVerificationReadiness: (pageId, revisionId, workflowId) =>
      requestApi(
        "/books/admin/pages/" +
          encodeURIComponent(pageId) +
          "/verification-readiness" +
          apiQuery({
            revision_id: revisionId,
            workflow_id: workflowId ?? undefined,
          }),
        adminPageVerificationReadinessSchema,
      ),
    resolveUncertainWords: (pageId, workflowId, expectedCandidateHash, note) =>
      requestApi(
        workflowPath(pageId, workflowId) + "/uncertain-resolution",
        adminAiWorkflowSchema,
        undefined,
        {
          method: "POST",
          body: {
            expected_candidate_hash: expectedCandidateHash,
            note,
          },
        },
      ),
    reviewImageSafety: (pageId, workflowId, status, note, pageContentType) =>
      requestApi(
        workflowPath(pageId, workflowId) + "/image-safety-review",
        adminAiWorkflowSchema,
        undefined,
        {
          method: "POST",
          body: {
            status,
            note,
            page_content_type: pageContentType,
          },
        },
      ),
    updatePageContentType: (pageId, contentType) =>
      requestApi(
        "/books/admin/pages/" + encodeURIComponent(pageId) + "/content-type",
        adminPageContentTypeSchema,
        undefined,
        {
          method: "PATCH",
          body: { content_type: contentType },
        },
      ),
  };
}
