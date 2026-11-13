"use client";

import { CheckCheck, LoaderCircle, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import {
  recordAdminBookAiReview,
  useAdminBookAiReviewHistory,
} from "@/hooks/use-admin-book-ai-review-history";
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
  readonly status: "ready" | "verified" | "failed";
  readonly changes: number;
  readonly message: string;
  readonly request?: AdminRevisionVerifyRequestDTO;
};

type BatchProgress = {
  readonly current: number;
  readonly total: number;
  readonly pageNumber: number;
  readonly completedChunks: number;
  readonly totalChunks: number;
};

function pageErrorMessage(cause: unknown): string {
  if (isServiceError(cause)) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Không thể rà soát trang này; bản nháp hiện tại được giữ nguyên.";
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
  const { ocr, revisions } = useAdminServices();
  const reviewHistory = useAdminBookAiReviewHistory(bookId);
  const reviewedRevisionIds = new Set(
    reviewHistory.map((record) => record.pageRevisionId),
  );
  const [results, setResults] = useState<readonly BatchPageResult[]>([]);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [processing, setProcessing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{
    readonly tone: "info" | "success" | "warning" | "error";
    readonly title: string;
    readonly message: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const waitingPages = items
    .filter(
      (item) =>
        item.processing.lifecycle_status === "ACTIVE" &&
        item.processing.verification_status === "NEEDS_REVIEW" &&
        !reviewedRevisionIds.has(item.processing.page_revision_id),
    )
    .slice()
    .sort((left, right) => left.page_number - right.page_number);
  const readyResults = results.filter((item) => item.status === "ready");
  const changedResults = results.filter(
    (item) => item.status === "ready" && item.changes > 0,
  );
  const unchangedResults = results.filter(
    (item) => item.status === "ready" && item.changes === 0,
  );
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
    if (processing || confirming || waitingPages.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setProcessing(true);
    setResults([]);
    setNotice(null);
    let completed: BatchPageResult[] = [];

    for (const [index, item] of waitingPages.entries()) {
      const pageId = item.processing.page_id;
      const revisionId = item.processing.page_revision_id;
      setProgress({
        current: index + 1,
        total: waitingPages.length,
        pageNumber: item.page_number,
        completedChunks: 0,
        totalChunks: 0,
      });
      if (controller.signal.aborted) break;

      try {
        const detail = await ocr.getRevision(pageId, revisionId);
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

        const correctedText = (
          await ocr.aiCorrectText(
            pageId,
            originalText,
            detail.words,
            (chunk) => {
              if (controller.signal.aborted) return;
              setProgress({
                current: index + 1,
                total: waitingPages.length,
                pageNumber: item.page_number,
                completedChunks: chunk.completed_chunks,
                totalChunks: chunk.total_chunks,
              });
            },
            controller.signal,
          )
        ).normalize("NFC");
        if (controller.signal.aborted) break;

        const prepared = preparePage(detail, correctedText);
        completed = [
          ...completed,
          {
            pageId,
            pageNumber: item.page_number,
            revisionId,
            status: "ready",
            changes: prepared.changes,
            message:
              prepared.changes > 0
                ? `Đã áp dụng ${prepared.changes} sửa đổi vào bản xem trước; chờ Admin xác nhận toàn bộ.`
                : "AI không đề xuất sửa đổi; trang chờ Admin xác nhận toàn bộ.",
            request: prepared.request,
          },
        ];
        recordAdminBookAiReview(bookId, {
          pageId,
          pageRevisionId: revisionId,
          pageNumber: item.page_number,
          outcome: "reviewed",
        });
      } catch (cause) {
        if (controller.signal.aborted) break;
        recordAdminBookAiReview(bookId, {
          pageId,
          pageRevisionId: revisionId,
          pageNumber: item.page_number,
          outcome: "failed",
        });
        completed = [
          ...completed,
          {
            pageId,
            pageNumber: item.page_number,
            revisionId,
            status: "failed",
            changes: 0,
            message: `${pageErrorMessage(cause)} Lần rà soát này đã được ghi nhận và sẽ tự bỏ qua khi mở lại sách.`,
          },
        ];
      }
      setResults([...completed]);
    }

    abortRef.current = null;
    setProgress(null);
    setProcessing(false);
    if (controller.signal.aborted) {
      setNotice({
        tone: "warning",
        title: "Đã dừng rà soát",
        message:
          "Các trang đã xử lý được giữ trong danh sách. Sửa đổi AI chưa ghi vào revision; trang vẫn NEEDS_REVIEW và chưa được đưa vào dữ liệu huấn luyện.",
      });
    } else if (completed.length === 0) {
      setNotice({
        tone: "info",
        title: "Không có trang cần rà soát",
        message:
          "Hãy tải lại danh sách hoặc chờ OCR các trang mới hoàn tất trước khi chạy AI.",
      });
    } else {
      const ready = completed.filter((item) => item.status === "ready").length;
      const failed = completed.filter(
        (item) => item.status === "failed",
      ).length;
      setNotice({
        tone: failed > 0 ? "warning" : "success",
        title: "Đã rà soát xong danh sách trang",
        message: `${ready} trang sẵn sàng xác nhận, ${failed} trang cần xử lý riêng. Hãy xem bảng kết quả rồi xác nhận các trang sẵn sàng bằng một thao tác.`,
      });
    }
  }

  function stopReview() {
    abortRef.current?.abort();
  }

  async function verifyReadyPages() {
    if (processing || confirming || readyResults.length === 0) return;
    setConfirming(true);
    setNotice(null);
    let nextResults = [...results];
    for (const result of readyResults) {
      if (!result.request) continue;
      try {
        const verified = await revisions.verify(result.pageId, result.request);
        if (
          verified.page_revision_id !== result.revisionId ||
          verified.verification_status !== "VERIFIED"
        ) {
          throw new Error("Backend chưa xác nhận đúng revision của trang.");
        }
        nextResults = nextResults.map((current) =>
          current.pageId === result.pageId
            ? {
                ...current,
                status: "verified" as const,
                message: "Đã xác minh VERIFIED.",
              }
            : current,
        );
      } catch (cause) {
        nextResults = nextResults.map((current) =>
          current.pageId === result.pageId
            ? {
                ...current,
                status: "failed" as const,
                message: "Không thể xác minh trang: " + pageErrorMessage(cause),
              }
            : current,
        );
      }
      setResults([...nextResults]);
    }
    const verifiedCount = nextResults.filter(
      (item) => item.status === "verified",
    ).length;
    const failedCount = nextResults.filter(
      (item) => item.status === "failed",
    ).length;
    setConfirming(false);
    setNotice({
      tone: failedCount > 0 ? "warning" : "success",
      title:
        failedCount > 0
          ? "Một số trang chưa xác minh được"
          : "Đã xác minh các trang sẵn sàng",
      message: `${verifiedCount} trang đã VERIFIED và được chuyển vào luồng dữ liệu Admin xác nhận. ${failedCount} trang còn lại được giữ lại để xử lý; tải lại danh sách để xem trạng thái mới nhất.`,
    });
    onCompleted();
  }

  return (
    <Card className="mb-6 bg-white">
      <div className="grid gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-black">
            <Sparkles aria-hidden className="size-5 text-primary" />
            AI rà soát toàn bộ trang sách
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            AI xử lý lần lượt các trang NEEDS_REVIEW chưa được rà soát trên
            trình duyệt này. Trạng thái rà soát được lưu theo revision, nên
            trang đã thử sẽ không tự chạy lại khi mở sách lần sau. Sửa đổi chỉ
            được ghi VERIFIED sau khi xác nhận; trang lỗi được giữ để rà soát
            riêng.
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

        {!processing && results.length > 0 ? (
          <div className="grid gap-2" aria-label="Kết quả rà soát theo trang">
            <p className="text-sm font-bold text-ink">
              Kết quả: {readyResults.length} trang sẵn sàng ·{" "}
              {changedResults.length} trang có sửa đổi ·{" "}
              {unchangedResults.length} trang không có lỗi được AI đề xuất
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
                        result.status === "failed"
                          ? "text-danger"
                          : result.status === "verified"
                            ? "text-success-ink"
                            : "text-muted"
                      }
                    >
                      {result.message}
                    </span>
                  </div>
                  {result.status === "ready" &&
                  result.request?.proofread_audit.suggestions.length ? (
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
          ) : results.length === 0 ||
            (readyResults.length === 0 && waitingPages.length > 0) ? (
            <Button
              className="sm:w-auto"
              disabled={waitingPages.length === 0 || confirming}
              isLoading={false}
              onClick={() => void reviewAllPages()}
            >
              <Sparkles aria-hidden className="size-4" />
              {waitingPages.length > 0
                ? `${results.length ? "Thử lại" : "AI kiểm tra & sửa"} ${waitingPages.length} trang`
                : reviewHistory.length > 0
                  ? "Các trang đã rà soát được bỏ qua"
                  : "Không có trang cần AI rà soát"}
            </Button>
          ) : null}

          {!processing && readyResults.length > 0 ? (
            <Button
              className="sm:w-auto"
              disabled={confirming}
              isLoading={confirming}
              onClick={() => void verifyReadyPages()}
            >
              <CheckCheck aria-hidden className="size-4" />
              Xác nhận & VERIFIED {readyResults.length} trang
            </Button>
          ) : null}
        </div>

        {!processing && readyResults.length > 0 ? (
          <p className="text-xs leading-5 text-muted">
            Khi bấm xác nhận, toàn bộ {readyResults.length} trang sẵn sàng sẽ
            được ghi VERIFIED và chuyển vào tập dữ liệu Admin. Những sửa đổi
            trong danh sách sẽ được ghi cùng lúc này. Hãy mở các mục “Xem sửa
            đổi” trước khi bấm; trang lỗi hoặc ghép vùng không chắc chắn không
            nằm trong thao tác này.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
