"use client";

import { LoaderCircle, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { AdminBadge } from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import {
  markAiPageRevisionSkipped,
  useSkippedAiPageIds,
} from "@/hooks/use-admin-ai-batch-skipped-pages";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { TranslateFn } from "@/lib/i18n/types";
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
  readonly completedRunId: number;
}

const emptyBatchSession: BatchSession = {
  results: [],
  progress: null,
  processing: false,
  notice: null,
  completedRunId: 0,
};
const batchSessions = new Map<string, BatchSession>();
const batchListeners = new Map<string, Set<() => void>>();
const batchControllers = new Map<string, AbortController>();

export function clearAdminBookAiBatchSessions(): void {
  const affectedBookIds = new Set<string>([
    ...batchSessions.keys(),
    ...batchControllers.keys(),
    ...batchListeners.keys(),
  ]);
  for (const controller of batchControllers.values()) {
    controller.abort();
  }
  batchControllers.clear();
  batchSessions.clear();
  for (const bookId of affectedBookIds) {
    batchListeners.get(bookId)?.forEach((listener) => listener());
  }
}

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

function pageErrorMessage(cause: unknown, t: TranslateFn): string {
  if (isServiceError(cause)) return cause.message;
  if (cause instanceof Error) return cause.message;
  return t("books.aiBatch.errors.genericPage");
}

