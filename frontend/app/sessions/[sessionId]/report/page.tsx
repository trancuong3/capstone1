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

import {
  deleteReadingReport,
  getSessionReports,
  type SavedReadingReport,
} from "@/lib/api/comparison-service";
import { cn } from "@/lib/utils/cn";
import { formatHistoryDateTime } from "@/lib/utils/report-mappers";
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

export default function ReadingReportPage() {
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
      setReports((prev) => {
        const next = prev.filter((report) => report.report_id !== targetId);
        const maxPage = Math.max(1, Math.ceil(next.length / REPORTS_PER_PAGE));
        setReportPage((current) => Math.min(current, maxPage));
        return next;
      });
      setPendingDeleteId(null);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Không thể xóa báo cáo.",
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
            err instanceof Error ? err.message : "Không thể tải báo cáo đọc.",
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
  }, [reloadKey, sessionId]);

  const reportHeading = (
    <header className="flex flex-col justify-between gap-3 border-b border-border pb-5 sm:flex-row sm:items-end">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            className="family-inline-link min-h-0"
            href={`/sessions/${encodeURIComponent(sessionId)}`}
          >
            <ArrowLeft aria-hidden="true" size={16} /> Chi tiết buổi đọc
          </Link>
          <Link
            className="text-sm font-semibold text-muted hover:text-primary"
            href="/sessions"
          >
            Lịch sử đọc
          </Link>
        </div>
        <h1 className="book-title text-3xl text-ink sm:text-[38px]">
          Báo cáo đọc
        </h1>
      </div>
      {!loading && !error && reports.length > 0 ? (
        <p className="text-sm font-semibold text-muted tabular-nums">
          Có {reports.length} báo cáo trong phiên đọc này.
        </p>
      ) : null}
    </header>
  );

  if (loading) {
    return (
      <section
        aria-busy="true"
        aria-label="Đang tải báo cáo đọc"
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
        <StatusMessage title="Chưa tải được báo cáo" tone="error">
          {error}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start"
          onClick={() => setReloadKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          Thử tải lại
        </Button>
      </section>
    );
  }

  if (reports.length === 0) {
    return (
      <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-4">
        {reportHeading}
        <StatusMessage tone="info">
          Buổi đọc đã được lưu. Báo cáo đối chiếu sẽ có khi hệ thống ghi nhận
          được lời đọc của bé.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start"
          onClick={() => setReloadKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          Kiểm tra lại
        </Button>
      </section>
    );
  }

  const safeGroupIndex = Math.min(selectedGroupIndex, pageGroups.length - 1);
  const activeGroup = pageGroups[safeGroupIndex];
  const primaryReport = activeGroup.primaryReport;
  const primaryImmutable = isImmutableFirstPassReport(primaryReport);
  const additionalReports = activeGroup.additionalReports;
  const startIdx = (reportPage - 1) * REPORTS_PER_PAGE;
  const visibleAdditional = additionalReports.slice(
    startIdx,
    startIdx + REPORTS_PER_PAGE,
  );

  return (
    <section
      className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 pb-4"
      data-testid="standalone-session-report"
    >
      {reportHeading}

      {deleteError ? (
        <StatusMessage title="Không thể xóa báo cáo" tone="error">
          {deleteError}
        </StatusMessage>
      ) : null}

      <ReadingAssessmentSummary assessment={assessment} />

      {pageGroups.length > 1 ? (
        <nav
          aria-label="Chọn trang có báo cáo"
          className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-white p-3.5 sm:px-5"
        >
          <p className="text-sm font-bold text-ink tabular-nums">
            Trang {safeGroupIndex + 1} / {pageGroups.length} trang có báo cáo
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              aria-label="Trang trước"
              className="inline-flex min-h-11 items-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-bold text-primary hover:bg-sky disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:text-sm"
              disabled={safeGroupIndex <= 0}
              onClick={() => {
                setSelectedGroupIndex((current) => Math.max(0, current - 1));
                setReportPage(1);
              }}
              type="button"
            >
              <ChevronLeft aria-hidden="true" className="size-4" /> Trước
            </button>
            {pageGroups.map((group, idx) => (
              <button
                aria-current={idx === safeGroupIndex ? "page" : undefined}
                aria-label={`Trang ${idx + 1}`}
                className={cn(
                  "min-h-11 min-w-10 rounded-control px-2.5 text-sm font-bold tabular-nums sm:px-3",
                  idx === safeGroupIndex
                    ? "bg-primary text-white"
                    : "border border-border bg-white text-ink hover:bg-canvas",
                )}
                key={group.key}
                onClick={() => {
                  setSelectedGroupIndex(idx);
                  setReportPage(1);
                }}
                type="button"
              >
                <span className="hidden sm:inline">Trang </span>
                {idx + 1}
              </button>
            ))}
            <button
              aria-label="Trang sau"
              className="inline-flex min-h-11 items-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-bold text-primary hover:bg-sky disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:text-sm"
              disabled={safeGroupIndex >= pageGroups.length - 1}
              onClick={() => {
                setSelectedGroupIndex((current) =>
                  Math.min(pageGroups.length - 1, current + 1),
                );
                setReportPage(1);
              }}
              type="button"
            >
              Sau <ChevronRight aria-hidden="true" className="size-4" />
            </button>
          </div>
        </nav>
      ) : null}

      <section className="space-y-2.5" data-testid="standalone-primary-report">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-extrabold text-ink">
              {primaryImmutable
                ? "Đánh giá lượt đầu đã lưu"
                : "Đối chiếu chính đã lưu"}
            </h2>
            <span className="text-xs font-semibold text-muted tabular-nums">
              {formatHistoryDateTime(primaryReport.created_at)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {!primaryImmutable ? (
              <Button
                className="min-h-11 px-3 py-2 text-sm"
                disabled={deletingId !== null}
                fullWidth={false}
                isLoading={deletingId === primaryReport.report_id}
                onClick={() => {
                  setDeleteError(null);
                  setPendingDeleteId(primaryReport.report_id);
                }}
                type="button"
                variant="destructive"
              >
                <Trash2 aria-hidden="true" className="size-4" />
                Xóa báo cáo
              </Button>
            ) : (
              <span className="text-xs font-semibold text-muted">
                Kết quả lượt đầu được giữ nguyên
              </span>
            )}
          </div>
        </div>

        <ReadingReport result={primaryReport} sessionId={sessionId} />
      </section>

      {additionalReports.length > 0 ? (
        <details className="group rounded-card border border-border bg-white p-4 sm:p-5">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-extrabold text-ink">
            <span>
              Các lượt đối chiếu khác của trang này ({additionalReports.length})
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180"
            />
          </summary>
          <p className="mt-1 text-xs text-muted">
            Hệ thống ưu tiên hiển thị báo cáo chính ở trên để tránh lặp nội
            dung. Ba mẹ có thể mở xem hoặc xóa từng lượt đối chiếu bổ sung bên
            dưới.
          </p>
          <div className="mt-4 flex flex-col gap-5">
            {visibleAdditional.map((report, index) => {
              const immutable = isImmutableFirstPassReport(report);
              return (
                <section
                  className="space-y-2.5 border-t border-border pt-4 first:border-t-0 first:pt-0"
                  key={report.report_id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-extrabold text-ink">
                        {immutable
                          ? "Đánh giá lượt đầu đã lưu"
                          : `Lượt đối chiếu bổ sung #${startIdx + index + 1}`}
                      </h3>
                      <span className="text-xs font-semibold text-muted tabular-nums">
                        {formatHistoryDateTime(report.created_at)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      {!immutable ? (
                        <Button
                          className="min-h-11 px-3 py-2 text-sm"
                          disabled={deletingId !== null}
                          fullWidth={false}
                          isLoading={deletingId === report.report_id}
                          onClick={() => {
                            setDeleteError(null);
                            setPendingDeleteId(report.report_id);
                          }}
                          type="button"
                          variant="destructive"
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                          Xóa báo cáo
                        </Button>
                      ) : (
                        <span className="text-xs font-semibold text-muted">
                          Kết quả lượt đầu được giữ nguyên
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
            ariaLabel="Phân trang lượt đối chiếu bổ sung"
            itemLabel="lượt đối chiếu"
            onPageChange={setReportPage}
            page={reportPage}
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
              Hủy
            </Button>
            <Button
              disabled={deletingId !== null}
              fullWidth={false}
              isLoading={deletingId !== null}
              onClick={() => void confirmDeleteReport()}
              type="button"
              variant="destructive"
            >
              Xác nhận xóa
            </Button>
          </div>
        }
        isOpen={pendingDeleteId !== null}
        onClose={() => {
          if (deletingId === null) setPendingDeleteId(null);
        }}
        role="alertdialog"
        showCloseButton={deletingId === null}
        title="Xóa báo cáo đọc?"
        tone="paper"
      >
        <p className="text-body text-ink">
          Bạn có chắc chắn muốn xóa báo cáo đối chiếu này không? Kết quả đánh
          giá lượt đầu vẫn được giữ nguyên.
        </p>
      </Modal>
    </section>
  );
}
