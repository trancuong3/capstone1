"use client";

import { LoaderCircle, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import {
  markAiPageRevisionSkipped,
  useSkippedAiPageIds,
} from "@/hooks/use-admin-ai-batch-skipped-pages";
import { isServiceError } from "@/lib/api/service-error";
import {
  normalizeVietnameseWord,
  syncPageTextToWords,
  tokenizePageText,
} from "@/lib/ocr/sync-page-text-words";
import type {
  AdminPageListItemUI,
  AdminPageRevisionDetailDTO,
  AdminRevisionVerifyRequestDTO,
} from "@/types/admin";

type BatchPageResult = {
  readonly pageId: string;
  readonly pageNumber: number;
  readonly revisionId: string;
  readonly status: "saved" | "verified" | "failed";
  readonly changes: number;
  readonly message: string;
  readonly adminReviewRequired?: boolean;
  readonly request?: AdminRevisionVerifyRequestDTO;
};

type BatchProgress = {
  readonly current: number;
  readonly total: number;
  readonly pageNumber: number;
  readonly completedChunks: number;
  readonly totalChunks: number;
};

type BatchNotice = {
  readonly tone: "info" | "success" | "warning" | "error";
  readonly title: string;
  readonly message: string;
};

interface BatchSession {
  readonly results: readonly BatchPageResult[];
  readonly progress: BatchProgress | null;
  readonly processing: boolean;
  readonly notice: BatchNotice | null;
}

const emptyBatchSession: BatchSession = {
  results: [],
  progress: null,
  processing: false,
  notice: null,
};
const batchSessions = new Map<string, BatchSession>();
const batchListeners = new Map<string, Set<() => void>>();
const batchControllers = new Map<string, AbortController>();

function getBatchSession(bookId: string) {
  return batchSessions.get(bookId) ?? emptyBatchSession;
}

function subscribeBatchSession(bookId: string, onChange: () => void) {
  const listeners = batchListeners.get(bookId) ?? new Set<() => void>();
  listeners.add(onChange);
  batchListeners.set(bookId, listeners);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) batchListeners.delete(bookId);
  };
}

function updateBatchSession(
  bookId: string,
  update: (current: BatchSession) => BatchSession,
) {
  batchSessions.set(bookId, update(getBatchSession(bookId)));
  batchListeners.get(bookId)?.forEach((listener) => listener());
}

function pageErrorMessage(cause: unknown): string {
  if (isServiceError(cause)) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Lỗi khi rà soát trang; bản nháp hiện tại được giữ nguyên.";
}

function preparePage(
  detail: AdminPageRevisionDetailDTO,
  correctedText: string,
): {
  readonly request: AdminRevisionVerifyRequestDTO;
  readonly changes: number;
} {
  const originalText = detail.draft_text?.normalize("NFC").trim() ?? "";
  const originalTokens = tokenizePageText(originalText);
  if (!originalText || originalTokens.length === 0) {
    throw new Error("Trang không có văn bản nháp để AI rà soát.");
  }
  if (
    detail.words.length !== originalTokens.length ||
    detail.words.some(
      (word, index) =>
        word.word_index !== index ||
        tokenizePageText(word.text).length !== 1 ||
        word.normalized_text !== normalizeVietnameseWord(word.text) ||
        normalizeVietnameseWord(originalTokens[index] ?? "") !==
          word.normalized_text,
    )
  ) {
    throw new Error(
      "Danh sách từ và vùng OCR không khớp chắc chắn. Trang được giữ nguyên để Admin rà soát riêng.",
    );
  }
  if (detail.words.some((word) => word.geometry_quality === "invalid")) {
    throw new Error(
      "Có vùng OCR không hợp lệ. Trang được giữ nguyên để Admin rà soát riêng.",
    );
  }

  const sync = syncPageTextToWords(
    correctedText.normalize("NFC"),
    detail.words,
  );
  if (
    sync.status !== "synchronized" ||
    sync.tokens.length !== originalTokens.length ||
    sync.tokens.length !== detail.words.length
  ) {
    throw new Error(
      "AI đã trả về số từ khác với vùng OCR. Không thể ghép an toàn; trang được giữ nguyên.",
    );
  }

  const suggestions = sync.tokens.flatMap((proposed, index) => {
    const original = originalTokens[index];
    if (proposed === original) return [];
    return [
      {
        word_index: index,
        original,
        proposed,
        decision: "ACCEPTED" as const,
      },
    ];
  });

  return {
    changes: suggestions.length,
    request: {
      page_revision_id: detail.page_revision_id,
      corrected_text: correctedText.normalize("NFC"),
      words: sync.words,
      proofread_audit: {
        mode: "AI_CHECKED",
        checked_text: originalText,
        suggestions,
      },
    },
  };
}

