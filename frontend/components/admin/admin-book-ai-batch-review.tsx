"use client";

import { LoaderCircle, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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

function prepareSourceOcrFallback(
  detail: AdminPageRevisionDetailDTO,
  sourceText: string,
): AdminRevisionVerifyRequestDTO {
  const normalizedText = sourceText.normalize("NFC").trim();
  const tokens = tokenizePageText(normalizedText);
  if (
    tokens.length === 0 ||
    detail.words.length !== tokens.length ||
    detail.words.some((word, index) => {
      const [x, y, width, height] = word.bbox;
      return (
        word.word_index !== index ||
        tokenizePageText(word.text).length !== 1 ||
        normalizeVietnameseWord(word.text) !== word.normalized_text ||
        normalizeVietnameseWord(tokens[index] ?? "") !== word.normalized_text ||
        ![x, y, width, height].every(Number.isFinite) ||
        x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > 1 ||
        y + height > 1
      );
    })
  ) {
    throw new Error(
      "OCR gốc không khớp an toàn với từ và vùng ảnh; cần Admin xác minh thủ công.",
    );
  }
  return {
    page_revision_id: detail.page_revision_id,
    corrected_text: normalizedText,
    words: detail.words.map(
      ({
        word_index,
        line_index,
        text,
        normalized_text,
        bbox,
        ocr_confidence,
      }) => ({
        word_index,
        line_index,
        text,
        normalized_text,
        bbox,
        ocr_confidence,
      }),
    ),
    proofread_audit: {
      mode: "AI_AUTO_VERIFIED",
      checked_text: normalizedText,
      suggestions: [],
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
  const { ocr, revisions } = useAdminServices();
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

        let aiText: string;
        try {
          aiText = await ocr.aiCorrectText(
            pageId,
            originalText,
            detail.words,
            (chunk) => {
              if (controller.signal.aborted) return;
              updateBatchSession(bookId, (current) => ({
                ...current,
                progress: {
                  current: index + 1,
                  total: waitingPages.length,
                  pageNumber: item.page_number,
                  completedChunks: chunk.completed_chunks,
                  totalChunks: chunk.total_chunks,
                },
              }));
            },
            controller.signal,
          );
        } catch (aiCause) {
          if (controller.signal.aborted) break;
          const sourceOnly = prepareSourceOcrFallback(detail, originalText);
          const verified = await revisions.verify(pageId, sourceOnly);
          if (
            verified.page_revision_id !== revisionId ||
            verified.verification_status !== "VERIFIED"
          ) {
            throw new Error("Backend chưa xác nhận revision OCR gốc.");
          }
          markAiPageRevisionSkipped(bookId, revisionId);
          completed = [
            ...completed,
            {
              pageId,
              pageNumber: item.page_number,
              revisionId,
              status: "verified",
              changes: 0,
              adminReviewRequired: true,
              message: `AI không sửa được; đã tự VERIFIED bằng OCR gốc. Cần Admin rà soát: ${pageErrorMessage(aiCause)}`,
            },
          ];
          updateBatchSession(bookId, (current) => ({
            ...current,
            results: [...completed],
          }));
          if (mountedRef.current) onCompleted();
          continue;
        }
        const correctedText = aiText.normalize("NFC");
        if (controller.signal.aborted) break;

        const prepared = preparePage(detail, correctedText);
        const saved = await ocr.saveDraft(
          pageId,
          revisionId,
          prepared.request.corrected_text,
          prepared.request.words,
        );
        draftSaved = true;
        // The OCR correction is now durable. If the user leaves before the
        // verification step finishes, do not run the same revision through AI
        // again when the book is reopened.
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
          message: "Đã tự lưu bản sửa vào database; đang xác minh trang này.",
          request: prepared.request,
        };
        completed = [...completed, savedResult];
        updateBatchSession(bookId, (current) => ({
          ...current,
          results: [...completed],
        }));

        // The draft is durable now. If the user stops, leave it NEEDS_REVIEW
        // rather than starting verification after the stop request.
        if (controller.signal.aborted) {
          completed = completed.map((result) =>
            result.pageId === pageId
              ? {
                  ...savedResult,
                  message: "Bản nháp đã lưu; đã dừng trước bước xác minh.",
                }
              : result,
          );
          updateBatchSession(bookId, (current) => ({
            ...current,
            results: [...completed],
          }));
          break;
        }

        const verified = await revisions.verify(pageId, {
          ...prepared.request,
          proofread_audit: {
            ...prepared.request.proofread_audit,
            mode: "AI_AUTO_VERIFIED",
          },
        });
        if (
          verified.page_revision_id !== revisionId ||
          verified.verification_status !== "VERIFIED"
        ) {
          throw new Error("Backend chưa xác nhận đúng revision của trang.");
        }
        completed = completed.map((result) =>
          result.pageId === pageId
            ? {
                ...savedResult,
                status: "verified" as const,
                adminReviewRequired: true,
                message:
                  prepared.changes > 0
                    ? `Đã tự lưu ${prepared.changes} sửa đổi và xác minh trang.`
                    : "AI không đề xuất sửa đổi; trang đã tự lưu và xác minh.",
              }
            : result,
        );
        updateBatchSession(bookId, (current) => ({
          ...current,
          results: [...completed],
        }));
        if (mountedRef.current) onCompleted();
      } catch (cause) {
        if (draftSaved) {
          try {
            const history = await revisions.list(pageId);
            if (
              history.some(
                (revision) =>
                  revision.page_revision_id === revisionId &&
                  revision.verification_status === "VERIFIED",
              )
            ) {
              const recovered = completed.find(
                (result) => result.pageId === pageId,
              );
              const recoveredResult: BatchPageResult = {
                ...recovered,
                pageId,
                pageNumber: item.page_number,
                revisionId,
                status: "verified",
                changes: recovered?.changes ?? 0,
                adminReviewRequired: true,
                message:
                  "Backend đã xác nhận trang VERIFIED sau khi kết nối bị gián đoạn.",
              };
              completed = recovered
                ? completed.map((result) =>
                    result.pageId === pageId ? recoveredResult : result,
                  )
                : [...completed, recoveredResult];
              updateBatchSession(bookId, (current) => ({
                ...current,
                results: [...completed],
              }));
              if (mountedRef.current) onCompleted();
              continue;
            }
          } catch {
            // Keep the durable-draft notice when verification status is unknown.
          }
        }
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
              message:
                "Bản sửa đã được lưu, nhưng chưa xác minh được. Cần Admin kiểm tra: " +
                pageErrorMessage(cause) +
                " AI sẽ bỏ qua revision này để không quét lại.",
            }
          : {
              pageId,
              pageNumber: item.page_number,
              revisionId,
              status: "failed",
              changes: 0,
              message: `AI không xử lý được; nội dung OCR được giữ nguyên và chuyển sang Admin xác minh. ${pageErrorMessage(cause)} AI sẽ không quét lại revision này.`,
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
            AI rà soát và tự xác minh từng trang
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            AI xử lý lần lượt các trang NEEDS_REVIEW. Mỗi trang được lưu ngay
            sau khi kiểm tra, rồi tự xác minh trước khi chuyển sang trang kế
            tiếp; không cần xác nhận từng trang. Nếu ghép từ với vùng OCR không
            chắc chắn hoặc AI gặp lỗi, nội dung OCR được giữ và tự VERIFIED với
            nhãn đỏ cần Admin rà soát. Nếu OCR không khớp an toàn với vùng ảnh,
            trang vẫn chờ Admin xác minh. Trang tự VERIFIED chỉ vào Train, không
            vào Validation hoặc Locked Test trước khi Admin duyệt. AI không quét
            lại revision đã xử lý. Backend thử Ollama khi nhà cung cấp AI bên
            ngoài gặp lỗi. Bạn có thể chuyển màn hình; tiến trình và kết quả vẫn
            được giữ khi quay lại trong cùng tab.
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
                ? `${results.length ? "Tiếp tục rà soát" : "AI kiểm tra & xác minh"} ${waitingPages.length} trang`
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