function preparePage(
  detail: AdminPageRevisionDetailDTO,
  correctedText: string,
  t: TranslateFn,
): {
  readonly request: AdminRevisionVerifyRequestDTO;
  readonly changes: number;
} {
  const originalText = detail.draft_text?.normalize("NFC").trim() ?? "";
  const originalTokens = tokenizePageText(originalText);
  if (!originalText || originalTokens.length === 0) {
    throw new Error(t("books.aiBatch.errors.noDraft"));
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
    throw new Error(t("books.aiBatch.errors.wordMismatch"));
  }
  if (detail.words.some((word) => word.geometry_quality === "invalid")) {
    throw new Error(t("books.aiBatch.errors.invalidWordBox"));
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
    throw new Error(t("books.aiBatch.errors.aiWordCountMismatch"));
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
  collapsed = false,
  items,
  onCompleted,
}: {
  bookId: string;
  collapsed?: boolean;
  items: readonly AdminPageListItemUI[];
  onCompleted: () => void;
}) {
  const { ocr } = useAdminServices();
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
  const BATCH_RESULTS_PAGE_SIZE = 6;
  const [resultsPage, setResultsPage] = useState(1);
  const session = useSyncExternalStore(
    (onChange) => subscribeBatchSession(bookId, onChange),
    () => getBatchSession(bookId),
    () => emptyBatchSession,
  );
  const { results, progress, processing, notice, completedRunId } = session;
  const onCompletedRef = useRef(onCompleted);
  const lastCompletedRunRef = useRef({
    bookId,
    runId: completedRunId,
  });

  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  useEffect(() => {
    if (lastCompletedRunRef.current.bookId !== bookId) {
      lastCompletedRunRef.current = { bookId, runId: completedRunId };
      return;
    }
    if (completedRunId < lastCompletedRunRef.current.runId) {
      lastCompletedRunRef.current = { bookId, runId: completedRunId };
      return;
    }
    if (!processing && completedRunId > lastCompletedRunRef.current.runId) {
      lastCompletedRunRef.current = { bookId, runId: completedRunId };
      onCompletedRef.current();
    }
  }, [bookId, completedRunId, processing]);

  const skippedPageIds = useSkippedAiPageIds(bookId);

  if (collapsed && !processing && results.length === 0 && !notice) {
    return null;
  }

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
  const resultsTotalPages = Math.max(
    1,
    Math.ceil(results.length / BATCH_RESULTS_PAGE_SIZE),
  );
  const safeResultsPage = Math.min(
    Math.max(1, resultsPage),
    resultsTotalPages,
  );
  const visibleResults = results.slice(
    (safeResultsPage - 1) * BATCH_RESULTS_PAGE_SIZE,
    safeResultsPage * BATCH_RESULTS_PAGE_SIZE,
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
    if (
      getBatchSession(bookId).processing ||
      waitingPages.length === 0 ||
      batchControllers.has(bookId)
    )
      return;
    const controller = new AbortController();
    const isActiveController = () =>
      batchControllers.get(bookId) === controller;
    const nextRunId = getBatchSession(bookId).completedRunId + 1;
    batchControllers.set(bookId, controller);
    updateBatchSession(bookId, (current) => ({
      ...current,
      processing: true,
      results: [],
      notice: null,
    }));
    let completed: BatchPageResult[] = [];

    for (const [index, item] of waitingPages.entries()) {
      if (!isActiveController() || controller.signal.aborted) break;
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
      if (!isActiveController() || controller.signal.aborted) break;

      let draftSaved = false;
      let detail: AdminPageRevisionDetailDTO | null = null;
      try {
        detail = await ocr.getRevision(pageId, revisionId);
        if (!isActiveController() || controller.signal.aborted) break;
        if (
          detail.page_id !== pageId ||
          detail.page_revision_id !== revisionId ||
          detail.verification_status !== "NEEDS_REVIEW" ||
          detail.lifecycle_status !== "ACTIVE"
        ) {
          throw new Error(t("books.aiBatch.errors.revisionChanged"));
        }
        const originalText = detail.draft_text?.normalize("NFC").trim() ?? "";
        if (!originalText) throw new Error(t("books.aiBatch.errors.noOcrText"));

        const workflow = await ocr.runCombinedWorkflow(
          pageId,
          revisionId,
          originalText,
          detail.words,
          (workflowProgress) => {
            if (!isActiveController() || controller.signal.aborted) return;
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
        if (!isActiveController() || controller.signal.aborted) break;
        if (workflow.status === "FAILED" || !workflow.proofread_text) {
          throw new Error(t("books.aiBatch.errors.workflowIncomplete"));
        }

        const prepared = preparePage(
          detail,
          workflow.proofread_text.normalize("NFC"),
          t,
        );
        const saved = await ocr.saveDraft(
          pageId,
          revisionId,
          prepared.request.corrected_text,
          prepared.request.words,
        );
        if (!isActiveController()) break;
        draftSaved = true;
        markAiPageRevisionSkipped(bookId, revisionId);
        if (
          saved.page_revision_id !== revisionId ||
          saved.verification_status !== "NEEDS_REVIEW"
        ) {
          throw new Error(t("books.aiBatch.errors.draftConfirmFailed"));
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
              ? t("books.aiBatch.errors.savedWithChanges", {
                  changes: formatNumber(prepared.changes),
                })
              : t("books.aiBatch.errors.savedNoChanges"),
          request: prepared.request,
        };
        completed = [...completed, savedResult];
        updateBatchSession(bookId, (current) => ({
          ...current,
          results: [...completed],
        }));
      } catch (cause) {
        if (!isActiveController() || controller.signal.aborted) break;
        const previousResult = completed.find(
          (result) => result.pageId === pageId,
        );
        const detailMessage = pageErrorMessage(cause, t);
        const failedResult: BatchPageResult = draftSaved
          ? {
              ...previousResult,
              pageId,
              pageNumber: item.page_number,
              revisionId,
              status: "saved",
              changes: previousResult?.changes ?? 0,
              adminReviewRequired: true,
              message: t("books.aiBatch.errors.savedPrefix", {
                detail: detailMessage,
              }),
            }
          : {
              pageId,
              pageNumber: item.page_number,
              revisionId,
              status: "failed",
              changes: 0,
              adminReviewRequired: true,
              message: t("books.aiBatch.errors.failedKeepReview", {
                detail: detailMessage,
              }),
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
      if (!isActiveController()) break;
      updateBatchSession(bookId, (current) => ({
        ...current,
        results: [...completed],
      }));
    }

    if (!isActiveController()) return;
    batchControllers.delete(bookId);

    let finalNotice: BatchNotice;
    if (controller.signal.aborted) {
      finalNotice = {
        tone: "warning",
        title: t("books.aiBatch.stoppedTitle"),
        message: t("books.aiBatch.stoppedMessage", {
          verified: formatNumber(
            completed.filter((item) => item.status === "verified").length,
          ),
        }),
      };
    } else if (completed.length === 0) {
      finalNotice = {
        tone: "info",
        title: t("books.aiBatch.noneTitle"),
        message: t("books.aiBatch.noneMessage"),
      };
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
      finalNotice = {
        tone: failedCount > 0 || savedCount > 0 ? "warning" : "success",
        title: t("books.aiBatch.doneTitle"),
        message: t("books.aiBatch.doneMessage", {
          verified: formatNumber(verifiedCount),
          saved: formatNumber(savedCount),
          failed: formatNumber(failedCount),
        }),
      };
    }
    updateBatchSession(bookId, (current) => ({
      ...current,
      progress: null,
      processing: false,
      notice: finalNotice,
      completedRunId: nextRunId,
    }));
  }

  function stopReview() {
    batchControllers.get(bookId)?.abort();
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-base font-extrabold text-ink">
            <Sparkles
              aria-hidden="true"
              className="size-4 shrink-0 text-primary"
            />
            {t("books.aiBatch.heading")}
          </h2>
          <p className="text-xs leading-relaxed text-muted">
            {t("books.aiBatch.description")}
          </p>
        </div>

        <div className="shrink-0">
          {processing ? (
            <Button
              onClick={stopReview}
              size="admin"
              type="button"
              variant="outline"
            >
              <X aria-hidden="true" className="size-4 shrink-0" />
              {t("books.aiBatch.stopButton")}
            </Button>
          ) : (
            <Button
              disabled={waitingPages.length === 0}
              onClick={() => void reviewAllPages()}
              size="admin"
              type="button"
              variant="primary"
            >
              <Sparkles aria-hidden="true" className="size-4 shrink-0" />
              {waitingPages.length > 0
                ? results.length > 0
                  ? t("books.aiBatch.runButtonContinue", {
                      count: formatNumber(waitingPages.length),
                    })
                  : t("books.aiBatch.runButtonStart", {
                      count: formatNumber(waitingPages.length),
                    })
                : skippedPageIds.size > 0
                  ? t("books.aiBatch.skippedSummary", {
                      count: formatNumber(skippedPageIds.size),
                    })
                  : t("books.aiBatch.noPagesButton")}
            </Button>
          )}
        </div>
      </div>

      {notice ? (
        <StatusMessage title={notice.title} tone={notice.tone}>
          {notice.message}
        </StatusMessage>
      ) : null}

      {progress ? (
        <div
          aria-live="polite"
          className="rounded-lg border border-primary/20 bg-sky/35 p-3.5"
          role="status"
        >
          <div className="flex items-center gap-3">
            <LoaderCircle
              aria-hidden="true"
              className="size-5 shrink-0 animate-spin text-primary"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-ink">
                {t("books.aiBatch.progressLine", {
                  pageNumber: formatNumber(progress.pageNumber),
                  current: formatNumber(progress.current),
                  total: formatNumber(progress.total),
                })}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {t("books.aiBatch.progressVerifiedSuffix", {
                  count: formatNumber(
                    results.filter((item) => item.status === "verified").length,
                  ),
                })}{" "}
                {progress.totalChunks > 0
                  ? t("books.aiBatch.progressChunkLine", {
                      completed: formatNumber(progress.completedChunks),
                      total: formatNumber(progress.totalChunks),
                    })
                  : t("books.aiBatch.progressPreparingLine")}
                {t("books.aiBatch.progressKeepOpenHint")}
              </p>
              <div
                aria-hidden="true"
                className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white"
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
        <div aria-label={t("books.aiBatch.resultsAria")} className="space-y-2">
          <p className="text-xs font-bold text-ink">
            {t("books.aiBatch.resultsSummary", {
              verified: formatNumber(verifiedResults.length),
              saved: formatNumber(savedResults.length),
              failed: formatNumber(failedResults.length),
            })}
          </p>
          <ul className="divide-y divide-border rounded-lg border border-border px-3">
            {visibleResults.map((result) => (
              <li
                className="space-y-1.5 py-2.5 text-xs"
                key={`${result.pageId}:${result.revisionId}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-ink">
                      {t("books.aiBatch.pageLabel", {
                        pageNumber: formatNumber(result.pageNumber),
                      })}
                    </span>
                    <AdminBadge
                      tone={
                        result.status === "failed"
                          ? "danger"
                          : result.status === "verified"
                            ? "success"
                            : "warning"
                      }
                    >
                      {result.changes > 0
                        ? `${formatNumber(result.changes)} Δ`
                        : result.status === "failed"
                          ? t(
                              "books.aiBatch.statusBadges.failed",
                              undefined,
                              "Cần kiểm tra",
                            )
                          : result.status === "verified"
                            ? t(
                                "books.aiBatch.statusBadges.verified",
                                undefined,
                                "Đã xác minh",
                              )
                            : t(
                                "books.aiBatch.statusBadges.saved",
                                undefined,
                                "Đã lưu nháp",
                              )}
                    </AdminBadge>
                  </div>
                  {result.status !== "verified" ? (
                    <Link
                      className="font-bold text-primary underline focus-visible:outline-2 focus-visible:outline-primary"
                      href={`/admin/books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(result.pageId)}`}
                    >
                      {t("books.aiBatch.openPageForVerify")}
                    </Link>
                  ) : null}
                </div>
                <p
                  className={
                    result.adminReviewRequired
                      ? "text-danger"
                      : result.status === "failed"
                        ? "text-danger"
                        : result.status === "verified"
                          ? "text-success-ink"
                          : "text-warning"
                  }
                >
                  {result.message}
                </p>
                {result.request?.proofread_audit.suggestions.length ? (
                  <details className="rounded-lg bg-surface-subtle p-2.5">
                    <summary className="cursor-pointer font-semibold text-primary">
                      {t("books.aiBatch.viewChanges", {
                        changes: formatNumber(result.changes),
                        pageNumber: formatNumber(result.pageNumber),
                      })}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {result.request.proofread_audit.suggestions.map(
                        (suggestion) => (
                          <li key={suggestion.word_index}>
                            {t("books.aiBatch.wordChangeLabel", {
                              wordIndex: suggestion.word_index + 1,
                            })}{" "}
                            <span
                              className="viread-learning-content"
                              dir="ltr"
                              lang="vi"
                            >
                              “{suggestion.original}” → “{suggestion.proposed}”
                            </span>
                          </li>
                        ),
                      )}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
          <PaginationBar
            compact
            onPageChange={setResultsPage}
            page={safeResultsPage}
            pageSize={BATCH_RESULTS_PAGE_SIZE}
            total={results.length}
          />
        </div>
      ) : null}
    </div>
  );
}
