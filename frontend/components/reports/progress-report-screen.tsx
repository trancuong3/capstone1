"use client";

import { BarChart3, History, RefreshCw, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ChildSelector } from "@/components/reports/child-selector";
import { MetricCard } from "@/components/reports/metric-card";
import { ProgressChart } from "@/components/reports/progress-chart";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  formatDuration,
  formatPercent,
  mapReportMetrics,
} from "@/lib/utils/report-mappers";
import {
  createCalendarWindow,
  currentDateInReportTimezone,
  REPORT_DEFAULT_DAYS,
} from "@/lib/utils/report-state";
import type { ChildProfileDTO } from "@/types/child";
import type { ProgressReportDTO } from "@/types/reports";

type ReportState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly children: readonly ChildProfileDTO[];
      readonly child: ChildProfileDTO;
      readonly report: ProgressReportDTO;
    }
  | { readonly status: "no-children" }
  | { readonly status: "not-found" }
  | { readonly status: "error" };

function signed(value: number | null, suffix = ""): string {
  if (value === null) return "Chưa đủ dữ liệu";
  return `${value > 0 ? "+" : ""}${value}${suffix}`;
}

export function ProgressReportScreen({
  requestedChildId,
}: {
  readonly requestedChildId?: string;
}) {
  const { childService, reportService } = useReportServices();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ReportState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      try {
        const children = await childService.list();
        if (children.length === 0) {
          if (active) setState({ status: "no-children" });
          return;
        }
        const child = requestedChildId
          ? await childService.get(requestedChildId)
          : children[0];
        const report = await reportService.get(
          child.id,
          createCalendarWindow(
            currentDateInReportTimezone(),
            REPORT_DEFAULT_DAYS,
          ),
        );
        if (active) setState({ status: "ready", children, child, report });
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
    };
  }, [childService, reportService, requestKey, requestedChildId]);

  if (state.status === "loading")
    return (
      <section
        aria-busy="true"
        aria-label="Đang tải báo cáo tiến bộ"
        className="mx-auto flex max-w-[1120px] flex-col gap-6"
      >
        <Skeleton className="h-32 rounded-card" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton className="h-44 rounded-card" key={item} />
          ))}
        </div>
        <Skeleton className="h-80 rounded-card" />
      </section>
    );
  if (state.status === "no-children")
    return (
      <EmptyState
        headingLevel={1}
        action={<ButtonLink href="/children/new">Tạo hồ sơ bé</ButtonLink>}
        description="Tạo hồ sơ và bắt đầu đọc để theo dõi tiến bộ."
        icon={<BarChart3 aria-hidden="true" className="size-10 text-primary" />}
        title="Chưa có dữ liệu báo cáo"
      />
    );
  if (state.status === "not-found")
    return (
      <StatusMessage title="Không tìm thấy báo cáo" tone="error">
        Dữ liệu không tồn tại hoặc không thuộc tài khoản hiện tại.
      </StatusMessage>
    );
  if (state.status === "error")
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <StatusMessage title="Chưa tải được báo cáo" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </div>
    );

  const { child, children, report } = state;
  const metrics = mapReportMetrics(report);
  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 sm:gap-8">
      <ReportPageHeader
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
        description="Tổng hợp 30 ngày lịch theo múi giờ Asia/Ho_Chi_Minh; chỉ tính buổi FINISHED theo ended_at."
        eyebrow="Tiến bộ của bé"
        title={`Cùng nhìn lại hành trình của ${child.alias}`}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full max-w-md">
          <ChildSelector
            childrenProfiles={children}
            selectedChildId={child.id}
          />
        </div>
        <p className="text-label font-bold text-muted">
          {report.period_start} → {report.period_end}
        </p>
      </div>
      {report.completed_sessions === 0 ? (
        <EmptyState
          action={
            <ButtonLink href={`/books?childId=${encodeURIComponent(child.id)}`}>
              Chọn sách để đọc
            </ButtonLink>
          }
          description="Chưa có buổi FINISHED trong cửa sổ 30 ngày này."
          title="Chưa có dữ liệu trong kỳ"
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
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
            className="text-2xl font-extrabold text-ink"
            id="comparison-title"
          >
            So với 30 ngày trước
          </h2>
          {report.previous_period ? (
            <dl className="mt-5 flex flex-col gap-4">
              <div>
                <dt className="text-label font-bold text-muted">
                  Buổi hoàn thành
                </dt>
                <dd className="text-2xl font-extrabold text-ink">
                  {signed(report.trend_deltas.completed_sessions)}
                </dd>
              </div>
              <div>
                <dt className="text-label font-bold text-muted">
                  Thời gian đọc
                </dt>
                <dd className="text-2xl font-extrabold text-ink">
                  {report.trend_deltas.reading_duration_ms == null
                    ? "Chưa đủ dữ liệu"
                    : signed(
                        Math.round(
                          report.trend_deltas.reading_duration_ms / 60_000,
                        ),
                        " phút",
                      )}
                </dd>
              </div>
              <div>
                <dt className="text-label font-bold text-muted">Đọc hiểu</dt>
                <dd className="text-2xl font-extrabold text-ink">
                  {signed(report.trend_deltas.comprehension_accuracy, "%")}
                </dd>
              </div>
            </dl>
          ) : (
            <StatusMessage className="mt-5" title="Chưa đủ kỳ so sánh">
              Không có kỳ trước hợp lệ nên hệ thống không đưa ra nhận định tăng
              hoặc giảm.
            </StatusMessage>
          )}
        </section>
      </div>
      <section className="rounded-card bg-white p-5 sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-extrabold text-ink">
              Từ cần luyện nổi bật
            </h2>
            <p className="mt-1 text-label text-muted">
              Bằng chứng 90 ngày, điểm tối thiểu 3.
            </p>
          </div>
          <ButtonLink
            className="sm:w-auto"
            href={`/reports/difficult-words?childId=${encodeURIComponent(child.id)}`}
            variant="secondary"
          >
            <Volume2 aria-hidden="true" className="size-5" />
            Xem tất cả
          </ButtonLink>
        </div>
        {report.difficult_words.length ? (
          <ul className="mt-5 flex flex-wrap gap-3">
            {report.difficult_words.map((word) => (
              <li
                className="rounded-full bg-warning-surface px-4 py-2 font-bold text-warning"
                key={word.normalized_word}
              >
                {word.display_text} · {word.difficulty_score}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-5 text-body text-muted">
            Chưa có từ đạt đủ ngưỡng bằng chứng.
          </p>
        )}
      </section>
      <p className="text-label text-muted">
        Thời gian đọc kỳ này: {formatDuration(report.reading_duration_ms)} · đọc
        hiểu: {formatPercent(report.comprehension_accuracy)}.
      </p>
    </section>
  );
}
