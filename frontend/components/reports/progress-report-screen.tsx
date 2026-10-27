"use client";

import { History, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { MetricCard } from "@/components/reports/metric-card";
import { ProgressChart } from "@/components/reports/progress-chart";
import { ProgressReportFilters } from "@/components/reports/progress-report-filters";
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
import type { ProgressPeriodsDTO, ProgressReportDTO } from "@/types/reports";

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
        const child = requestedChildId
          ? await childService.get(requestedChildId)
          : children[0];
        if (!children.some((item) => item.id === child.id)) {
          if (active) setState({ status: "not-found" });
          return;
        }
        const window = parseProgressPeriod(
          requestedPeriodStart,
          requestedPeriodEnd,
        );
        if (window === "invalid") return;
        const [reportResult, periodsResult] = await Promise.allSettled([
          reportService.get(child.id, window ?? undefined),
          reportService.listPeriods(child.id),
        ]);
        if (!active) return;
        const failure =
          reportResult.status === "rejected" ? reportResult.reason : null;
        const reportStatus =
          reportResult.status === "fulfilled"
            ? "ready"
            : isServiceError(failure) && failure.status === 404
              ? "empty"
              : isServiceError(failure) &&
                  (failure.status === 501 || failure.status === 503)
                ? "unavailable"
                : "error";
        setState({
          status: "loaded",
          children,
          child,
          report:
            reportResult.status === "fulfilled" ? reportResult.value : null,
          reportStatus,
          periods:
            periodsResult.status === "fulfilled"
              ? periodsResult.value
              : { items: [], next_cursor: null },
          periodsError: periodsResult.status === "rejected",
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
      <RefreshCw aria-hidden="true" className="size-5" />
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
        className="mx-auto flex max-w-[1120px] flex-col gap-6"
      >
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-80 rounded-card" />
      </section>
    );
  if (state.status === "no-children")
    return (
      <EmptyState
        headingLevel={1}
        title="Chưa có dữ liệu báo cáo"
        description="Tạo hồ sơ bé để xem các báo cáo đã lưu."
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
  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 sm:gap-8">
      <ReportPageHeader
        eyebrow="Tiến bộ của bé"
        title={`Cùng nhìn lại hành trình của ${child.alias}`}
        description="Hiển thị báo cáo đã lưu trong database, không tự tính lại sau mỗi buổi đọc. Mặc định mở kỳ báo cáo gần nhất."
        action={
          <ButtonLink
            className="sm:w-auto"
            href={`/sessions?childId=${encodeURIComponent(child.id)}`}
            variant="secondary"
          >
            <History aria-hidden="true" className="size-5" />
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
          Báo cáo tải thành công vẫn được hiển thị. Hãy thử lại để tải danh sách
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
          description="Không có báo cáo cho lựa chọn này. Có thể chọn bé khác hoặc kỳ khác; không có dữ liệu mẫu thay thế."
        />
      ) : null}
      {state.reportStatus === "unavailable" ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-2xl font-extrabold text-ink">
            Dữ liệu đang chờ bổ sung
          </h2>
          <StatusMessage>
            Dữ liệu của báo cáo chưa sẵn sàng theo định dạng hiện tại. Không có
            dữ liệu mẫu thay thế.
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
        <>
          <p className="text-label text-muted">
            Kỳ: {report.period_start} → {report.period_end} · Tạo lúc:{" "}
            {formatProgressGeneratedAt(report.generated_at)} (giờ Việt Nam).
          </p>
          {report.data_status !== "complete" ? (
            <StatusMessage
              title={
                report.data_status === "unsupported"
                  ? "Định dạng báo cáo chưa được hỗ trợ"
                  : "Báo cáo có dữ liệu chưa đầy đủ"
              }
            >
              Chỉ hiển thị giá trị hợp lệ đã lưu. Phần thiếu hoặc chưa hỗ trợ
              không được coi là số 0.
            </StatusMessage>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {mapReportMetrics(report).map((metric) => (
              <MetricCard key={metric.id} metric={metric} />
            ))}
          </div>
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <ProgressChart report={report} />
            <section
              className="rounded-card bg-cream p-5 sm:p-8"
              aria-labelledby="comparison-title"
            >
              <h2
                id="comparison-title"
                className="text-2xl font-extrabold text-ink"
              >
                So sánh trong báo cáo đã lưu
              </h2>
              {report.availability.comparison === "available" &&
              report.previous_period &&
              report.trend_deltas ? (
                <>
                  <p className="mt-3 text-label text-muted">
                    Chênh lệch với kỳ trước theo dữ liệu đã lưu; không tự suy ra
                    kỳ 30 ngày.
                  </p>
                  <dl className="mt-5 flex flex-col gap-4">
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
                        " điểm phần trăm",
                      ],
                    ].map(([label, value, suffix]) => (
                      <div key={String(label)}>
                        <dt className="font-bold text-muted">{label}</dt>
                        <dd className="text-xl font-extrabold text-ink">
                          {typeof value !== "number"
                            ? "Chưa đủ dữ liệu"
                            : `${value > 0 ? "+" : ""}${Number(value.toFixed(2))}${suffix}`}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <StatusMessage className="mt-5" title="Chưa đủ kỳ so sánh">
                  Không có dữ liệu so sánh hợp lệ đã lưu nên không đưa ra nhận
                  định tăng hoặc giảm.
                </StatusMessage>
              )}
            </section>
          </div>
          {report.legacy ? (
            <section className="rounded-card bg-white p-5 sm:p-8">
              <h2 className="text-2xl font-extrabold text-ink">
                Chỉ số định dạng cũ
              </h2>
              <p className="mt-2 text-label text-muted">
                Giữ nguyên tên trường; chưa quy đổi sang số buổi đọc hoặc phần
                trăm chính xác.
              </p>
              <dl className="mt-4 flex flex-col gap-3">
                {report.legacy.total_books !== null ? (
                  <div>
                    <dt>Tổng sách đã lưu (total_books)</dt>
                    <dd className="font-bold">{report.legacy.total_books}</dd>
                  </div>
                ) : null}
                {report.legacy.avg_fluency !== null ? (
                  <div>
                    <dt>Giá trị avg_fluency đã lưu (chưa xác định đơn vị)</dt>
                    <dd className="font-bold">{report.legacy.avg_fluency}</dd>
                  </div>
                ) : null}
              </dl>
            </section>
          ) : null}
          <section className="rounded-card bg-white p-5 sm:p-8">
            <h2 className="text-2xl font-extrabold text-ink">
              Từ cần luyện nổi bật
            </h2>
            <p className="mt-2 text-label text-muted">
              Dữ liệu của kỳ báo cáo đang hiển thị.
            </p>
            {report.availability.difficult_words !== "available" ? (
              <StatusMessage className="mt-4">
                Phần từ cần luyện của báo cáo thiếu hoặc chỉ đọc được một phần;
                không kết luận là không có từ cần luyện.
              </StatusMessage>
            ) : null}
            {report.difficult_words?.length ? (
              <ul className="mt-5 flex flex-wrap gap-3">
                {report.difficult_words.map((word, index) => (
                  <li
                    key={`${word.normalized_word}-${index}`}
                    className="rounded-full bg-warning-surface px-4 py-2 font-bold text-warning"
                  >
                    {word.display_text} · {word.difficulty_score}
                  </li>
                ))}
              </ul>
            ) : report.availability.difficult_words === "available" ? (
              <p className="mt-5 text-body text-muted">
                Báo cáo này chưa ghi nhận từ cần luyện.
              </p>
            ) : null}
            <ButtonLink
              className="mt-5 sm:w-auto"
              href={`/reports/difficult-words?childId=${encodeURIComponent(child.id)}`}
              variant="secondary"
            >
              Mở mục Từ cần luyện
            </ButtonLink>
            <p className="mt-2 text-label text-muted">
              Mục Từ cần luyện riêng giữ kỳ mặc định 90 ngày, không tự theo kỳ
              đang chọn ở đây.
            </p>
          </section>
        </>
      ) : null}
    </section>
  );
}
