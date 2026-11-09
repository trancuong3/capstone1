import type {
  AdminPageRevisionDetailDTO,
  AdminRevisionWordDTO,
} from "@/types/admin";
import { z } from "zod";
import { requestApi } from "@/lib/api/api-client";

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
}

export const adminRevisionDetailSchema = z.object({
  page_id: z.uuid(),
  page_revision_id: z.uuid(),
  revision_no: z.number().int().positive(),
  verification_status: z.enum(["PROCESSING", "NEEDS_REVIEW", "VERIFIED"]),
  lifecycle_status: z.enum(["ACTIVE", "RETIRED"]),
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
        .enum(["green", "red", "yellow", "neutral"])
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
  };
}
