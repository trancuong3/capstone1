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
  items,
  onCompleted,
}: {
  bookId: string;
  items: readonly AdminPageListItemUI[];
  onCompleted: () => void;
}) {
  const { ocr } = useAdminServices();
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
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
            t("books.aiBatch.errors.workflowIncomplete", {
              errorCode: workflow.error_code ?? "FAILED",
            }),
          );
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
        if (mountedRef.current) onCompleted();
      } catch (cause) {
        if (controller.signal.aborted) break;
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
          title: t("books.aiBatch.stoppedTitle"),
          message: t("books.aiBatch.stoppedMessage", {
            verified: formatNumber(
              completed.filter((item) => item.status === "verified").length,
            ),
          }),
        },
      }));
    } else if (completed.length === 0) {
      updateBatchSession(bookId, (current) => ({
        ...current,
        notice: {
          tone: "info",
          title: t("books.aiBatch.noneTitle"),
          message: t("books.aiBatch.noneMessage"),
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
          title: t("books.aiBatch.doneTitle"),
          message: t("books.aiBatch.doneMessage", {
            verified: formatNumber(verifiedCount),
            saved: formatNumber(savedCount),
            failed: formatNumber(failedCount),
          }),
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
            {t("books.aiBatch.heading")}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {t("books.aiBatch.description")}
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
                  {t("books.aiBatch.progressLine", {
                    pageNumber: formatNumber(progress.pageNumber),
                    current: formatNumber(progress.current),
                    total: formatNumber(progress.total),
                  })}
                </p>
                <p className="mt-1 text-sm text-muted">
                  {t("books.aiBatch.progressVerifiedSuffix", {
                    count: formatNumber(
                      results.filter((item) => item.status === "verified")
                        .length,
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
          <div
            className="grid gap-2"
            aria-label={t("books.aiBatch.resultsAria")}
          >
            <p className="text-sm font-bold text-ink">
              {t("books.aiBatch.resultsSummary", {
                verified: formatNumber(verifiedResults.length),
                saved: formatNumber(savedResults.length),
                failed: formatNumber(failedResults.length),
              })}
            </p>
            <ul className="grid max-h-72 gap-2 overflow-y-auto rounded-control border border-border p-3">
              {results.map((result) => (
                <li
                  className="grid gap-2 border-b border-border py-2 text-sm last:border-b-0"
                  key={`${result.pageId}:${result.revisionId}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-bold">
                      {t("books.aiBatch.pageLabel", {
                        pageNumber: formatNumber(result.pageNumber),
                      })}
                    </span>
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
                      {t("books.aiBatch.openPageForVerify")}
                    </Link>
                  ) : null}
                  {result.request?.proofread_audit.suggestions.length ? (
                    <details className="rounded-control bg-sky/30 p-3">
                      <summary className="cursor-pointer font-semibold text-primary">
                        {t("books.aiBatch.viewChanges", {
                          changes: formatNumber(result.changes),
                          pageNumber: formatNumber(result.pageNumber),
                        })}
                      </summary>
                      <ul className="mt-2 grid gap-1">
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
                                “{suggestion.original}” → “{suggestion.proposed}
                                ”
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
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          {processing ? (
            <Button
              className="sm:w-auto"
              onClick={stopReview}
              variant="secondary"
            >
              <X aria-hidden className="size-4" />{" "}
              {t("books.aiBatch.stopButton")}
            </Button>
          ) : (
            <Button
              className="sm:w-auto"
              disabled={waitingPages.length === 0}
              onClick={() => void reviewAllPages()}
            >
              <Sparkles aria-hidden className="size-4" />
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
    </Card>
  );
}
