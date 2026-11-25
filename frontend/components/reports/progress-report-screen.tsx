"use client";

import { ArrowRight, History, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ChildProgressAssessmentCard } from "@/components/reports/child-progress-assessment";
import {
  MetricCard,
  type MetricCardDelta,
} from "@/components/reports/metric-card";
import { ProgressChart } from "@/components/reports/progress-chart";
import { ProgressReportFilters } from "@/components/reports/progress-report-filters";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import { mapReportMetrics } from "@/lib/utils/report-mappers";
import {
  formatProgressGeneratedAt,
  parseProgressPeriod,
  progressHref,
} from "@/lib/utils/progress-report-state";
import type { ChildProfileDTO } from "@/types/child";
import type {
  DifficultWordPracticeStatus,
  ProgressPeriodsDTO,
  ProgressReportDTO,
} from "@/types/reports";

interface Props {
  readonly requestedChildId?: string;
  readonly requestedPeriodStart?: string | string[];
  readonly requestedPeriodEnd?: string | string[];
}
type Loaded = {
  children: readonly ChildProfileDTO[];
  child: ChildProfileDTO;
  report: ProgressReportDTO | null;
  reportStatus: "ready" | "empty" | "unavailable" | "error";
  periods: ProgressPeriodsDTO;
  periodsError: boolean;
};
type State =
  | { status: "loading" | "no-children" | "not-found" | "error" }
  | ({ status: "loaded" } & Loaded);

const PRACTICE_STATUS_LABELS: Record<
  DifficultWordPracticeStatus,
  { readonly label: string; readonly className: string }
> = {
  NOT_PRACTICED: {
    label: "Chưa luyện",
    className: "border border-border bg-canvas text-muted",
  },
  IN_PROGRESS: {
    label: "Đang luyện",
    className: "border border-primary/20 bg-sky text-primary-hover",
  },
  NEEDS_MORE_PRACTICE: {
    label: "Cần luyện thêm",
    className: "border border-warning/25 bg-warning-surface text-warning",
  },
  COMPLETED: {
    label: "Đã hoàn thành",
    className:
      "border border-success-ink/20 bg-success-surface text-success-ink",
  },
};

