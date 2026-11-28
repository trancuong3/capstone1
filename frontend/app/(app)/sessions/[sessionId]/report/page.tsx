"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useParams } from "next/navigation";

import { useI18n, useTranslations } from "@/hooks/use-i18n";
import {
  deleteReadingReport,
  getSessionReports,
  type SavedReadingReport,
} from "@/lib/api/comparison-service";
import { cn } from "@/lib/utils/cn";
import {
  groupSessionReportsByPageRevision,
  isImmutableFirstPassReport,
} from "@/lib/utils/session-report-grouping";

import { ReadingReport } from "@/components/reading/ReadingReport";
import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import type { ReadingAssessmentMetricsDTO } from "@/types/reading";

const REPORTS_PER_PAGE = 5;

type PageSlot = number | "ellipsis-start" | "ellipsis-end";

function buildVisiblePageSlots(total: number, activeIndex: number): PageSlot[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, idx) => idx);
  }
  const safeActive = Math.min(Math.max(0, activeIndex), total - 1);
  if (safeActive <= 3) {
    return [0, 1, 2, 3, 4, "ellipsis-end", total - 1];
  }
  if (safeActive >= total - 4) {
    return [
      0,
      "ellipsis-start",
      total - 5,
      total - 4,
      total - 3,
      total - 2,
      total - 1,
    ];
  }
  return [
    0,
    "ellipsis-start",
    safeActive - 1,
    safeActive,
    safeActive + 1,
    "ellipsis-end",
    total - 1,
  ];
}

