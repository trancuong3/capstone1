"use client";

import { ArrowLeft, ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { SessionEventList } from "@/components/reports/session-event-list";
import { SessionReadingReports } from "@/components/reports/session-reading-reports";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
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
  const { childService, sessionService } = useReportServices();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [eventsPageState, setEventsPageState] = useState<{
    readonly sessionId: string;
    readonly page: number;
  }>({ sessionId, page: 1 });
  const [comprehensionPageState, setComprehensionPageState] = useState<{
    readonly sessionId: string;
    readonly page: number;
  }>({ sessionId, page: 1 });
  const EVENTS_PAGE_SIZE = 8;
  const COMPREHENSION_PAGE_SIZE = 6;
  const rawEventsPage =
    eventsPageState.sessionId === sessionId ? eventsPageState.page : 1;
  const rawComprehensionPage =
    comprehensionPageState.sessionId === sessionId
      ? comprehensionPageState.page
      : 1;
  const setEventsPage = (page: number) =>
    setEventsPageState({ sessionId, page });
  const setComprehensionPage = (page: number) =>
    setComprehensionPageState({ sessionId, page });

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
        if (active) {
          hydrateTeacherVoiceFromChildProfile(child);
          setState({ status: "ready", detail, child, book });
        }
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
        className="mx-auto flex w-full max-w-[1120px] flex-col gap-3"
      >
        <Skeleton className="h-20 rounded-card" />
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-72 rounded-card" />
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
  const totalEventPages = Math.max(
    1,
    Math.ceil(detail.events.length / EVENTS_PAGE_SIZE),
  );
  const safeEventsPage = Math.min(Math.max(1, rawEventsPage), totalEventPages);
  const totalComprehensionPages = Math.max(
    1,
    Math.ceil(detail.comprehension.length / COMPREHENSION_PAGE_SIZE),
  );
  const safeComprehensionPage = Math.min(
    Math.max(1, rawComprehensionPage),
    totalComprehensionPages,
  );
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

  const renderComprehensionSection = (embedded: boolean) => (
    <section
      aria-labelledby="session-comprehension-heading"
      className={
        embedded
          ? "flex flex-col gap-2.5 border-t border-border/80 pt-3"
          : "overflow-hidden rounded-card border border-border bg-white"
      }
    >
      <div
        className={
          embedded
            ? "flex items-center justify-between gap-2"
            : "border-b border-border/80 bg-canvas/50 px-3.5 py-2"
        }
      >
        <h2
          className="text-sm font-extrabold text-ink sm:text-base"
          id="session-comprehension-heading"
        >
          {t("sessions.detail.comprehensionTitle")}
        </h2>
      </div>
      {availability.comprehension === "unsupported" ||
      availability.comprehension === "partial" ? (
        <div
          className={
            embedded
              ? undefined
              : detail.comprehension.length === 0
                ? "px-3.5 py-2.5"
                : "px-3.5 pt-2.5"
          }
        >
          <StatusMessage tone="info">
            {t("sessions.detail.comprehensionPartial")}{" "}
            {availability.comprehension === "partial"
              ? t("sessions.detail.comprehensionSupportedHint")
              : t("sessions.detail.comprehensionUnsupportedHint")}
          </StatusMessage>
        </div>
      ) : null}
      {detail.comprehension.length === 0 &&
      availability.comprehension === "absent" ? (
        <div className={embedded ? undefined : "p-3.5"}>
          <p className="rounded-control bg-canvas/70 px-3 py-2.5 text-xs font-medium text-muted sm:text-sm">
            {t("sessions.detail.noComprehensionQuestions")}
          </p>
        </div>
      ) : detail.comprehension.length > 0 ? (
        <>
          <ul
            className={
              embedded
                ? "divide-y divide-border/70 border-y border-border/70 bg-white"
                : "divide-y divide-border/70"
            }
          >
            {detail.comprehension
              .slice(
                (safeComprehensionPage - 1) * COMPREHENSION_PAGE_SIZE,
                safeComprehensionPage * COMPREHENSION_PAGE_SIZE,
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
                  <li className="space-y-1 px-3.5 py-2.5" key={question.id}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p
                        className="viread-learning-content break-words text-sm font-bold text-ink"
                        dir="ltr"
                        lang="vi"
                      >
                        {question.prompt}
                      </p>
                      {answerStatusLabel ? (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold leading-tight ${answerBadgeClass}`}
                        >
                          {answerStatusLabel}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                      <p className="break-words text-xs text-ink sm:text-sm">
                        {answer
                          ? t("sessions.detail.answerDisplay", {
                              answer: answer.submitted_answer,
                              status: answerStatusLabel ?? "",
                            })
                          : question.answered
                            ? t("sessions.detail.answerUnsupported")
                            : t("sessions.detail.noAnswer")}
                      </p>
                      <p className="text-xs font-semibold text-muted">
                        {t("sessions.detail.difficultyLabel", {
                          difficulty:
                            question.difficulty ??
                            t("sessions.detail.notRecorded"),
                        })}
                      </p>
                    </div>
                  </li>
                );
              })}
          </ul>
          {detail.comprehension.length > COMPREHENSION_PAGE_SIZE ? (
            <div
              className={
                embedded ? undefined : "border-t border-border/70 px-3.5 py-2"
              }
            >
              <PaginationBar
                ariaLabel={t("sessions.detail.questionsPaginationAria")}
                compact
                itemLabel={t("sessions.detail.questionsPaginationItem")}
                onPageChange={setComprehensionPage}
                page={safeComprehensionPage}
                pageSize={COMPREHENSION_PAGE_SIZE}
                total={detail.comprehension.length}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-3 pb-4">
      <header className="flex flex-wrap items-start justify-between gap-2.5 border-b border-border pb-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="book-title text-xl tracking-[-0.02em] text-ink sm:text-2xl">
              {pageTitle}
            </h1>
            <span
              className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${statePresentation.badgeClassName}`}
            >
              {stateLabel}
            </span>
            {rangeIsPartial ? (
              <span className="inline-flex shrink-0 items-center rounded-full border border-warning/25 bg-warning-surface px-2.5 py-0.5 text-xs font-bold text-warning">
                {t("sessions.detail.partialCompleteBadge")}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted">
            <p className="text-sm font-bold text-ink">
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {state.book.title}
              </span>
              <span className="font-semibold text-muted">
                {" "}
                · {state.child.alias}
              </span>
            </p>
            <dl className="flex flex-wrap items-center gap-x-3.5 gap-y-0.5 font-semibold text-muted">
              <div className="flex items-center gap-1">
                <dt>{t("sessions.detail.startedLabel")}</dt>
                <dd className="tabular-nums text-ink">
                  {formatSessionDateTime(detail.started_at)}
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt>{t("sessions.detail.endedLabel")}</dt>
                <dd className="tabular-nums text-ink">
                  {detail.ended_at === null
                    ? t("sessions.detail.endedMissing")
                    : formatSessionDateTime(detail.ended_at)}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <ButtonLink
          className="h-10 min-h-10! shrink-0 py-0! sm:h-9 sm:min-h-9!"
          fullWidth={false}
          href={returnHref}
          size="admin"
          variant="outline"
        >
          <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
          {t("sessions.detail.historyLink")}
        </ButtonLink>
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
        className="overflow-hidden rounded-card border border-border bg-white"
      >
        <div className="border-b border-border/80 bg-canvas/50 px-3.5 py-2">
          <h2
            className="text-sm font-extrabold text-ink sm:text-base"
            id="session-overview-heading"
          >
            {t("sessions.detail.summaryTitle")}
          </h2>
        </div>

        {availability.fluency === "unsupported" ||
        availability.fluency === "partial" ? (
          <div className="px-3.5 pt-2.5">
            <StatusMessage tone="info">
              {t("sessions.detail.summaryPartialDesc")}
            </StatusMessage>
          </div>
        ) : null}

        <dl
          className={
            summaryItems.length === 4
              ? "grid grid-cols-2 sm:grid-cols-4"
              : "grid grid-cols-2 sm:grid-cols-3"
          }
        >
          {summaryItems.map(({ label, value, isMissing }, index) => {
            const isFourGrid = summaryItems.length === 4;
            const cellBorders = [
              "flex flex-col justify-between border-border/80 px-3 py-2 sm:px-3.5 sm:py-2.5",
              index % 2 === 0 ? "border-e sm:border-e-0" : "",
              index >= 2 ? "border-t" : "",
              isFourGrid
                ? [
                    index >= 2 ? "sm:border-t-0" : "",
                    index < 3 ? "sm:border-e" : "sm:border-e-0",
                  ].join(" ")
                : [
                    index === 2 ? "sm:border-t-0" : "",
                    index >= 3 ? "sm:border-t" : "",
                    index % 3 !== 2 ? "sm:border-e" : "sm:border-e-0",
                  ].join(" "),
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div className={cellBorders} key={label}>
                <dt className="text-[11px] font-bold text-muted">{label}</dt>
                <dd
                  className={
                    isMissing
                      ? "mt-0.5 text-xs font-semibold text-muted sm:text-sm"
                      : "mt-0.5 text-base font-extrabold leading-snug tabular-nums text-primary sm:text-lg"
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

      {showComprehensionSectionDirectly
        ? renderComprehensionSection(false)
        : null}

      <details className="group rounded-card border border-border bg-white px-3.5 py-2.5">
        <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 text-sm font-extrabold text-primary [&::-webkit-details-marker]:hidden">
          <span>{t("sessions.detail.otherInfoTitle")}</span>
          <ChevronDown
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="mt-2.5 flex flex-col gap-3.5 border-t border-border pt-3">
          <section className="flex flex-col gap-2.5">
            <h2 className="text-sm font-extrabold text-ink sm:text-base">
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
                    (safeEventsPage - 1) * EVENTS_PAGE_SIZE,
                    safeEventsPage * EVENTS_PAGE_SIZE,
                  )}
                />
                <PaginationBar
                  ariaLabel={t("sessions.detail.eventsPaginationAria")}
                  compact
                  itemLabel={t("sessions.detail.eventsPaginationItem")}
                  onPageChange={setEventsPage}
                  page={safeEventsPage}
                  pageSize={EVENTS_PAGE_SIZE}
                  total={detail.events.length}
                />
              </>
            ) : null}
          </section>

          {!showComprehensionSectionDirectly
            ? renderComprehensionSection(true)
            : null}
        </div>
      </details>
    </section>
  );
}