export function AdminBookAiBatchReview({
  bookId,
  items,
  onCompleted,
}: {
  bookId: string;
  items: readonly AdminPageListItemUI[];
  onCompleted: () => void;
}) {
  const { ocr } = useAdminServices();
  const session = useSyncExternalStore(
    (onChange) => subscribeBatchSession(bookId, onChange),
    () => getBatchSession(bookId),
    () => emptyBatchSession,
  );
  const { results, progress, processing, notice } = session;
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const skippedPageIds = useSkippedAiPageIds(bookId);

  const waitingPages = items
    .filter(
      (item) =>
        item.processing.lifecycle_status === "ACTIVE" &&
        item.processing.verification_status === "NEEDS_REVIEW" &&
        !skippedPageIds.has(item.processing.page_id) &&
        !skippedPageIds.has(item.processing.page_revision_id),
    )
    .slice()
    .sort((left, right) => left.page_number - right.page_number);
  const verifiedResults = results.filter((item) => item.status === "verified");
  const savedResults = results.filter((item) => item.status === "saved");
  const failedResults = results.filter((item) => item.status === "failed");
  const currentPageProgress =
    progress && progress.totalChunks > 0
      ? progress.completedChunks / progress.totalChunks
      : 0;
  const progressPercent = progress
    ? Math.max(
        4,
        Math.round(
          ((progress.current - 1 + currentPageProgress) / progress.total) * 100,
        ),
      )
    : 0;

  async function reviewAllPages() {
    if (
      getBatchSession(bookId).processing ||
      waitingPages.length === 0 ||
      batchControllers.has(bookId)
    )
      return;
    const controller = new AbortController();
    batchControllers.set(bookId, controller);
    updateBatchSession(bookId, (current) => ({
      ...current,
      processing: true,
      results: [],
      notice: null,
    }));
    let completed: BatchPageResult[] = [];

    for (const [index, item] of waitingPages.entries()) {
      const pageId = item.processing.page_id;
      const revisionId = item.processing.page_revision_id;
      updateBatchSession(bookId, (current) => ({
        ...current,
        progress: {
          current: index + 1,
          total: waitingPages.length,
          pageNumber: item.page_number,
          completedChunks: 0,
          totalChunks: 0,
        },
      }));
      if (controller.signal.aborted) break;

      let draftSaved = false;
      let detail: AdminPageRevisionDetailDTO | null = null;
      try {
        detail = await ocr.getRevision(pageId, revisionId);
        if (
          detail.page_id !== pageId ||
          detail.page_revision_id !== revisionId ||
          detail.verification_status !== "NEEDS_REVIEW" ||
          detail.lifecycle_status !== "ACTIVE"
        ) {
          throw new Error(
            "Revision đã thay đổi hoặc không còn chờ duyệt. Hãy tải lại danh sách trang.",
          );
        }
        const originalText = detail.draft_text?.normalize("NFC").trim() ?? "";
        if (!originalText)
          throw new Error("Trang chưa có văn bản OCR để rà soát.");

        const workflow = await ocr.runCombinedWorkflow(
          pageId,
          revisionId,
          originalText,
          detail.words,
          (workflowProgress) => {
            if (controller.signal.aborted) return;
            updateBatchSession(bookId, (current) => ({
              ...current,
              progress: {
                current: index + 1,
                total: waitingPages.length,
                pageNumber: item.page_number,
                completedChunks: workflowProgress.progress.completed_chunks,
                totalChunks: workflowProgress.progress.total_chunks,
              },
            }));
          },
          controller.signal,
        );
        if (controller.signal.aborted) break;
        if (workflow.status === "FAILED" || !workflow.proofread_text) {
          throw new Error(
            `Workflow AI chưa hoàn tất (${workflow.error_code ?? "FAILED"}). Nội dung OCR gốc được giữ nguyên để Admin kiểm tra.`,
          );
        }

        const prepared = preparePage(
          detail,
          workflow.proofread_text.normalize("NFC"),
        );
        const saved = await ocr.saveDraft(
          pageId,
          revisionId,
          prepared.request.corrected_text,
          prepared.request.words,
        );
        draftSaved = true;
        markAiPageRevisionSkipped(bookId, revisionId);
        if (
          saved.page_revision_id !== revisionId ||
          saved.verification_status !== "NEEDS_REVIEW"
        ) {
          throw new Error("Backend chưa xác nhận đã lưu đúng bản nháp.");
        }

        const savedResult: BatchPageResult = {
          pageId,
          pageNumber: item.page_number,
          revisionId,
          status: "saved",
          changes: prepared.changes,
          adminReviewRequired: true,
          message:
            prepared.changes > 0
              ? `AI đã đề xuất ${prepared.changes} sửa đổi & quét an toàn văn bản. Đã lưu bản nháp — chờ Admin kiểm tra ảnh, quyền sử dụng và xác minh thủ công.`
              : "AI không đề xuất sửa đổi & đã quét an toàn văn bản. Chờ Admin kiểm tra ảnh, quyền sử dụng và xác minh thủ công.",
          request: prepared.request,
        };
        completed = [...completed, savedResult];
        updateBatchSession(bookId, (current) => ({
          ...current,
          results: [...completed],
        }));
        if (mountedRef.current) onCompleted();
      } catch (cause) {
        if (controller.signal.aborted) break;
        const previousResult = completed.find(
          (result) => result.pageId === pageId,
        );
        const failedResult: BatchPageResult = draftSaved
          ? {
              ...previousResult,
              pageId,
              pageNumber: item.page_number,
              revisionId,
              status: "saved",
              changes: previousResult?.changes ?? 0,
              adminReviewRequired: true,
              message:
                "Bản nháp AI đã được lưu và chờ Admin xác minh thủ công: " +
                pageErrorMessage(cause),
            }
          : {
              pageId,
              pageNumber: item.page_number,
              revisionId,
              status: "failed",
              changes: 0,
              adminReviewRequired: true,
              message: `AI không xử lý được; trang giữ nguyên trạng thái NEEDS_REVIEW (không tự động VERIFIED). ${pageErrorMessage(cause)}`,
            };
        markAiPageRevisionSkipped(bookId, revisionId);
        const existingIndex = completed.findIndex(
          (result) => result.pageId === pageId,
        );
        if (existingIndex >= 0) {
          completed = completed.map((result, index) =>
            index === existingIndex ? failedResult : result,
          );
        } else {
          completed = [...completed, failedResult];
        }
      }
      updateBatchSession(bookId, (current) => ({
        ...current,
        results: [...completed],
      }));
    }

    if (batchControllers.get(bookId) === controller)
      batchControllers.delete(bookId);
    updateBatchSession(bookId, (current) => ({
      ...current,
      progress: null,
      processing: false,
    }));
    if (controller.signal.aborted) {
      updateBatchSession(bookId, (current) => ({
        ...current,
        notice: {
          tone: "warning",
          title: "Đã dừng rà soát",
          message: `${completed.filter((item) => item.status === "verified").length} trang đã được lưu và xác minh. Nếu trang đang làm đã lưu xong nhưng chưa xác minh, bản nháp vẫn được giữ ở trạng thái NEEDS_REVIEW.`,
        },
      }));
    } else if (completed.length === 0) {
      updateBatchSession(bookId, (current) => ({
        ...current,
        notice: {
          tone: "info",
          title: "Không có trang cần rà soát",
          message:
            "Hãy tải lại danh sách hoặc chờ OCR các trang mới hoàn tất trước khi chạy AI.",
        },
      }));
    } else {
      const verifiedCount = completed.filter(
        (item) => item.status === "verified",
      ).length;
      const savedCount = completed.filter(
        (item) => item.status === "saved",
      ).length;
      const failedCount = completed.filter(
        (item) => item.status === "failed",
      ).length;
      updateBatchSession(bookId, (current) => ({
        ...current,
        notice: {
          tone: failedCount > 0 || savedCount > 0 ? "warning" : "success",
          title: "Đã xử lý xong từng trang",
          message: `${verifiedCount} trang đã tự lưu và xác minh; ${savedCount} trang có bản nháp đã lưu nhưng cần Admin xác minh; ${failedCount} trang được giữ nguyên và chuyển sang Admin xác minh. Các revision lỗi sẽ không bị AI quét lại.`,
        },
      }));
    }
    if (mountedRef.current) onCompleted();
  }

  function stopReview() {
    batchControllers.get(bookId)?.abort();
  }

  return (
    <Card className="mb-6 bg-white">
      <div className="grid gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-black">
            <Sparkles aria-hidden className="size-5 text-primary" />
            AI rà soát chính tả &amp; an toàn từng trang (chờ Admin xác minh)
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            AI xử lý lần lượt các trang NEEDS_REVIEW để đề xuất sửa chính tả OCR
            và quét an toàn nội dung văn bản (hỗ trợ fallback sang Ollama cục bộ
            khi cloud gặp lỗi). Hệ thống tuyệt đối không tự động VERIFIED trang
            hoặc tự động xuất bản sách: Admin cần mở từng trang để đối chiếu
            ảnh, xác nhận an toàn hình ảnh, kiểm tra hồ sơ quyền sử dụng và bấm
            xác minh thủ công.
          </p>
        </div>

        {notice ? (
          <StatusMessage tone={notice.tone} title={notice.title}>
            {notice.message}
          </StatusMessage>
        ) : null}

        {progress ? (
          <div
            aria-live="polite"
            className="rounded-control border border-border bg-sky/40 p-4"
            role="status"
          >
            <div className="flex items-center gap-3">
              <LoaderCircle
                aria-hidden
                className="size-6 shrink-0 animate-spin text-primary"
              />
              <div className="min-w-0">
                <p className="font-bold text-ink">
                  Đang rà soát trang {progress.pageNumber} · {progress.current}/
                  {progress.total}
                </p>
                <p className="mt-1 text-sm text-muted">
                  {results.filter((item) => item.status === "verified").length}{" "}
                  trang đã xác minh và lưu bền vững.{" "}
                  {progress.totalChunks > 0
                    ? `Đang xử lý đoạn ${progress.completedChunks}/${progress.totalChunks}. `
                    : "Đang tải ảnh, kiểm tra văn bản và chuẩn bị các đoạn xử lý. "}
                  Có thể mất một lúc; hãy giữ trang này mở.
                </p>
                <div
                  aria-hidden
                  className="mt-3 h-2 overflow-hidden rounded-full bg-white"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-500"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {results.length > 0 ? (
          <div className="grid gap-2" aria-label="Kết quả rà soát theo trang">
            <p className="text-sm font-bold text-ink">
              Kết quả: {verifiedResults.length} trang đã xác minh ·{" "}
              {savedResults.length} bản nháp đã lưu, cần Admin xác minh ·{" "}
              {failedResults.length} trang cần Admin xác minh
            </p>
            <ul className="grid max-h-72 gap-2 overflow-y-auto rounded-control border border-border p-3">
              {results.map((result) => (
                <li
                  className="grid gap-2 border-b border-border py-2 text-sm last:border-b-0"
                  key={`${result.pageId}:${result.revisionId}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-bold">Trang {result.pageNumber}</span>
                    <span
                      className={
                        result.adminReviewRequired
                          ? "text-red-700"
                          : result.status === "failed"
                            ? "text-danger"
                            : result.status === "verified"
                              ? "text-success-ink"
                              : "text-warning"
                      }
                    >
                      {result.message}
                    </span>
                  </div>
                  {result.status !== "verified" ? (
                    <Link
                      className="w-fit font-bold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
                      href={`/admin/books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(result.pageId)}`}
                    >
                      Mở trang để Admin xác minh
                    </Link>
                  ) : null}
                  {result.request?.proofread_audit.suggestions.length ? (
                    <details className="rounded-control bg-sky/30 p-3">
                      <summary className="cursor-pointer font-semibold text-primary">
                        Xem {result.changes} sửa đổi của trang{" "}
                        {result.pageNumber}
                      </summary>
                      <ul className="mt-2 grid gap-1">
                        {result.request.proofread_audit.suggestions.map(
                          (suggestion) => (
                            <li key={suggestion.word_index}>
                              Từ {suggestion.word_index + 1}: “
                              {suggestion.original}” → “{suggestion.proposed}”
                            </li>
                          ),
                        )}
                      </ul>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          {processing ? (
            <Button
              className="sm:w-auto"
              onClick={stopReview}
              variant="secondary"
            >
              <X aria-hidden className="size-4" /> Dừng rà soát
            </Button>
          ) : (
            <Button
              className="sm:w-auto"
              disabled={waitingPages.length === 0}
              onClick={() => void reviewAllPages()}
            >
              <Sparkles aria-hidden className="size-4" />
              {waitingPages.length > 0
                ? `${results.length ? "Tiếp tục rà soát" : "Chạy AI đề xuất sửa"} ${waitingPages.length} trang`
                : skippedPageIds.size > 0
                  ? `${skippedPageIds.size} revision đã xử lý; không quét lại`
                  : "Không có trang cần AI rà soát"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
