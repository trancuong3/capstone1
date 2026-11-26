"use client";

import { ArrowLeft, ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { SessionEventList } from "@/components/reports/session-event-list";
import { SessionReadingReports } from "@/components/reports/session-reading-reports";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  formatHistoryDateTime,
  formatHistoryDuration,
  formatPercent,
  getHistoryStatePresentation,
  historyStateLabel,
} from "@/lib/utils/report-mappers";
import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type { ReadingSessionDetailDTO } from "@/types/reading";

type DetailState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly detail: ReadingSessionDetailDTO;
      readonly child: ChildProfileDTO;
      readonly book: BookDetailDTO;
    }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" }
  | { readonly status: "error" };

export function SessionDetailScreen({
  sessionId,
  requestedChildId,
  page = 1,
}: {
  readonly sessionId: string;
  readonly requestedChildId?: string;
  readonly page?: number;
}) {
  const { childService, sessionService } = useReportServices();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [eventsPage, setEventsPage] = useState(1);
  const [comprehensionPage, setComprehensionPage] = useState(1);
  const EVENTS_PAGE_SIZE = 10;
  const COMPREHENSION_PAGE_SIZE = 10;

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      try {
        const detail = await sessionService.get(sessionId);
        const [child, book] = await Promise.all([
          childService.get(detail.child_id),
          sessionService.getBook(sessionId),
        ]);
        if (book.id !== detail.book_id || child.id !== detail.child_id)
          throw new Error("Invalid historical book response");
        if (active) setState({ status: "ready", detail, child, book });
      } catch (error) {
        if (active)
          setState({
            status:
              isServiceError(error) && error.status === 404
                ? "not-found"
                : isServiceError(error) &&
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
  }, [childService, requestKey, sessionId, sessionService]);

  if (state.status === "loading")
    return (
      <section
        aria-busy="true"
        aria-label="Đang tải chi tiết buổi đọc"
        className="mx-auto flex w-full max-w-[1120px] flex-col gap-5"
      >
        <Skeleton className="h-28 rounded-card" />
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-80 rounded-card" />
      </section>
    );

  if (state.status === "unavailable")
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          Dữ liệu đang chờ bổ sung
        </h1>
        <StatusMessage tone="info">
          Dữ liệu của mục này chưa sẵn sàng theo định dạng hiện tại. Không có dữ
          liệu mẫu thay thế.
        </StatusMessage>
        <Button
          className="min-[640px]:w-auto min-[640px]:self-start min-[640px]:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" /> Thử lại
        </Button>
        <ButtonLink
          className="min-[640px]:w-auto min-[640px]:self-start"
          href="/children"
          variant="secondary"
        >
          Quản lý hồ sơ bé
        </ButtonLink>
      </section>
    );

  if (state.status === "not-found")
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          Không tìm thấy buổi đọc
        </h1>
        <StatusMessage tone="error">
          Buổi đọc không tồn tại hoặc không thuộc tài khoản hiện tại.
        </StatusMessage>
        <ButtonLink
          className="min-[640px]:w-auto min-[640px]:self-start"
          href="/sessions"
          variant="secondary"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Về lịch sử
        </ButtonLink>
      </div>
    );

  if (state.status === "error")
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <StatusMessage title="Chưa tải được chi tiết" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
        <Button
          className="min-[640px]:w-auto min-[640px]:self-start min-[640px]:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          Thử lại
        </Button>
      </div>
    );

  const { detail } = state;
  const metrics = detail.fluency_assessment?.metrics;
  const rangeIsPartial =
    detail.selected_range_pages != null &&
    (detail.pages_completed == null ||
      detail.pages_completed < detail.selected_range_pages);
  const returnPage =
    requestedChildId === detail.child_id &&
    Number.isSafeInteger(page) &&
    page >= 1 &&
    page <= 100000
      ? page
      : null;
  const returnHref = `/sessions?childId=${encodeURIComponent(detail.child_id)}${returnPage === null ? "" : `&page=${returnPage}`}`;
  const availability = detail.availability;
  const statePresentation = getHistoryStatePresentation(detail.state);

  const pageTitle =
    detail.state === "FINISHED"
      ? rangeIsPartial
        ? "Buổi đọc đã lưu"
        : "Buổi đọc đã hoàn thành"
      : detail.state === "ABORTED"
        ? "Buổi đọc đã dừng"
        : `Buổi đọc: ${historyStateLabel(detail.state)}`;

  const showComprehensionSectionDirectly =
    detail.comprehension.length > 0 || availability.comprehension !== "absent";

  const summaryItems: readonly (readonly [string, string])[] = [
    ["Thời lượng phiên", formatHistoryDuration(detail.duration_ms)],
    ...(detail.selected_range_pages == null
      ? []
      : ([
          ["Trang trong phạm vi", `${detail.selected_range_pages} trang`],
          [
            "Trang đã xác nhận hoàn thành",
            detail.pages_completed == null
              ? "Chưa ghi nhận"
              : `${detail.pages_completed} trang`,
          ],
        ] as const)),
    [
      "Độ chính xác",
      metrics?.accuracy_percent == null
        ? "Chưa ghi nhận"
        : formatPercent(metrics.accuracy_percent),
    ],
    [
      "Tốc độ đọc",
      metrics?.reading_wpm == null
        ? "Chưa ghi nhận"
        : `${metrics.reading_wpm} từ/phút`,
    ],
    [
      "Điểm trôi chảy",
      detail.fluency_assessment?.score == null
        ? availability.fluency === "absent"
          ? "Chưa đánh giá"
          : "Chưa có điểm hiển thị"
        : String(detail.fluency_assessment.score),
    ],
  ];

  const comprehensionSection = (
    <section
      aria-labelledby="session-comprehension-heading"
      className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 md:p-6"
    >
      <h2
        className="text-xl font-extrabold text-ink"
        id="session-comprehension-heading"
      >
        Câu hỏi đọc hiểu
      </h2>
      {availability.comprehension === "unsupported" ||
      availability.comprehension === "partial" ? (
        <StatusMessage tone="info">
          Có dữ liệu đọc hiểu đã lưu nhưng một phần định dạng chưa được hỗ trợ.{" "}
          {availability.comprehension === "partial"
            ? "Nội dung đọc được vẫn hiển thị bên dưới."
            : "Chưa thể hiển thị nội dung của nhóm này."}
        </StatusMessage>
      ) : null}
      {detail.comprehension.length === 0 &&
      availability.comprehension === "absent" ? (
        <p className="rounded-control border border-border bg-canvas px-4 py-4 text-sm text-muted">
          Buổi đọc này không có câu hỏi đọc hiểu.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-control border border-border">
            {detail.comprehension
              .slice(
                (comprehensionPage - 1) * COMPREHENSION_PAGE_SIZE,
                comprehensionPage * COMPREHENSION_PAGE_SIZE,
              )
              .map(({ answer, question }) => {
                const answerStatusLabel = answer
                  ? answer.is_correct === true
                    ? "Đúng"
                    : answer.is_correct === false
                      ? "Chưa đúng"
                      : "Chưa chấm"
                  : null;
                const answerBadgeClass =
                  answer?.is_correct === true
                    ? "bg-success-surface text-success-ink"
                    : answer?.is_correct === false
                      ? "bg-warning-surface text-warning"
                      : "bg-canvas text-muted ring-1 ring-inset ring-border";

                return (
                  <li className="space-y-1.5 p-4" key={question.id}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="break-words font-bold text-ink">
                        {question.prompt}
                      </p>
                      {answerStatusLabel ? (
                        <span
                          className={`shrink-0 rounded-control px-2.5 py-0.5 text-xs font-bold ${answerBadgeClass}`}
                        >
                          {answerStatusLabel}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs font-semibold text-muted">
                      Độ khó đã lưu: {question.difficulty ?? "Chưa ghi nhận"}
                    </p>
                    <p className="break-words text-sm text-ink">
                      {answer
                        ? `Trả lời: ${answer.submitted_answer} · ${answerStatusLabel}`
                        : question.answered
                          ? "Đã lưu câu trả lời nhưng định dạng chưa được hỗ trợ."
                          : "Chưa có câu trả lời"}
                    </p>
                  </li>
                );
              })}
          </ul>
          <PaginationBar
            ariaLabel="Phân trang câu hỏi đọc hiểu"
            compact
            itemLabel="câu hỏi"
            onPageChange={setComprehensionPage}
            page={comprehensionPage}
            pageSize={COMPREHENSION_PAGE_SIZE}
            total={detail.comprehension.length}
          />
        </>
      )}
    </section>
  );

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-3.5 pb-4 md:gap-5">
      <header className="flex flex-col justify-between gap-2.5 border-b border-border pb-3 md:gap-4 md:pb-5 lg:flex-row lg:items-end">
        <div className="min-w-0 max-w-3xl space-y-1.5 md:space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-control px-2.5 py-0.5 text-xs font-bold ${statePresentation.badgeClassName}`}
            >
              {statePresentation.label}
            </span>
            {rangeIsPartial ? (
              <span className="inline-flex items-center rounded-control border border-warning/25 bg-warning-surface px-2.5 py-0.5 text-xs font-bold text-warning">
                Hoàn thành một phần
              </span>
            ) : null}
          </div>
          <h1 className="book-title text-xl text-ink md:text-3xl lg:text-[38px]">
            {pageTitle}
          </h1>
          <p className="text-sm font-bold text-ink md:text-base">
            {state.book.title}
            <span className="font-semibold text-muted">
              {" "}
              · {state.child.alias}
            </span>
          </p>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-muted md:gap-x-6">
            <div className="flex gap-1.5">
              <dt>Bắt đầu:</dt>
              <dd className="tabular-nums text-ink">
                {formatHistoryDateTime(detail.started_at)}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Kết thúc:</dt>
              <dd className="tabular-nums text-ink">
                {detail.ended_at === null
                  ? "Chưa lưu giờ kết thúc"
                  : formatHistoryDateTime(detail.ended_at)}
              </dd>
            </div>
          </dl>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <ButtonLink
            className="min-h-11 w-auto px-3 py-2 text-xs md:px-5 md:text-label"
            href={returnHref}
            variant="secondary"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Lịch sử
          </ButtonLink>
        </div>
      </header>

      {rangeIsPartial ? (
        <StatusMessage title="Một phần phạm vi chưa hoàn thành" tone="info">
          Phạm vi đã chọn có {detail.selected_range_pages} trang, mới có{" "}
          {detail.pages_completed ?? 0} trang được xác nhận hoàn thành. Các
          trang chưa đọc không được tính là hoàn thành.
        </StatusMessage>
      ) : null}

      {detail.state !== "FINISHED" && detail.state !== "ABORTED" ? (
        <StatusMessage title="Dữ liệu đang dở dang" tone="warning">
          Buổi đọc chưa kết thúc nên thời lượng, chỉ số trôi chảy và báo cáo có
          thể chưa đầy đủ.
        </StatusMessage>
      ) : null}

      {detail.state === "FINISHED" && detail.ended_at === null ? (
        <StatusMessage tone="info">
          Buổi đọc đã hoàn thành nhưng chưa lưu giờ kết thúc; chưa có dữ liệu
          thời lượng.
        </StatusMessage>
      ) : null}

      <section
        aria-labelledby="session-overview-heading"
        className="rounded-card border border-border bg-white"
      >
        <div className="border-b border-border px-4 py-3.5 md:px-6">
          <h2
            className="text-lg font-extrabold text-ink"
            id="session-overview-heading"
          >
            Tóm tắt buổi đọc
          </h2>
        </div>

        {availability.fluency === "unsupported" ||
        availability.fluency === "partial" ? (
          <div className="px-4 pt-4 md:px-6">
            <StatusMessage tone="info">
              Có dữ liệu đánh giá đã lưu nhưng định dạng chưa được hỗ trợ đầy
              đủ. Chỉ hiển thị điểm và chỉ số đọc được, không tự quy đổi dữ liệu
              thiếu.
            </StatusMessage>
          </div>
        ) : null}

        <dl className="grid grid-cols-2 min-[640px]:grid-cols-3">
          {summaryItems.map(([label, value], index) => {
            const isMissing = value.startsWith("Chưa");
            const cellBorders = [
              "min-w-0 border-border p-3 md:px-6 md:py-4",
              index % 2 === 0 ? "max-[640px]:border-r" : "",
              index >= 2 ? "max-[640px]:border-t" : "",
              index % 3 !== 2 ? "min-[640px]:border-r" : "",
              index >= 3 ? "min-[640px]:border-t" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div className={cellBorders} key={label}>
                <dt className="text-xs font-bold text-muted">{label}</dt>
                <dd
                  className={
                    isMissing
                      ? "mt-1 text-sm font-semibold text-muted"
                      : "mt-1 text-lg font-extrabold leading-snug tabular-nums text-primary md:text-xl"
                  }
                >
                  {value}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <SessionReadingReports sessionId={sessionId} />

      {showComprehensionSectionDirectly ? comprehensionSection : null}

      <details className="group rounded-card border border-border bg-white p-4 md:p-6">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 font-extrabold text-primary">
          <span>Thông tin khác của buổi đọc</span>
          <ChevronDown
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="mt-4 flex flex-col gap-5 border-t border-border pt-4">
          <section className="flex flex-col gap-3">
            <h2 className="text-xl font-extrabold text-ink">
              Sự kiện trong buổi đọc
            </h2>
            {availability.events === "unsupported" ||
            availability.events === "partial" ? (
              <StatusMessage tone="info">
                Có sự kiện đã lưu nhưng{" "}
                {availability.events === "partial" ? "một phần" : "định dạng"}{" "}
                chưa được hỗ trợ. Không tự coi đây là lỗi đọc đã xác nhận.
              </StatusMessage>
            ) : null}
            {detail.events.length > 0 || availability.events === "absent" ? (
              <>
                <SessionEventList
                  events={detail.events.slice(
                    (eventsPage - 1) * EVENTS_PAGE_SIZE,
                    eventsPage * EVENTS_PAGE_SIZE,
                  )}
                />
                <PaginationBar
                  ariaLabel="Phân trang sự kiện trong buổi đọc"
                  compact
                  itemLabel="sự kiện"
                  onPageChange={setEventsPage}
                  page={eventsPage}
                  pageSize={EVENTS_PAGE_SIZE}
                  total={detail.events.length}
                />
              </>
            ) : null}
          </section>

          {!showComprehensionSectionDirectly ? comprehensionSection : null}
        </div>
      </details>
    </section>
  );
}