export default function ReadingReportPage() {
  const t = useTranslations("reports");
  const { formatDateTime } = useI18n();
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const [reports, setReports] = useState<SavedReadingReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedGroupIndex, setSelectedGroupIndex] = useState(0);
  const [reportPage, setReportPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [assessment, setAssessment] =
    useState<ReadingAssessmentMetricsDTO | null>(null);

  const pageGroups = useMemo(
    () => groupSessionReportsByPageRevision(reports),
    [reports],
  );

  async function confirmDeleteReport() {
    if (!pendingDeleteId || deletingId) return;
    const targetId = pendingDeleteId;
    setDeletingId(targetId);
    setDeleteError(null);

    try {
      await deleteReadingReport(targetId);
      const nextReports = reports.filter(
        (report) => report.report_id !== targetId,
      );
      const nextGroups = groupSessionReportsByPageRevision(nextReports);
      const nextGroupIndex = Math.min(
        selectedGroupIndex,
        Math.max(0, nextGroups.length - 1),
      );
      const nextAdditionalCount =
        nextGroups[nextGroupIndex]?.additionalReports.length ?? 0;
      const maxPage = Math.max(
        1,
        Math.ceil(nextAdditionalCount / REPORTS_PER_PAGE),
      );

      setReports((prev) =>
        prev.filter((report) => report.report_id !== targetId),
      );
      setReportPage((current) => Math.min(current, maxPage));
      setPendingDeleteId(null);
    } catch (err) {
      setDeleteError(
        err instanceof Error
          ? err.message
          : t("sessions.readingReports.deleteFailedFallback"),
      );
      setPendingDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  }

  useEffect(() => {
    let active = true;

    async function loadReports() {
      try {
        setLoading(true);
        setError(null);
        setSelectedGroupIndex(0);
        setReportPage(1);

        const data = await getSessionReports(sessionId);

        if (active) {
          setReports(data.reports);
          setAssessment(data.assessment ?? null);
        }
      } catch (err) {
        if (active) {
          setReports([]);
          setError(
            err instanceof Error
              ? err.message
              : t("sessions.readingReports.loadReportFailedFallback"),
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    if (sessionId) {
      void loadReports();
    }

    return () => {
      active = false;
    };
  }, [reloadKey, sessionId, t]);

  const reportHeading = (
    <header className="flex flex-col justify-between gap-2.5 border-b border-border pb-3.5 sm:flex-row sm:items-end">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            className="family-inline-link min-h-0"
            href={`/sessions/${encodeURIComponent(sessionId)}`}
          >
            <ArrowLeft
              aria-hidden="true"
              className="viread-rtl-flip"
              size={16}
            />{" "}
            {t("sessions.readingReports.backToDetail")}
          </Link>
          <Link
            className="text-sm font-semibold text-muted hover:text-primary"
            href="/sessions"
          >
            {t("sessions.title")}
          </Link>
        </div>
        <h1 className="book-title text-2xl text-ink sm:text-[34px]">
          {t("sessions.readingReports.pageHeading")}
        </h1>
      </div>
      {!loading && !error && reports.length > 0 ? (
        <p className="text-xs font-semibold text-muted tabular-nums sm:text-sm">
          {t("sessions.readingReports.reportsCountSummary", {
            count: reports.length,
          })}
        </p>
      ) : null}
    </header>
  );

  if (loading) {
    return (
      <section
        aria-busy="true"
        aria-label={t("sessions.readingReports.loadingAria")}
        className="mx-auto flex w-full max-w-[1120px] flex-col gap-5"
      >
        {reportHeading}
        <Skeleton className="h-28 rounded-card" />
        <Skeleton className="h-72 rounded-card" />
      </section>
    );
  }

  if (error) {
    return (
      <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-4">
        {reportHeading}
        <StatusMessage
          title={t("sessions.readingReports.unavailableTitle")}
          tone="error"
        >
          {error}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start"
          onClick={() => setReloadKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {t("sessions.readingReports.retryLoad")}
        </Button>
      </section>
    );
  }

  if (reports.length === 0) {
    return (
      <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-4">
        {reportHeading}
        <StatusMessage tone="info">
          {t("sessions.readingReports.emptySavedNote")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start"
          onClick={() => setReloadKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {t("sessions.readingReports.checkAgain")}
        </Button>
      </section>
    );
  }

  const safeGroupIndex = Math.min(selectedGroupIndex, pageGroups.length - 1);
  const activeGroup = pageGroups[safeGroupIndex];
  const primaryReport = activeGroup.primaryReport;
  const primaryImmutable = isImmutableFirstPassReport(primaryReport);
  const additionalReports = activeGroup.additionalReports;
  const maxReportPage = Math.max(
    1,
    Math.ceil(additionalReports.length / REPORTS_PER_PAGE),
  );
  const safeReportPage = Math.min(reportPage, maxReportPage);
  const startIdx = (safeReportPage - 1) * REPORTS_PER_PAGE;
  const visibleAdditional = additionalReports.slice(
    startIdx,
    startIdx + REPORTS_PER_PAGE,
  );

  return (
    <section
      className="mx-auto flex w-full max-w-[1120px] flex-col gap-3.5 pb-4"
      data-testid="standalone-session-report"
    >
      {reportHeading}

      {deleteError ? (
        <StatusMessage
          title={t("sessions.readingReports.deleteErrorTitle")}
          tone="error"
        >
          {deleteError}
        </StatusMessage>
      ) : null}

      <ReadingAssessmentSummary assessment={assessment} />

      {pageGroups.length > 1 ? (
        <nav
          aria-label={t("sessions.readingReports.pageNavAria")}
          className="flex flex-wrap items-center justify-between gap-2.5 rounded-card border border-border bg-white px-3.5 py-2.5 sm:px-4"
        >
          <p className="text-xs font-bold text-ink tabular-nums sm:text-sm">
            {t("sessions.readingReports.pageNavGroupSummary", {
              current: safeGroupIndex + 1,
              total: pageGroups.length,
            })}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              aria-label={t("sessions.previousPage")}
              className="inline-flex h-9 min-h-9 items-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-bold text-primary hover:bg-sky disabled:cursor-not-allowed disabled:opacity-40"
              disabled={safeGroupIndex <= 0}
              onClick={() => {
                setSelectedGroupIndex((current) => Math.max(0, current - 1));
                setReportPage(1);
              }}
              type="button"
            >
              <ChevronLeft
                aria-hidden="true"
                className="viread-rtl-flip size-4"
              />{" "}
              {t("sessions.readingReports.prevShort")}
            </button>
            {buildVisiblePageSlots(pageGroups.length, safeGroupIndex).map(
              (slot) => {
                if (typeof slot !== "number") {
                  return (
                    <span
                      aria-hidden="true"
                      className="inline-flex h-9 min-w-7 items-center justify-center px-1 text-xs font-bold text-muted select-none"
                      key={slot}
                    >
                      …
                    </span>
                  );
                }
                const group = pageGroups[slot];
                return (
                  <button
                    aria-current={slot === safeGroupIndex ? "page" : undefined}
                    aria-label={t("sessions.readingReports.pageLabel", {
                      page: slot + 1,
                    })}
                    className={cn(
                      "h-9 min-h-9 min-w-9 rounded-control px-2.5 text-xs font-bold tabular-nums",
                      slot === safeGroupIndex
                        ? "bg-primary text-white"
                        : "border border-border bg-white text-ink hover:bg-canvas",
                    )}
                    key={group.key}
                    onClick={() => {
                      setSelectedGroupIndex(slot);
                      setReportPage(1);
                    }}
                    type="button"
                  >
                    <span className="hidden sm:inline">
                      {t("sessions.readingReports.standalonePagePrefix")}{" "}
                    </span>
                    {slot + 1}
                  </button>
                );
              },
            )}
            <button
              aria-label={t("sessions.nextPage")}
              className="inline-flex h-9 min-h-9 items-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-bold text-primary hover:bg-sky disabled:cursor-not-allowed disabled:opacity-40"
              disabled={safeGroupIndex >= pageGroups.length - 1}
              onClick={() => {
                setSelectedGroupIndex((current) =>
                  Math.min(pageGroups.length - 1, current + 1),
                );
                setReportPage(1);
              }}
              type="button"
            >
              {t("sessions.readingReports.nextShort")}{" "}
              <ChevronRight
                aria-hidden="true"
                className="viread-rtl-flip size-4"
              />
            </button>
          </div>
        </nav>
      ) : null}

      <section className="space-y-2" data-testid="standalone-primary-report">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-extrabold text-ink sm:text-base">
              {primaryImmutable
                ? t("sessions.readingReports.firstPassSavedTitle")
                : t("sessions.readingReports.primarySavedTitle")}
            </h2>
            <span className="text-xs font-semibold text-muted tabular-nums">
              {formatDateTime(primaryReport.created_at)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!primaryImmutable ? (
              <Button
                className="h-9 min-h-9! px-3! py-0! text-xs!"
                disabled={deletingId !== null}
                fullWidth={false}
                isLoading={deletingId === primaryReport.report_id}
                onClick={() => {
                  setDeleteError(null);
                  setPendingDeleteId(primaryReport.report_id);
                }}
                size="admin"
                type="button"
                variant="destructive"
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
                {t("sessions.readingReports.deleteReportAction")}
              </Button>
            ) : (
              <span className="text-xs font-semibold text-muted">
                {t("sessions.readingReports.retainedFirstPass")}
              </span>
            )}
          </div>
        </div>

        <ReadingReport result={primaryReport} sessionId={sessionId} />
      </section>

      {additionalReports.length > 0 ? (
        <details className="group rounded-card border border-border bg-white p-3.5 sm:p-4">
          <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 text-sm font-extrabold text-ink [&::-webkit-details-marker]:hidden">
            <span>
              {t("sessions.readingReports.otherComparisonsTitle", {
                count: additionalReports.length,
              })}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180"
            />
          </summary>
          <p className="mt-1 text-xs text-muted">
            {t("sessions.readingReports.standaloneOtherComparisonsDesc")}
          </p>
          <div className="mt-3 flex flex-col gap-4">
            {visibleAdditional.map((report, index) => {
              const immutable = isImmutableFirstPassReport(report);
              return (
                <section
                  className="space-y-2.5 border-t border-border pt-3.5 first:border-t-0 first:pt-0"
                  key={report.report_id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-extrabold text-ink">
                        {immutable
                          ? t("sessions.readingReports.firstPassSavedTitle")
                          : t(
                              "sessions.readingReports.additionalComparisonTitle",
                              { index: startIdx + index + 1 },
                            )}
                      </h3>
                      <span className="text-xs font-semibold text-muted tabular-nums">
                        {formatDateTime(report.created_at)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {!immutable ? (
                        <Button
                          className="h-9 min-h-9! px-3! py-0! text-xs!"
                          disabled={deletingId !== null}
                          fullWidth={false}
                          isLoading={deletingId === report.report_id}
                          onClick={() => {
                            setDeleteError(null);
                            setPendingDeleteId(report.report_id);
                          }}
                          size="admin"
                          type="button"
                          variant="destructive"
                        >
                          <Trash2 aria-hidden="true" className="size-3.5" />
                          {t("sessions.readingReports.deleteReportAction")}
                        </Button>
                      ) : (
                        <span className="text-xs font-semibold text-muted">
                          {t("sessions.readingReports.retainedFirstPass")}
                        </span>
                      )}
                    </div>
                  </div>

                  <ReadingReport result={report} sessionId={sessionId} />
                </section>
              );
            })}
          </div>

          <PaginationBar
            ariaLabel={t("sessions.readingReports.additionalPaginationAria")}
            className="mt-3"
            compact
            itemLabel={t("sessions.readingReports.additionalPaginationItem")}
            onPageChange={setReportPage}
            page={safeReportPage}
            pageSize={REPORTS_PER_PAGE}
            total={additionalReports.length}
          />
        </details>
      ) : null}

      <Modal
        closeOnBackdropClick={deletingId === null}
        closeOnEscape={deletingId === null}
        footer={
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              disabled={deletingId !== null}
              fullWidth={false}
              onClick={() => setPendingDeleteId(null)}
              type="button"
              variant="secondary"
            >
              {t("sessions.readingReports.cancel")}
            </Button>
            <Button
              disabled={deletingId !== null}
              fullWidth={false}
              isLoading={deletingId !== null}
              onClick={() => void confirmDeleteReport()}
              type="button"
              variant="destructive"
            >
              {t("sessions.readingReports.confirmDelete")}
            </Button>
          </div>
        }
        isOpen={pendingDeleteId !== null}
        onClose={() => {
          if (deletingId === null) setPendingDeleteId(null);
        }}
        role="alertdialog"
        showCloseButton={deletingId === null}
        title={t("sessions.readingReports.deleteModalTitle")}
        tone="paper"
      >
        <p className="text-body text-ink">
          {t("sessions.readingReports.deleteModalBody")}
        </p>
      </Modal>
    </section>
  );
}
