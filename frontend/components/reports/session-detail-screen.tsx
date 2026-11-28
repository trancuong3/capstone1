"use client";

import { ArrowLeft, ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useIsMobileViewport } from "@/components/dashboard/use-is-mobile-viewport";
import { MobileSessionDetail } from "@/components/reports/mobile-session-detail";
import { SessionEventList } from "@/components/reports/session-event-list";
import { SessionReadingReports } from "@/components/reports/session-reading-reports";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  formatPercent,
  getHistoryStatePresentation,
} from "@/lib/utils/report-mappers";
import { REPORT_TIMEZONE } from "@/lib/utils/report-state";
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
  const { formatDateTime } = useI18n();
  const t = useTranslations("reports");
  const isMobile = useIsMobileViewport();
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
        aria-label={t("sessions.detail.loadingAria")}
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
          {t("sessions.pendingDataTitle")}
        </h1>
        <StatusMessage tone="info">
          {t("sessions.detail.pendingDesc")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />{" "}
          {t("sessions.retry")}
        </Button>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/children"
          variant="secondary"
        >
          {t("sessions.manageChildren")}
        </ButtonLink>
      </section>
    );

  if (state.status === "not-found")
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          {t("sessions.detail.notFoundTitle")}
        </h1>
        <StatusMessage tone="error">
          {t("sessions.detail.notFoundDesc")}
        </StatusMessage>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/sessions"
          variant="secondary"
        >
          <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
          {t("sessions.detail.backToHistory")}
        </ButtonLink>
      </div>
    );

  if (state.status === "error")
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <StatusMessage title={t("sessions.detail.loadErrorTitle")} tone="error">
          {t("sessions.loadErrorDesc")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {t("sessions.retry")}
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
  const stateLabel = t(`sessions.states.${detail.state}`);

  const durationLabel = (() => {
    const durationMs = detail.duration_ms;
    if (durationMs === null) return t("sessions.durationNoData");
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    if (totalSeconds < 60) {
      return t("sessions.durationSeconds", { seconds: totalSeconds });
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0
      ? t("sessions.durationMinutes", { minutes })
      : t("sessions.durationMinutesSeconds", { minutes, seconds });
  })();

  const formatSessionDateTime = (isoValue: string): string =>
    formatDateTime(isoValue, {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: REPORT_TIMEZONE,
    });

  const pageTitle =
    detail.state === "FINISHED"
      ? rangeIsPartial
        ? t("sessions.detail.savedSessionTitle")
        : t("sessions.detail.finishedSessionTitle")
      : detail.state === "ABORTED"
        ? t("sessions.detail.abortedSessionTitle")
        : t("sessions.detail.otherStateTitle", { state: stateLabel });

  const showComprehensionSectionDirectly =
    detail.comprehension.length > 0 || availability.comprehension !== "absent";

  const summaryItems: readonly {
    readonly label: string;
    readonly value: string;
    readonly isMissing: boolean;
  }[] = [
    {
      label: t("sessions.detail.metricDuration"),
      value: durationLabel,
      isMissing: detail.duration_ms === null,
    },
    ...(detail.selected_range_pages == null
      ? []
      : ([
          {
            label: t("sessions.detail.metricRangePages"),
            value: t("sessions.detail.rangePagesValue", {
              count: detail.selected_range_pages,
            }),
            isMissing: false,
          },
          {
            label: t("sessions.detail.metricCompletedPages"),
            value:
              detail.pages_completed == null
                ? t("sessions.detail.notRecorded")
                : t("sessions.detail.rangePagesValue", {
                    count: detail.pages_completed,
                  }),
            isMissing: detail.pages_completed == null,
          },
        ] as const)),
    {
      label: t("sessions.detail.metricAccuracy"),
      value:
        metrics?.accuracy_percent == null
          ? t("sessions.detail.notRecorded")
          : formatPercent(metrics.accuracy_percent),
      isMissing: metrics?.accuracy_percent == null,
    },
    {
      label: t("sessions.detail.metricWpm"),
      value:
        metrics?.reading_wpm == null
          ? t("sessions.detail.notRecorded")
          : t("sessions.detail.wpmValue", { count: metrics.reading_wpm }),
      isMissing: metrics?.reading_wpm == null,
    },
    {
      label: t("sessions.detail.metricFluency"),
      value:
        detail.fluency_assessment?.score == null
          ? availability.fluency === "absent"
            ? t("sessions.detail.notEvaluated")
            : t("sessions.detail.noDisplayScore")
          : String(detail.fluency_assessment.score),
      isMissing: detail.fluency_assessment?.score == null,
    },
  ];

  const comprehensionSection = (
    <section
      aria-labelledby="session-comprehension-heading"
      className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 sm:p-6"
    >
      <h2
        className="text-xl font-extrabold text-ink"
        id="session-comprehension-heading"
      >
        {t("sessions.detail.comprehensionTitle")}
      </h2>
      {availability.comprehension === "unsupported" ||
      availability.comprehension === "partial" ? (
        <StatusMessage tone="info">
          {t("sessions.detail.comprehensionPartial")}{" "}
          {availability.comprehension === "partial"
            ? t("sessions.detail.comprehensionSupportedHint")
            : t("sessions.detail.comprehensionUnsupportedHint")}
        </StatusMessage>
      ) : null}
      {detail.comprehension.length === 0 &&
      availability.comprehension === "absent" ? (
        <p className="rounded-control border border-border bg-canvas px-4 py-4 text-sm text-muted">
          {t("sessions.detail.noComprehensionQuestions")}
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
                    ? t("sessions.detail.answerCorrect")
                    : answer.is_correct === false
                      ? t("sessions.detail.answerIncorrect")
                      : t("sessions.detail.answerPending")
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
                      <p
                        className="viread-learning-content break-words font-bold text-ink"
                        dir="ltr"
                        lang="vi"
                      >
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
                      {t("sessions.detail.difficultyLabel", {
                        difficulty:
                          question.difficulty ??
                          t("sessions.detail.notRecorded"),
                      })}
                    </p>
                    <p className="break-words text-sm text-ink">
                      {answer
                        ? t("sessions.detail.answerDisplay", {
                            answer: answer.submitted_answer,
                            status: answerStatusLabel ?? "",
                          })
                        : question.answered
                          ? t("sessions.detail.answerUnsupported")
                          : t("sessions.detail.noAnswer")}
                    </p>
                  </li>
                );
              })}
          </ul>
          <PaginationBar
            ariaLabel={t("sessions.detail.questionsPaginationAria")}
            compact
            itemLabel={t("sessions.detail.questionsPaginationItem")}
            onPageChange={setComprehensionPage}
            page={comprehensionPage}
            pageSize={COMPREHENSION_PAGE_SIZE}
            total={detail.comprehension.length}
          />
        </>
      )}
    </section>
  );

  const readingReportsSlot = <SessionReadingReports sessionId={sessionId} />;

  const eventsSlot = (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-extrabold text-ink">
        {t("sessions.detail.eventsTitle")}
      </h2>
      {availability.events === "unsupported" ||
      availability.events === "partial" ? (
        <StatusMessage tone="info">
          {t("sessions.detail.eventsUnsupportedNotice", {
            scope:
              availability.events === "partial"
                ? t("sessions.detail.eventsPartialScope")
                : t("sessions.detail.eventsFormatScope"),
          })}
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
            ariaLabel={t("sessions.detail.eventsPaginationAria")}
            compact
            itemLabel={t("sessions.detail.eventsPaginationItem")}
            onPageChange={setEventsPage}
            page={eventsPage}
            pageSize={EVENTS_PAGE_SIZE}
            total={detail.events.length}
          />
        </>
      ) : null}
    </section>
  );

  return (
    <section
      className={
        isMobile
          ? "flex w-full flex-col gap-4 pb-2"
          : "mx-auto flex w-full max-w-[1120px] flex-col gap-5 pb-4"
      }
    >
      {isMobile ? (
        <MobileSessionDetail
          bookTitle={state.book.title}
          childAlias={state.child.alias}
          endedAtIsNull={detail.ended_at === null}
          endedAtLabel={
            detail.ended_at === null
              ? t("sessions.detail.endedMissing")
              : formatSessionDateTime(detail.ended_at)
          }
          fluencyPartialOrUnsupported={
            availability.fluency === "unsupported" ||
            availability.fluency === "partial"
          }
          pageTitle={pageTitle}
          pagesCompleted={detail.pages_completed}
          rangeIsPartial={rangeIsPartial}
          returnHref={returnHref}
          selectedRangePages={detail.selected_range_pages}
          sessionState={detail.state}
          startedAtLabel={formatSessionDateTime(detail.started_at)}
          stateBadgeClassName={statePresentation.badgeClassName}
          stateLabel={stateLabel}
          summaryItems={summaryItems}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <header className="flex flex-col justify-between gap-4 border-b border-border pb-5 lg:flex-row lg:items-end">
            <div className="min-w-0 max-w-3xl space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-control px-2.5 py-0.5 text-xs font-bold ${statePresentation.badgeClassName}`}
                >
                  {stateLabel}
                </span>
                {rangeIsPartial ? (
                  <span className="inline-flex items-center rounded-control border border-warning/25 bg-warning-surface px-2.5 py-0.5 text-xs font-bold text-warning">
                    {t("sessions.detail.partialCompleteBadge")}
                  </span>
                ) : null}
              </div>
              <h1 className="book-title text-3xl text-ink sm:text-[38px]">
                {pageTitle}
              </h1>
              <p className="text-base font-bold text-ink">
                <span className="viread-learning-content" dir="ltr" lang="vi">
                  {state.book.title}
                </span>
                <span className="font-semibold text-muted">
                  {" "}
                  · {state.child.alias}
                </span>
              </p>
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-semibold text-muted">
                <div className="flex gap-1.5">
                  <dt>{t("sessions.detail.startedLabel")}</dt>
                  <dd className="tabular-nums text-ink">
                    {formatSessionDateTime(detail.started_at)}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>{t("sessions.detail.endedLabel")}</dt>
                  <dd className="tabular-nums text-ink">
                    {detail.ended_at === null
                      ? t("sessions.detail.endedMissing")
                      : formatSessionDateTime(detail.ended_at)}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="flex shrink-0 flex-wrap gap-2">
              <ButtonLink
                className="sm:w-auto"
                href={returnHref}
                variant="secondary"
              >
                <ArrowLeft
                  aria-hidden="true"
                  className="viread-rtl-flip size-4"
                />
                {t("sessions.detail.historyLink")}
              </ButtonLink>
            </div>
          </header>

          {rangeIsPartial ? (
            <StatusMessage
              title={t("sessions.detail.partialRangeTitle")}
              tone="info"
            >
              {t("sessions.detail.partialRangeDesc", {
                total: detail.selected_range_pages ?? 0,
                completed: detail.pages_completed ?? 0,
              })}
            </StatusMessage>
          ) : null}

          {detail.state !== "FINISHED" && detail.state !== "ABORTED" ? (
            <StatusMessage
              title={t("sessions.detail.incompleteDataTitle")}
              tone="warning"
            >
              {t("sessions.detail.inProgressDesc")}
            </StatusMessage>
          ) : null}

          {detail.state === "FINISHED" && detail.ended_at === null ? (
            <StatusMessage tone="info">
              {t("sessions.detail.missingEndTimeDesc")}
            </StatusMessage>
          ) : null}

          <section
            aria-labelledby="session-overview-heading"
            className="rounded-card border border-border bg-white"
          >
            <div className="border-b border-border px-4 py-3.5 sm:px-6">
              <h2
                className="text-lg font-extrabold text-ink"
                id="session-overview-heading"
              >
                {t("sessions.detail.summaryTitle")}
              </h2>
            </div>

            {availability.fluency === "unsupported" ||
            availability.fluency === "partial" ? (
              <div className="px-4 pt-4 sm:px-6">
                <StatusMessage tone="info">
                  {t("sessions.detail.summaryPartialDesc")}
                </StatusMessage>
              </div>
            ) : null}

            <dl className="grid grid-cols-2 sm:grid-cols-3">
              {summaryItems.map(({ label, value, isMissing }, index) => {
                const cellBorders = [
                  "border-border p-3.5 sm:px-6 sm:py-4",
                  index % 2 === 0 ? "border-e sm:border-e-0" : "",
                  index >= 2 ? "border-t" : "",
                  index === 2 ? "sm:border-t-0" : "",
                  index >= 3 ? "sm:border-t" : "",
                  index % 3 !== 2 ? "sm:border-e" : "sm:border-e-0",
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
                          : "mt-1 text-xl font-extrabold leading-snug tabular-nums text-primary"
                      }
                    >
                      {value}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        </div>
      )}

      {readingReportsSlot}

      {showComprehensionSectionDirectly ? comprehensionSection : null}

      <details
        className={
          isMobile
            ? "group rounded-3xl border border-border bg-white p-4 shadow-2xs"
            : "group rounded-card border border-border bg-white p-4 sm:p-6"
        }
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 font-extrabold text-primary">
          <span>{t("sessions.detail.otherInfoTitle")}</span>
          <ChevronDown
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-open:rotate-180"
          />
        </summary>
        <div
          className={
            isMobile
              ? "mt-3.5 flex flex-col gap-4 border-t border-border pt-3.5"
              : "mt-4 flex flex-col gap-5 border-t border-border pt-4"
          }
        >
          {eventsSlot}

          {!showComprehensionSectionDirectly ? comprehensionSection : null}
        </div>
      </details>
    </section>
  );
}
