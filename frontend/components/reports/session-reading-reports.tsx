"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { BookPageContent } from "@/components/reading/book-page-content";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import {
  deleteReadingReport,
  getReadingPage,
  getSessionReports,
  type ReadingPage,
  type SavedReadingReport,
} from "@/lib/api/comparison-service";
import { isServiceError } from "@/lib/api/service-error";
import { cn } from "@/lib/utils/cn";
import { formatHistoryDateTime } from "@/lib/utils/report-mappers";
import {
  buildReportWordMetrics,
  groupSessionReportsByPageRevision,
  isImmutableFirstPassReport,
  REPORT_WORD_LEGEND,
  type ReportWordMetricKey,
  type SessionPageReportGroup,
} from "@/lib/utils/session-report-grouping";
import type { ReadingAssessmentMetricsDTO } from "@/types/reading";

type PageLoadEntry =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly page: ReadingPage }
  | { readonly status: "error" };

type ReportsState =
  | { readonly status: "loading" }
  | {
      readonly status: "empty";
      readonly assessment?: ReadingAssessmentMetricsDTO | null;
    }
  | {
      readonly status: "ready";
      readonly rawReports: readonly SavedReadingReport[];
      readonly totalFromServer: number;
      readonly assessment?: ReadingAssessmentMetricsDTO | null;
    }
  | { readonly status: "unavailable" }
  | { readonly status: "error" };