function formatDeltaNumber(value: number): string {
  const rounded = Number(value.toFixed(1));
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function metricDeltaFor(
  report: ProgressReportDTO,
  metricId: string,
): MetricCardDelta | null {
  if (
    report.availability.comparison !== "available" ||
    !report.previous_period ||
    !report.trend_deltas
  ) {
    return null;
  }

  const deltas = report.trend_deltas;
  if (
    metricId === "sessions" &&
    typeof deltas.completed_sessions === "number"
  ) {
    const val = deltas.completed_sessions;
    return {
      label: `${formatDeltaNumber(val)} buổi`,
      tone: val > 0 ? "positive" : val < 0 ? "negative" : "neutral",
    };
  }
  if (
    metricId === "duration" &&
    typeof deltas.reading_duration_ms === "number"
  ) {
    const minutes = deltas.reading_duration_ms / 60_000;
    return {
      label: `${formatDeltaNumber(minutes)} phút`,
      tone: minutes > 0 ? "positive" : minutes < 0 ? "negative" : "neutral",
    };
  }
  if (
    metricId === "comprehension" &&
    typeof deltas.comprehension_accuracy === "number"
  ) {
    const val = deltas.comprehension_accuracy;
    return {
      label: `${formatDeltaNumber(val)} điểm %`,
      tone: val > 0 ? "positive" : val < 0 ? "negative" : "neutral",
    };
  }
  if (metricId === "omission" && typeof deltas.omission_rate === "number") {
    const val = deltas.omission_rate;
    // Lower omission rate is positive.
    return {
      label: `${formatDeltaNumber(val)} điểm %`,
      tone: val < 0 ? "positive" : val > 0 ? "negative" : "neutral",
    };
  }
  return null;
}

// Reset immediately on URL changes; an old child's report must not flash under new filters.
export function ProgressReportScreen(props: Props) {
  return <ProgressReportContent key={JSON.stringify(props)} {...props} />;
}

function ProgressReportContent({
  requestedChildId,
  requestedPeriodStart,
  requestedPeriodEnd,
}: Props) {
  const { childService, reportService } = useReportServices();
  const [state, setState] = useState<State>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showAllDifficultWords, setShowAllDifficultWords] = useState(false);
  const alive = useRef(true);
  const paging = useRef(false);
  const selected = parseProgressPeriod(
    requestedPeriodStart,
    requestedPeriodEnd,
  );

  useEffect(() => {
    alive.current = true;
    let active = true;
    if (
      parseProgressPeriod(requestedPeriodStart, requestedPeriodEnd) ===
      "invalid"
    )
      return;
    async function load() {
      setState({ status: "loading" });
      try {
        const children = await childService.list();
        if (!children.length) {
          if (active) setState({ status: "no-children" });
          return;
        }
        const matchedChild = requestedChildId
          ? children.find((item) => item.id === requestedChildId)
          : children[0];
        const child = matchedChild
          ? matchedChild
          : await childService.get(requestedChildId!);
        if (!children.some((item) => item.id === child.id)) {
          if (active) setState({ status: "not-found" });
          return;
        }
        const window = parseProgressPeriod(
          requestedPeriodStart,
          requestedPeriodEnd,
        );
        if (window === "invalid") return;
        const periods = await reportService
          .listPeriods(child.id)
          .catch(() => null);
        if (!active) return;
        const periodsValue = periods ?? { items: [], next_cursor: null };
        const periodsError = periods === null;
        if (!window && periods !== null && periods.items.length === 0) {
          setState({
            status: "loaded",
            children,
            child,
            report: null,
            reportStatus: "empty",
            periods: periodsValue,
            periodsError: false,
          });
          return;
        }
        let report: ProgressReportDTO | null = null;
        let reportStatus: "ready" | "empty" | "unavailable" | "error" = "error";
        try {
          report = await reportService.get(child.id, window ?? undefined);
          reportStatus = "ready";
        } catch (failure) {
          reportStatus =
            isServiceError(failure) && failure.status === 404
              ? "empty"
              : isServiceError(failure) &&
                  (failure.status === 501 || failure.status === 503)
                ? "unavailable"
                : "error";
        }
        if (!active) return;
        setState({
          status: "loaded",
          children,
          child,
          report,
          reportStatus,
          periods: periodsValue,
          periodsError,
        });
      } catch (error) {
        if (active)
          setState({
            status:
              isServiceError(error) && error.status === 404
                ? "not-found"
                : "error",
          });
      }
    }
    void load();
    return () => {
      active = false;
      alive.current = false;
    };
  }, [
    childService,
    reportService,
    requestedChildId,
    requestedPeriodStart,
    requestedPeriodEnd,
    retry,
  ]);

  async function loadMore() {
    if (
      state.status !== "loaded" ||
      !state.periods.next_cursor ||
      paging.current
    )
      return;
    const { child, periods } = state;
    paging.current = true;
    setLoadingMore(true);
    try {
      const page = await reportService.listPeriods(child.id, {
        cursor: periods.next_cursor ?? undefined,
      });
      if (alive.current)
        setState((current) => {
          if (current.status !== "loaded") return current;
          const keys = new Set(
            current.periods.items.map(
              (item) => `${item.period_start}/${item.period_end}`,
            ),
          );
          return {
            ...current,
            periodsError: false,
            periods: {
              items: [
                ...current.periods.items,
                ...page.items.filter(
                  (item) =>
                    !keys.has(`${item.period_start}/${item.period_end}`),
                ),
              ],
              next_cursor: page.next_cursor,
            },
          };
        });
    } catch {
      if (alive.current)
        setState((current) =>
          current.status === "loaded"
            ? { ...current, periodsError: true }
            : current,
        );
    } finally {
      paging.current = false;
      if (alive.current) setLoadingMore(false);
    }
  }

  const retryButton = (
    <Button
      className="sm:w-auto sm:self-start"
      variant="secondary"
      onClick={() => setRetry((value) => value + 1)}
    >
      <RefreshCw aria-hidden="true" className="size-4" />
      Thử lại
    </Button>
  );

  if (selected === "invalid")
    return (
      <section className="mx-auto flex max-w-[1120px] flex-col gap-4">
        <StatusMessage title="Kỳ báo cáo không hợp lệ" tone="error">
          Cần đủ ngày bắt đầu và kết thúc hợp lệ, ngày kết thúc không trước ngày
          bắt đầu.
        </StatusMessage>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href={requestedChildId ? progressHref(requestedChildId) : "/reports"}
        >
          Xem báo cáo mới nhất
        </ButtonLink>
      </section>
    );

  if (state.status === "loading")
    return (
      <section
        aria-busy="true"
        aria-label="Đang tải báo cáo tiến bộ"
        className="mx-auto flex w-full max-w-[1120px] flex-col gap-5"
      >
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-20 rounded-card" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-28 rounded-card" />
          <Skeleton className="h-28 rounded-card" />
          <Skeleton className="h-28 rounded-card" />
          <Skeleton className="h-28 rounded-card" />
        </div>
        <Skeleton className="h-64 rounded-card" />
      </section>
    );

  if (state.status === "no-children")
    return (
      <EmptyState
        headingLevel={1}
        title="Chưa có dữ liệu báo cáo"
        description="Tạo hồ sơ bé để theo dõi tiến bộ đọc theo từng kỳ."
        action={<ButtonLink href="/children/new">Tạo hồ sơ bé</ButtonLink>}
      />
    );

  if (state.status !== "loaded")
    return (
      <section className="mx-auto flex max-w-[1120px] flex-col gap-4">
        <StatusMessage
          title={
            state.status === "not-found"
              ? "Không tìm thấy báo cáo"
              : "Chưa tải được báo cáo"
          }
          tone="error"
        >
          Dữ liệu không tồn tại, không thuộc tài khoản hiện tại hoặc chưa tải
          được.
        </StatusMessage>
        {retryButton}
      </section>
    );

  const { child, children, report, periods } = state;
  const visibleDifficultWords = report?.difficult_words
    ? showAllDifficultWords
      ? report.difficult_words
      : report.difficult_words.slice(0, 8)
    : [];

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 pb-4">
      <ReportPageHeader
        eyebrow={`Đang theo dõi · ${child.alias} (Lớp ${child.grade})`}
        title={`Tiến bộ của ${child.alias}`}
        description="Tổng hợp kết quả đọc theo từng kỳ báo cáo đã lưu."
        action={
          <ButtonLink
            className="sm:w-auto"
            href={`/sessions?childId=${encodeURIComponent(child.id)}`}
            variant="secondary"
          >
            <History aria-hidden="true" className="size-4" />
            Lịch sử đọc
          </ButtonLink>
        }
      />

      <ProgressReportFilters
        childrenProfiles={children}
        childId={child.id}
        periods={periods.items}
        selectedPeriod={selected}
        hasMore={periods.next_cursor !== null}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
      />

      {state.periodsError ? (
        <StatusMessage tone="error" title="Chưa tải được danh sách kỳ">
          Báo cáo hiện tại vẫn được hiển thị. Ba mẹ có thể thử tải lại danh sách
          kỳ.
        </StatusMessage>
      ) : null}

      {state.reportStatus === "empty" ? (
        <EmptyState
          title={
            selected
              ? "Chưa có báo cáo cho kỳ đã chọn"
              : "Chưa có báo cáo đã lưu"
          }
          description="Không có báo cáo cho lựa chọn này. Ba mẹ có thể chọn bé khác hoặc kỳ khác; hệ thống không dùng số liệu mẫu thay thế."
        />
      ) : null}

      {state.reportStatus === "unavailable" ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-2xl font-extrabold text-ink">
            Dữ liệu đang chờ bổ sung
          </h2>
          <StatusMessage>
            Dữ liệu báo cáo hiện chưa sẵn sàng. Hệ thống không hiển thị số liệu
            ước tính thay thế.
          </StatusMessage>
        </section>
      ) : null}

      {state.reportStatus === "error" ? (
        <StatusMessage tone="error" title="Chưa tải được báo cáo">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
      ) : null}

      {state.periodsError ||
      state.reportStatus === "error" ||
      state.reportStatus === "unavailable"
        ? retryButton
        : null}

      {report ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted">
            <p className="font-semibold text-ink">
              Kỳ: {report.period_start} → {report.period_end}
            </p>
            <p className="text-xs">
              Cập nhật lúc {formatProgressGeneratedAt(report.generated_at)} (giờ
              Việt Nam), không tự tính lại sau mỗi buổi đọc.
            </p>
          </div>

          {report.data_status !== "complete" ? (
            <StatusMessage
              title={
                report.data_status === "unsupported"
                  ? "Định dạng báo cáo chưa được hỗ trợ"
                  : "Báo cáo có dữ liệu chưa đầy đủ"
              }
            >
              Chỉ hiển thị giá trị hợp lệ đã lưu. Phần thiếu hoặc chưa đọc được
              không được tính là 0.
            </StatusMessage>
          ) : null}

          {report.assessment_coverage &&
          report.assessment_coverage.assessed_sessions <
            report.assessment_coverage.total_sessions ? (
            <StatusMessage tone="info">
              Kết quả lượt đầu và luyện lại có dữ liệu ở{" "}
              {report.assessment_coverage.assessed_sessions}/
              {report.assessment_coverage.total_sessions} buổi. Các buổi còn
              thiếu không được tính thành đúng hoặc sai.
            </StatusMessage>
          ) : null}

          <div className="report-metrics grid grid-cols-2 overflow-hidden rounded-card border border-border bg-white lg:grid-cols-4">
            {mapReportMetrics(report).map((metric, index) => (
              <div
                className={[
                  "min-w-0 border-border",
                  index % 2 === 0 ? "border-r" : "",
                  index >= 2 ? "border-t lg:border-t-0" : "",
                  index < 3 ? "lg:border-r" : "lg:border-r-0",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={metric.id}
              >
                <MetricCard
                  delta={metricDeltaFor(report, metric.id)}
                  metric={metric}
                />
              </div>
            ))}
          </div>

          <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <ProgressChart report={report} />

            <section
              aria-labelledby="comparison-title"
              className="rounded-card border border-border bg-white p-5 sm:p-6"
            >
              <h2
                className="text-xl font-extrabold text-ink"
                id="comparison-title"
              >
                So sánh với kỳ trước
              </h2>
              {report.availability.comparison === "available" &&
              report.previous_period &&
              report.trend_deltas ? (
                <>
                  <p className="mt-1 text-sm text-muted">
                    Mức chênh lệch so với kỳ đã lưu liền trước.
                  </p>
                  <dl className="mt-4 divide-y divide-border">
                    {[
                      [
                        "Buổi hoàn thành",
                        report.trend_deltas.completed_sessions,
                        " buổi",
                      ],
                      [
                        "Thời gian đọc",
                        report.trend_deltas.reading_duration_ms === null
                          ? null
                          : report.trend_deltas.reading_duration_ms / 60000,
                        " phút",
                      ],
                      [
                        "Đọc hiểu",
                        report.trend_deltas.comprehension_accuracy,
                        " điểm %",
                      ],
                    ].map(([label, value, suffix]) => (
                      <div
                        className="flex items-baseline justify-between gap-4 py-3 first:pt-0 last:pb-0"
                        key={String(label)}
                      >
                        <dt className="text-sm font-semibold text-muted">
                          {label}
                        </dt>
                        <dd className="text-base font-extrabold tabular-nums text-ink">
                          {typeof value !== "number"
                            ? "Chưa đủ dữ liệu"
                            : `${value > 0 ? "+" : ""}${Number(value.toFixed(2))}${suffix}`}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <StatusMessage className="mt-4" title="Chưa đủ kỳ so sánh">
                  Chưa có kỳ liền trước hợp lệ để so sánh tăng hoặc giảm.
                </StatusMessage>
              )}
            </section>
          </div>

          <ReadingAssessmentSummary
            assessment={report.assessment}
            scopeLabel={`${report.period_start} → ${report.period_end}`}
          />

          <section className="rounded-card border border-border bg-white p-5 sm:p-6">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <h2 className="text-xl font-extrabold text-ink">
                  Từ cần luyện nổi bật
                </h2>
                <p className="mt-0.5 text-sm text-muted">
                  Danh sách ghi nhận trong kỳ báo cáo đang xem.
                </p>
              </div>
              <ButtonLink
                className="sm:w-auto"
                href={`/reports/difficult-words?childId=${encodeURIComponent(child.id)}`}
                variant="secondary"
              >
                Mở mục Từ cần luyện
                <ArrowRight aria-hidden="true" className="size-4" />
              </ButtonLink>
            </div>

            {report.availability.difficult_words !== "available" ? (
              <StatusMessage className="mt-4">
                Phần từ cần luyện của kỳ này thiếu hoặc chưa đọc được đầy đủ;
                không kết luận là bé không có từ cần luyện.
              </StatusMessage>
            ) : null}

            {report.difficult_words?.length ? (
              <>
                <p className="mt-3 text-xs font-bold text-muted">
                  Tổng cộng {report.difficult_words.length} từ cần luyện trong
                  kỳ này.
                </p>
                <ul className="mt-3 divide-y divide-border rounded-control border border-border">
                  {visibleDifficultWords.map((word, index) => {
                    const statusStyle = word.practice_status
                      ? PRACTICE_STATUS_LABELS[word.practice_status]
                      : null;
                    const noteParts: string[] = [];
                    if (word.session_count > 0) {
                      noteParts.push(`${word.session_count} buổi`);
                    }
                    if ((word.mispronunciation_count ?? 0) > 0) {
                      noteParts.push(`đọc nhầm ${word.mispronunciation_count}`);
                    }
                    if (word.omission_count > 0) {
                      noteParts.push(`bỏ sót ${word.omission_count}`);
                    }
                    if (word.repetition_count > 0) {
                      noteParts.push(`lặp ${word.repetition_count}`);
                    }

                    return (
                      <li
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                        key={`${word.normalized_word}-${index}`}
                      >
                        <div className="min-w-0">
                          <span className="text-base font-extrabold text-ink">
                            {word.display_text}
                          </span>
                          {noteParts.length > 0 ? (
                            <span className="ml-2 text-xs text-muted">
                              {noteParts.join(" · ")}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold tabular-nums text-muted">
                            Điểm {word.difficulty_score}
                          </span>
                          {statusStyle ? (
                            <span
                              className={`rounded-control px-2 py-0.5 text-xs font-bold ${statusStyle.className}`}
                            >
                              {statusStyle.label}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {report.difficult_words.length > 8 ? (
                  <Button
                    className="mt-3"
                    fullWidth={false}
                    onClick={() =>
                      setShowAllDifficultWords((current) => !current)
                    }
                    type="button"
                    variant="quiet"
                  >
                    {showAllDifficultWords
                      ? "Thu gọn"
                      : `Xem tất cả (${report.difficult_words.length})`}
                  </Button>
                ) : null}
              </>
            ) : report.availability.difficult_words === "available" ? (
              <p className="mt-4 text-sm text-muted">
                Báo cáo kỳ này chưa ghi nhận từ cần luyện.
              </p>
            ) : null}

            <p className="mt-3 text-xs text-muted">
              Lưu ý: Mục Từ cần luyện riêng mặc định tổng hợp 90 ngày gần nhất,
              không tự đổi theo kỳ báo cáo ở trên.
            </p>
          </section>

          {report.legacy ? (
            <section className="rounded-card border border-border bg-cream/60 p-5 sm:p-6">
              <h2 className="text-lg font-extrabold text-ink">
                Chỉ số định dạng cũ
              </h2>
              <p className="mt-1 text-sm text-muted">
                Giữ nguyên tên trường đã lưu; chưa quy đổi sang số buổi đọc hoặc
                phần trăm chính xác.
              </p>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                {report.legacy.total_books !== null ? (
                  <div>
                    <dt className="text-xs font-semibold text-muted">
                      Tổng sách đã lưu (total_books)
                    </dt>
                    <dd className="mt-0.5 text-lg font-extrabold tabular-nums text-ink">
                      {report.legacy.total_books}
                    </dd>
                  </div>
                ) : null}
                {report.legacy.avg_fluency !== null ? (
                  <div>
                    <dt className="text-xs font-semibold text-muted">
                      Giá trị avg_fluency đã lưu (chưa xác định đơn vị)
                    </dt>
                    <dd className="mt-0.5 text-lg font-extrabold tabular-nums text-ink">
                      {report.legacy.avg_fluency}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </section>
          ) : null}
        </div>
      ) : null}

      <ChildProgressAssessmentCard
        childId={child.id}
        childName={child.alias}
        showReadingAssessment={!report?.assessment}
      />
    </section>
  );
}