function ReportCard({
  group,
  activeReport,
  pageEntry,
  pageNumber,
  pageCount,
  selectedMetric,
  onSelectMetric,
  onSelectReport,
  onRequestDelete,
  deletingId,
  onPrevious,
  onNext,
  groups,
  pageCache,
  onSelectPageIndex,
  activeIndex,
}: {
  readonly group: SessionPageReportGroup;
  readonly activeReport: SavedReadingReport;
  readonly pageEntry: PageLoadEntry;
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly selectedMetric: ReportWordMetricKey | null;
  readonly onSelectMetric: (key: ReportWordMetricKey) => void;
  readonly onSelectReport: (reportId: string) => void;
  readonly onRequestDelete?: (reportId: string) => void;
  readonly deletingId: string | null;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly groups: readonly SessionPageReportGroup[];
  readonly pageCache: ReadonlyMap<string, PageLoadEntry>;
  readonly onSelectPageIndex: (index: number) => void;
  readonly activeIndex: number;
}) {
  const metrics = buildReportWordMetrics(activeReport);
  const activeMetric = metrics.find((metric) => metric.key === selectedMetric);
  const resolvedPage =
    pageEntry.status === "ready" ? pageEntry.page : undefined;
  const isPrimary = activeReport.report_id === group.primaryReport.report_id;
  const isImmutable = isImmutableFirstPassReport(activeReport);

  return (
    <article
      className="flex flex-col gap-5"
      data-active-report-id={activeReport.report_id}
      data-report-group={group.key}
    >
      <div className="flex flex-col justify-between gap-3 border-b border-border pb-3.5 sm:flex-row sm:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-extrabold text-ink sm:text-xl">
              {resolvedPage
                ? `Trang ${resolvedPage.page_number}`
                : `Trang đã đọc ${pageNumber}`}
            </h3>
            <span className="rounded-control bg-canvas px-2.5 py-0.5 text-xs font-bold text-muted ring-1 ring-inset ring-border">
              {isImmutable
                ? "Đánh giá lượt đầu"
                : isPrimary
                  ? "Đối chiếu đã lưu"
                  : "Lượt đối chiếu khác"}
            </span>
          </div>
          <p className="mt-0.5 text-xs font-semibold text-muted tabular-nums">
            {pageNumber} / {pageCount} trang có báo cáo · Lưu lúc{" "}
            {formatHistoryDateTime(activeReport.created_at)}
          </p>
        </div>

        {pageCount > 1 ? (
          <nav
            aria-label="Chuyển báo cáo trang"
            className="flex flex-wrap items-center gap-1.5"
          >
            <button
              aria-label="Báo cáo trang trước"
              className="inline-flex min-h-11 items-center justify-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-bold text-primary hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:text-sm"
              disabled={pageNumber <= 1}
              onClick={onPrevious}
              type="button"
            >
              <ChevronLeft aria-hidden="true" className="size-4" /> Trước
            </button>
            <div className="flex flex-wrap items-center gap-1">
              {groups.map((item, idx) => {
                const cached = pageCache.get(item.key);
                const pageNum =
                  cached?.status === "ready"
                    ? cached.page.page_number
                    : idx + 1;
                const isSelected = idx === activeIndex;
                return (
                  <button
                    aria-current={isSelected ? "page" : undefined}
                    aria-label={`Trang ${pageNum}`}
                    className={cn(
                      "min-h-11 min-w-11 rounded-control px-2.5 text-sm font-bold tabular-nums transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      isSelected
                        ? "bg-primary text-white"
                        : "border border-border bg-white text-ink hover:bg-canvas",
                    )}
                    key={item.key}
                    onClick={() => onSelectPageIndex(idx)}
                    type="button"
                  >
                    {pageNum}
                  </button>
                );
              })}
            </div>
            <button
              aria-label="Báo cáo trang tiếp theo"
              className="inline-flex min-h-11 items-center justify-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-bold text-primary hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:text-sm"
              disabled={pageNumber >= pageCount}
              onClick={onNext}
              type="button"
            >
              Sau <ChevronRight aria-hidden="true" className="size-4" />
            </button>
          </nav>
        ) : null}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(290px,1fr)]">
        <div className="flex flex-col gap-3">
          <div className="rounded-card border border-border bg-cream p-3 sm:p-5">
            {pageEntry.status === "loading" ? (
              <div
                aria-busy="true"
                aria-label="Đang tải nội dung trang sách"
                className="space-y-3 p-3"
              >
                <Skeleton className="h-5 w-44" />
                <Skeleton className="h-36 rounded-control" />
              </div>
            ) : resolvedPage ? (
              <article
                className="relative mx-auto flex min-h-[220px] w-full flex-col rounded-control bg-[#fffdfa] p-3.5 sm:min-h-[280px] sm:p-6"
                data-page-id={resolvedPage.page_id}
                data-page-revision-id={resolvedPage.page_revision_id}
              >
                <header className="mb-2 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-control bg-success-surface px-2.5 py-1 text-xs font-bold text-success-ink">
                    <span className="size-1.5 rounded-full bg-success-ink" />
                    Nội dung trang đã xác minh
                  </span>
                  <span className="text-xs font-bold tabular-nums text-muted">
                    Trang {resolvedPage.page_number}
                  </span>
                </header>
                <BookPageContent
                  comparisonResult={activeReport}
                  page={resolvedPage}
                  selfCorrectedWordIds={
                    new Set(activeReport.self_corrected_word_ids ?? [])
                  }
                  readOnly
                />
                {(activeReport.self_corrected_word_ids?.length ?? 0) > 0 ? (
                  <p className="mt-3 inline-flex items-center gap-1.5 self-start rounded-control border border-green-600/30 bg-green-100 px-3 py-1 text-xs font-bold text-green-900">
                    <span aria-hidden="true">↺</span>
                    Đã đọc lại đúng:{" "}
                    {activeReport.self_corrected_word_ids?.length ?? 0} từ
                  </p>
                ) : null}
              </article>
            ) : (
              <div className="flex min-h-44 items-center justify-center rounded-control bg-white/80 p-5 text-center text-sm text-muted">
                Chưa tải được nội dung trang sách đã đọc theo đúng phiên bản lúc
                bé đọc. Lời đọc và thống kê đã lưu vẫn được giữ nguyên.
              </div>
            )}
          </div>

          <ul
            aria-label="Chú giải màu đối chiếu"
            className="flex flex-wrap gap-1.5 text-xs font-semibold"
          >
            {REPORT_WORD_LEGEND.map((legend) => (
              <li
                className={`rounded-control border px-2.5 py-1 ${legend.swatchClassName}`}
                key={legend.key}
              >
                {legend.label}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-4">
          <div className="space-y-2">
            <p className="text-xs font-bold text-muted">
              Phân loại từ trên trang (chạm vào mục để xem chi tiết)
            </p>
            <div className="grid grid-cols-2 gap-2">
              {metrics.map((metric) => {
                const isSelected = selectedMetric === metric.key;
                return (
                  <button
                    aria-expanded={isSelected}
                    className={cn(
                      "min-h-18 rounded-control border p-3 text-left transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      isSelected
                        ? "border-primary bg-sky"
                        : "border-border bg-white hover:bg-canvas",
                    )}
                    key={metric.key}
                    onClick={() => onSelectMetric(metric.key)}
                    type="button"
                  >
                    <span
                      className={`block text-xs font-bold ${metric.accentClassName}`}
                    >
                      {metric.label}
                    </span>
                    <span className="mt-1 block text-2xl font-extrabold tabular-nums text-ink">
                      {metric.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {activeMetric ? (
            <section
              aria-live="polite"
              className="rounded-control border border-primary/30 bg-cream p-3.5"
            >
              <h4
                className={`text-sm font-extrabold ${activeMetric.accentClassName}`}
              >
                {activeMetric.label} · {activeMetric.count}
              </h4>
              {activeMetric.words.length > 0 ? (
                <ul className="mt-2.5 flex flex-wrap gap-1.5">
                  {activeMetric.words.map((word, index) => (
                    <li
                      className="rounded-control border border-border bg-white px-2.5 py-1 text-sm font-bold text-ink"
                      key={`${word}-${index}`}
                    >
                      {word}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-sm text-muted">
                  Không có từ nào trong mục này.
                </p>
              )}
            </section>
          ) : null}

          <div className="rounded-control border border-border bg-canvas/70 p-3.5">
            <p className="text-xs font-bold text-muted">Lời đọc đã ghi nhận</p>
            <p className="mt-1 text-sm leading-relaxed text-ink">
              {activeReport.transcript.trim() || "Chưa ghi nhận"}
            </p>
          </div>
        </div>
      </div>

      {group.additionalReports.length > 0 ? (
        <details className="group rounded-control border border-border bg-canvas/60 px-4 py-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm font-bold text-ink">
            <span>
              Các lượt đối chiếu khác của trang này (
              {group.additionalReports.length})
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180"
            />
          </summary>
          <p className="mt-1 text-xs text-muted">
            Hệ thống ưu tiên hiển thị đánh giá lượt đầu của trang. Các lượt đối
            chiếu bổ sung vẫn được giữ lại bên dưới để ba mẹ đối chiếu hoặc quản
            lý.
          </p>
          <ul className="mt-3 divide-y divide-border rounded-control border border-border bg-white">
            {group.allReports.map((entry, idx) => {
              const selected = entry.report_id === activeReport.report_id;
              const entryImmutable = isImmutableFirstPassReport(entry);
              return (
                <li
                  className="flex flex-col justify-between gap-2.5 px-3.5 py-3 sm:flex-row sm:items-center"
                  key={entry.report_id}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-ink">
                        {entryImmutable
                          ? "Đánh giá lượt đầu đã lưu"
                          : idx === 0
                            ? "Đối chiếu chính"
                            : `Lượt đối chiếu bổ sung #${idx}`}
                      </span>
                      <span className="text-xs text-muted tabular-nums">
                        {formatHistoryDateTime(entry.created_at)}
                      </span>
                      {selected ? (
                        <span className="rounded-control bg-sky px-2 py-0.5 text-xs font-bold text-primary-hover">
                          Đang xem
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted">
                      {entry.transcript.trim() || "Chưa ghi nhận lời đọc"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!selected ? (
                      <Button
                        className="min-h-11 px-3 py-2 text-xs"
                        fullWidth={false}
                        onClick={() => onSelectReport(entry.report_id)}
                        type="button"
                        variant="secondary"
                      >
                        Xem lượt này
                      </Button>
                    ) : null}
                    {entryImmutable ? (
                      <span className="text-xs font-semibold text-muted">
                        Được giữ nguyên
                      </span>
                    ) : onRequestDelete ? (
                      <Button
                        className="min-h-11 px-3 py-2 text-xs"
                        disabled={deletingId !== null}
                        fullWidth={false}
                        isLoading={deletingId === entry.report_id}
                        onClick={() => onRequestDelete(entry.report_id)}
                        type="button"
                        variant="destructive"
                      >
                        <Trash2 aria-hidden="true" className="size-3.5" />
                        Xóa báo cáo
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

export function SessionReadingReports({
  sessionId,
  showAssessment = true,
  allowDelete = true,
}: {
  readonly sessionId: string;
  readonly showAssessment?: boolean;
  readonly allowDelete?: boolean;
}) {
  const [requestKey, setRequestKey] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedReportIdByGroup, setSelectedReportIdByGroup] = useState<
    Readonly<Record<string, string>>
  >({});
  const [selectedMetric, setSelectedMetric] =
    useState<ReportWordMetricKey | null>(null);
  const [state, setState] = useState<ReportsState>({ status: "loading" });
  const [pageCache, setPageCache] = useState<
    ReadonlyMap<string, PageLoadEntry>
  >(() => new Map());
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const requestedPageKeysRef = useRef<Set<string>>(new Set());
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    let active = true;
    const generation = ++loadGenerationRef.current;
    requestedPageKeysRef.current = new Set();

    async function load(): Promise<void> {
      setState({ status: "loading" });
      setSelectedIndex(0);
      setSelectedReportIdByGroup({});
      setSelectedMetric(null);
      setPageCache(new Map());
      setDeleteError(null);
      try {
        const result = await getSessionReports(sessionId);
        if (!active || loadGenerationRef.current !== generation) return;
        if (result.reports.length === 0) {
          setState({ status: "empty", assessment: result.assessment });
          return;
        }
        setState({
          status: "ready",
          assessment: result.assessment,
          rawReports: result.reports,
          totalFromServer: result.total,
        });
      } catch (error) {
        if (!active || loadGenerationRef.current !== generation) return;
        setState({
          status:
            isServiceError(error) &&
            (error.status === 501 || error.status === 503)
              ? "unavailable"
              : "error",
        });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [requestKey, sessionId]);

  const groups = useMemo(
    () =>
      state.status === "ready"
        ? groupSessionReportsByPageRevision(state.rawReports)
        : [],
    [state],
  );

  const activeIndex =
    groups.length > 0 ? Math.min(selectedIndex, groups.length - 1) : 0;
  const activeGroup = groups[activeIndex] ?? null;

  // Lazy-load ONLY the currently active page revision on demand and cache it
  // for this session, avoiding eager N-page Promise.all bursts.
  useEffect(() => {
    if (!activeGroup) return;
    const key = activeGroup.key;
    if (requestedPageKeysRef.current.has(key)) return;
    requestedPageKeysRef.current.add(key);

    const generation = loadGenerationRef.current;
    setPageCache((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, { status: "loading" });
      return next;
    });

    void getReadingPage(
      activeGroup.pageId,
      sessionId,
      activeGroup.pageRevisionId,
    )
      .then((page) => {
        if (loadGenerationRef.current !== generation) return;
        const revisionMatches =
          page.page_id === activeGroup.pageId &&
          page.page_revision_id === activeGroup.pageRevisionId;
        setPageCache((prev) => {
          const next = new Map(prev);
          next.set(
            key,
            revisionMatches ? { status: "ready", page } : { status: "error" },
          );
          return next;
        });
      })
      .catch(() => {
        if (loadGenerationRef.current !== generation) return;
        setPageCache((prev) => {
          const next = new Map(prev);
          next.set(key, { status: "error" });
          return next;
        });
      });
  }, [activeGroup, requestKey, sessionId]);

  async function confirmDeleteReport(): Promise<void> {
    if (!pendingDeleteId || deletingId) return;
    const targetId = pendingDeleteId;
    setDeletingId(targetId);
    setDeleteError(null);
    try {
      await deleteReadingReport(targetId);
      setState((current) => {
        if (current.status !== "ready") return current;
        const remaining = current.rawReports.filter(
          (item) => item.report_id !== targetId,
        );
        if (remaining.length === 0) {
          return { status: "empty", assessment: current.assessment };
        }
        return {
          ...current,
          rawReports: remaining,
          totalFromServer: Math.max(
            remaining.length,
            current.totalFromServer - 1,
          ),
        };
      });
      setPendingDeleteId(null);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Không thể xóa báo cáo.",
      );
      setPendingDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  }

  function selectMetric(key: ReportWordMetricKey): void {
    setSelectedMetric((current) => (current === key ? null : key));
  }

  const activePageEntry: PageLoadEntry = activeGroup
    ? (pageCache.get(activeGroup.key) ?? { status: "loading" })
    : { status: "loading" };

  const hasPartialWarning =
    state.status === "ready" &&
    (state.totalFromServer > state.rawReports.length ||
      Array.from(pageCache.values()).some((entry) => entry.status === "error"));

  const activeReport = activeGroup
    ? (activeGroup.allReports.find(
        (item) => item.report_id === selectedReportIdByGroup[activeGroup.key],
      ) ?? activeGroup.primaryReport)
    : null;

  return (
    <section
      aria-labelledby="session-reading-reports-title"
      className="flex flex-col gap-3.5 rounded-card border border-border bg-white p-3.5 sm:gap-5 sm:p-6"
      data-testid="session-primary-reading-report"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          className="book-title text-xl text-ink md:text-2xl"
          id="session-reading-reports-title"
        >
          Báo cáo đọc
        </h2>
        {state.status !== "loading" && state.status !== "empty" ? (
          <Button
            className="min-h-11 px-3 py-2 text-xs"
            fullWidth={false}
            onClick={() => setRequestKey((key) => key + 1)}
            variant="quiet"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Thử tải lại báo cáo
          </Button>
        ) : null}
      </div>

      {deleteError ? (
        <StatusMessage title="Không thể xóa báo cáo" tone="error">
          {deleteError}
        </StatusMessage>
      ) : null}

      {state.status === "loading" ? (
        <div aria-busy="true" className="space-y-4">
          <Skeleton className="h-24 rounded-control" />
          <Skeleton className="h-56 rounded-control" />
        </div>
      ) : null}

      {showAssessment &&
      (state.status === "ready" || state.status === "empty") ? (
        <ReadingAssessmentSummary assessment={state.assessment} embedded />
      ) : null}

      {state.status === "empty" ? (
        <p className="rounded-control border border-border bg-canvas px-4 py-5 text-sm text-muted">
          Buổi đọc này chưa có báo cáo đối chiếu được lưu.
        </p>
      ) : null}

      {state.status === "unavailable" ? (
        <StatusMessage title="Chưa tải được báo cáo" tone="info">
          Dịch vụ báo cáo hiện chưa sẵn sàng. Thông tin còn thiếu không được
          thay bằng dữ liệu ước tính.
        </StatusMessage>
      ) : null}

      {state.status === "error" ? (
        <StatusMessage title="Có lỗi khi tải báo cáo" tone="error">
          Báo cáo chưa tải được. Ba mẹ vui lòng thử lại.
        </StatusMessage>
      ) : null}

      {state.status === "ready" && activeGroup && activeReport ? (
        <>
          {hasPartialWarning ? (
            <StatusMessage title="Báo cáo chỉ tải được một phần" tone="warning">
              Một số nội dung trang sách đã đọc chưa tải được; hệ thống không
              thay bằng trang mới hơn. Lời đọc, kết quả đối chiếu và thống kê đã
              lưu vẫn được giữ nguyên bên dưới.
            </StatusMessage>
          ) : null}

          <ReportCard
            activeIndex={activeIndex}
            activeReport={activeReport}
            deletingId={deletingId}
            group={activeGroup}
            groups={groups}
            onNext={() => {
              setSelectedIndex((index) =>
                Math.min(index + 1, groups.length - 1),
              );
              setSelectedMetric(null);
            }}
            onPrevious={() => {
              setSelectedIndex((index) => Math.max(index - 1, 0));
              setSelectedMetric(null);
            }}
            onRequestDelete={
              allowDelete
                ? (reportId) => {
                    setDeleteError(null);
                    setPendingDeleteId(reportId);
                  }
                : undefined
            }
            onSelectMetric={selectMetric}
            onSelectPageIndex={(index) => {
              setSelectedIndex(index);
              setSelectedMetric(null);
            }}
            onSelectReport={(reportId) => {
              setSelectedReportIdByGroup((prev) => ({
                ...prev,
                [activeGroup.key]: reportId,
              }));
              setSelectedMetric(null);
            }}
            pageCache={pageCache}
            pageCount={groups.length}
            pageEntry={activePageEntry}
            pageNumber={activeIndex + 1}
            selectedMetric={selectedMetric}
          />
        </>
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
          Bạn có chắc chắn muốn xóa lượt đối chiếu này không? Kết quả đánh giá
          lượt đầu vẫn được giữ nguyên.
        </p>
      </Modal>
    </section>
  );
}
