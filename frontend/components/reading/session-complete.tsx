"use client";

import { useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  FileText,
  Gamepad2,
  Home,
  Mic,
  Star,
  Users,
  XCircle,
} from "lucide-react";
import Image from "next/image";

import { BookChildHeader } from "@/components/books/book-child-header";
import { Button, ButtonLink } from "@/components/common/button";
import { ReadingPassportPanel } from "@/components/dashboard/reading-passport-panel";
import { SessionReadingReports } from "@/components/reports/session-reading-reports";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type { ReadingCompletionSummaryUI } from "@/types/reading";

interface SessionCompleteProps {
  booksHref: string;
  bookId: string;
  startPageId?: string;
  endPageId?: string;
  child: ChildProfileDTO;
  sessionId: string;
  summary: ReadingCompletionSummaryUI;
  reportError?: string | null;
  onRetryReports?: () => void;
  isRetryingReports?: boolean;
}

export function SessionComplete({
  booksHref,
  bookId,
  startPageId,
  endPageId,
  child,
  sessionId,
  summary,
  reportError = null,
  onRetryReports,
  isRetryingReports = false,
}: SessionCompleteProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reading");
  const tb = useTranslations("books");
  const [showWordList, setShowWordList] = useState(false);
  const rangeWasPartial =
    summary.selected_range_pages !== undefined &&
    summary.selected_range_pages !== null &&
    (summary.pages_explored === null ||
      summary.pages_explored < summary.selected_range_pages);
  const spokenWords = summary.spoken_words ?? [];
  const rereadHref =
    startPageId && endPageId
      ? `/reading-preparation?${new URLSearchParams({ bookId, pageId: startPageId, endPageId })}`
      : `/books/${encodeURIComponent(bookId)}`;
  const transcripts = summary.transcripts ?? [];
  const correctWords = summary.correct_words ?? [];
  const mispronouncedWords = summary.mispronounced_words ?? [];
  const skippedWords = summary.skipped_words ?? [];
  const scoredWordCount =
    correctWords.length + mispronouncedWords.length + skippedWords.length;
  const hasWordAssessment =
    summary.correct_words != null ||
    summary.mispronounced_words != null ||
    summary.skipped_words != null;
  const score =
    hasWordAssessment && scoredWordCount > 0
      ? Math.round((correctWords.length / scoredWordCount) * 100)
      : (summary.score ?? null);
  const gameHref = `/entertainment/sentence-shooter?${new URLSearchParams({
    book_id: bookId,
    source: "reading-completion",
    reading_session_id: sessionId,
  }).toString()}`;

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      <BookChildHeader child={child} mobileLabel={t("session.mobileLabel")} />
      <div className="mx-auto flex w-full max-w-[744px] flex-col gap-4 sm:gap-6">
        <div className="flex flex-col items-start gap-5 rounded-card bg-cream p-6 sm:flex-row">
          <Image
            alt=""
            aria-hidden="true"
            height={96}
            src="/images/figma/owl-mascot.svg"
            width={96}
          />
          <div>
            <h1 className="text-heading font-extrabold text-ink">
              {rangeWasPartial
                ? t("complete.savedTitle")
                : t("complete.completedTitle")}
            </h1>
            <p className="mt-2 text-body text-muted">
              {rangeWasPartial
                ? t("complete.partialSubtitle")
                : t("complete.completedSubtitle")}
            </p>
          </div>
        </div>

        <ReadingAssessmentSummary assessment={summary.assessment} />
        {score !== null && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 rounded-card bg-cream border-2 border-primary/30 p-5 shadow-sm">
            <div className="flex items-center gap-4">
              <div className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary text-2xl font-semibold text-white shadow-md">
                {score}%
              </div>
              <div>
                <p className="text-sm font-semibold text-primary">
                  {t("complete.firstPassAccuracy")}
                </p>
                <h3 className="text-lg font-semibold text-ink">
                  {score >= 90
                    ? t("complete.ratingHigh")
                    : score >= 70
                      ? t("complete.ratingMedium")
                      : t("complete.ratingLow")}
                </h3>
                <p className="text-xs text-muted mt-0.5">
                  {t("complete.accuracyDetail", {
                    correct: formatNumber(correctWords.length),
                    total: formatNumber(scoredWordCount),
                  })}
                  {mispronouncedWords.length > 0
                    ? t("complete.attentionSuffix", {
                        count: formatNumber(mispronouncedWords.length),
                      })
                    : ""}
                  {skippedWords.length > 0
                    ? t("complete.skippedSuffix", {
                        count: formatNumber(skippedWords.length),
                      })
                    : ""}
                  {mispronouncedWords.length === 0 && skippedWords.length === 0
                    ? t("complete.perfectSuffix")
                    : ""}
                </p>
              </div>
            </div>
            <div
              className="flex items-center gap-1.5"
              aria-label={t("complete.starsAria", {
                stars: score >= 90 ? 3 : score >= 70 ? 2 : 1,
              })}
            >
              <Star className="size-7 fill-amber-400 text-amber-500" />
              <Star
                className={cn(
                  "size-7",
                  score >= 70
                    ? "fill-amber-400 text-amber-500"
                    : "text-amber-200 fill-amber-100",
                )}
              />
              <Star
                className={cn(
                  "size-7",
                  score >= 90
                    ? "fill-amber-400 text-amber-500"
                    : "text-amber-200 fill-amber-100",
                )}
              />
            </div>
          </div>
        )}

        {reportError ? (
          <div className="flex flex-col gap-3">
            <StatusMessage
              title={t("complete.reportPendingTitle")}
              tone="warning"
            >
              {t("complete.reportPendingDesc", { error: reportError })}
            </StatusMessage>
            {onRetryReports ? (
              <Button
                className="sm:self-start"
                disabled={isRetryingReports}
                onClick={onRetryReports}
                variant="secondary"
              >
                {isRetryingReports
                  ? t("complete.retryingReports")
                  : t("complete.retryReports")}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div
          className={`grid gap-4 ${summary.selected_range_pages !== undefined && summary.selected_range_pages !== null ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}
        >
          <div className="rounded-card bg-cream p-5 text-center">
            <Clock3
              aria-hidden="true"
              className="mx-auto size-7 text-purple-ink"
            />
            <p className="mt-3 text-[26px] font-semibold">
              {summary.duration_minutes === null
                ? t("complete.notRecorded")
                : t("complete.durationMinutes", {
                    minutes: formatNumber(summary.duration_minutes),
                  })}
            </p>
            <p className="text-label text-muted">
              {t("complete.durationLabel")}
            </p>
          </div>
          {summary.selected_range_pages !== undefined &&
          summary.selected_range_pages !== null ? (
            <div className="rounded-card bg-cream p-5 text-center">
              <BookOpen
                aria-hidden="true"
                className="mx-auto size-7 text-purple-ink"
              />
              <p className="mt-3 text-[26px] font-semibold">
                {tb("catalog.pagesCount", {
                  count: summary.selected_range_pages,
                })}
              </p>
              <p className="text-label text-muted">
                {t("complete.pagesInRangeLabel")}
              </p>
            </div>
          ) : null}
          <div className="rounded-card bg-cream p-5 text-center">
            <CheckCircle2
              aria-hidden="true"
              className="mx-auto size-7 text-purple-ink"
            />
            <p className="mt-3 text-[26px] font-semibold">
              {summary.pages_explored === null
                ? t("complete.notRecorded")
                : tb("catalog.pagesCount", { count: summary.pages_explored })}
            </p>
            <p className="text-label text-muted">
              {t("complete.pagesCompletedLabel")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowWordList((prev) => !prev)}
            aria-expanded={showWordList}
            className="group flex cursor-pointer flex-col items-center justify-between rounded-card border border-border bg-white p-5 text-center hover:bg-canvas focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <div>
              <Star
                aria-hidden="true"
                className="mx-auto size-7 text-purple-ink transition-transform group-hover:scale-110"
              />
              <p className="mt-3 text-[26px] font-semibold text-ink">
                {summary.practiced_words === null
                  ? t("complete.notRecorded")
                  : t("complete.practicedWords", {
                      count: formatNumber(summary.practiced_words),
                    })}
              </p>
              <p className="text-label text-muted">
                {t("complete.practicedWordsLabel")}
              </p>
            </div>
            <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-purple-ink group-hover:underline">
              {showWordList ? (
                <>
                  {t("complete.collapseDetails")}{" "}
                  <ChevronUp aria-hidden="true" className="size-3.5" />
                </>
              ) : (
                <>
                  {t("complete.viewSpokenWords")}{" "}
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                </>
              )}
            </span>
          </button>
        </div>

        <div className="rounded-card border border-border bg-white p-4 shadow-sm sm:p-5">
          <SessionReadingReports
            sessionId={sessionId}
            showAssessment={!summary.assessment}
          />
        </div>

        {showWordList && (
          <div
            className="rounded-card border border-border bg-white p-5 sm:p-6"
            data-testid="spoken-words-container"
          >
            <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Mic aria-hidden="true" className="size-5 text-purple-ink" />
                <h2 className="text-lg font-semibold text-ink">
                  {t("complete.sttResultsTitle")}
                </h2>
              </div>
              <span className="rounded-full border border-purple/50 bg-purple px-3 py-0.5 text-xs font-semibold text-purple-ink">
                {t("complete.recognizedWordsBadge", {
                  count: formatNumber(spokenWords.length),
                })}
              </span>
            </div>

            {spokenWords.length > 0 ||
            correctWords.length > 0 ||
            mispronouncedWords.length > 0 ||
            skippedWords.length > 0 ? (
              <div className="space-y-4">
                {!hasWordAssessment && spokenWords.length > 0 ? (
                  <div>
                    <p className="mb-2 text-sm text-muted">
                      {t("complete.unassessedOnlyLabel")}
                    </p>
                    <div
                      className="viread-learning-content flex flex-wrap gap-2"
                      dir="ltr"
                      lang="vi"
                    >
                      {spokenWords.map((word, index) => (
                        <span
                          key={`${word}-${index}`}
                          className="rounded-full border border-border bg-white px-3 py-1.5 text-sm text-ink"
                        >
                          {word}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {correctWords.length > 0 && (
                  <div>
                    <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted">
                      <CheckCircle2 className="size-4 text-emerald-600" />
                      <span>
                        {t("complete.correctWordsTitle", {
                          count: formatNumber(correctWords.length),
                        })}
                      </span>
                    </p>
                    <div
                      className="viread-learning-content flex max-h-56 flex-wrap gap-2 overflow-y-auto pe-1"
                      dir="ltr"
                      lang="vi"
                    >
                      {correctWords.map((word, idx) => (
                        <span
                          key={`${word}-${idx}`}
                          className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-semibold text-ink shadow-sm border border-emerald-200 hover:bg-emerald-50/50 transition-colors"
                        >
                          <CheckCircle2
                            aria-hidden="true"
                            className="size-4 flex-shrink-0 text-success-ink"
                          />
                          {word}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {mispronouncedWords.length > 0 && (
                  <div className="rounded-card border border-rose-200 bg-rose-50/60 p-4">
                    <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-danger">
                      <AlertCircle className="size-4 text-rose-600" />
                      <span>
                        {t("complete.mispronouncedWordsTitle", {
                          count: formatNumber(mispronouncedWords.length),
                        })}
                      </span>
                    </p>
                    <div
                      className="viread-learning-content flex max-h-48 flex-wrap gap-2 overflow-y-auto pe-1"
                      dir="ltr"
                      lang="vi"
                    >
                      {mispronouncedWords.map((word, idx) => (
                        <span
                          key={`${word}-${idx}`}
                          className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-semibold text-rose-800 shadow-sm border border-rose-200"
                        >
                          <XCircle
                            aria-hidden="true"
                            className="size-4 text-rose-600 flex-shrink-0"
                          />
                          {word}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {skippedWords.length > 0 && (
                  <div className="rounded-card border border-amber-200 bg-amber-50/60 p-4">
                    <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-warning">
                      <AlertCircle className="size-4 text-amber-700" />
                      <span>
                        {t("complete.skippedWordsTitle", {
                          count: formatNumber(skippedWords.length),
                        })}
                      </span>
                    </p>
                    <div
                      className="viread-learning-content flex max-h-48 flex-wrap gap-2 overflow-y-auto pe-1"
                      dir="ltr"
                      lang="vi"
                    >
                      {skippedWords.map((word, idx) => (
                        <span
                          key={`${word}-${idx}`}
                          className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-semibold text-amber-900 shadow-sm border border-amber-200"
                        >
                          <AlertCircle
                            aria-hidden="true"
                            className="size-4 text-amber-700 flex-shrink-0"
                          />
                          {word}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {transcripts.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-sm font-semibold text-muted">
                      {t("complete.micSentencesTitle")}
                    </p>
                    <div className="space-y-1.5 max-h-36 overflow-y-auto pe-1">
                      {transcripts.map((transcriptItem, idx) => (
                        <div
                          key={idx}
                          className="viread-learning-content rounded-lg border border-border bg-white/80 px-3.5 py-2 text-sm text-ink italic"
                          dir="ltr"
                          lang="vi"
                        >
                          &ldquo;{transcriptItem}&rdquo;
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-4 text-center">
                <p className="text-body font-medium text-ink">
                  {t("complete.emptyTitle")}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {t("complete.emptyBody")}
                </p>
              </div>
            )}
          </div>
        )}

        <ReadingPassportPanel
          allowParentRecording={false}
          childAlias={child.alias}
          childId={child.id}
          collapsible
          defaultExpanded={false}
        />

        <ButtonLink className="mx-auto max-w-[360px]" href={rereadHref}>
          <BookOpen aria-hidden="true" className="size-5" />
          {t("complete.rereadAction")}
        </ButtonLink>
        <ButtonLink
          className="mx-auto max-w-[360px]"
          href={booksHref}
          variant="secondary"
        >
          {t("complete.readAnotherAction")}
          <ArrowRight aria-hidden="true" className="viread-rtl-flip size-5" />
        </ButtonLink>
        {!rangeWasPartial ? (
          <ButtonLink
            className="mx-auto max-w-[360px]"
            href={gameHref}
            variant="secondary"
          >
            <Gamepad2 aria-hidden="true" className="size-5" />
            {t("complete.playGameAction")}
          </ButtonLink>
        ) : null}
        <ButtonLink
          className="mx-auto max-w-[360px]"
          href="/dashboard"
          variant="quiet"
        >
          <Home aria-hidden="true" className="size-5" />
          {t("complete.goHomeAction")}
        </ButtonLink>
        <ButtonLink
          className="mx-auto max-w-[360px]"
          href={`/sessions/${sessionId}`}
          variant="secondary"
        >
          <Users aria-hidden="true" className="size-5" />
          {t("complete.viewWithParentAction")}
        </ButtonLink>
        <ButtonLink
          className="mx-auto max-w-[360px]"
          href={`/sessions/${sessionId}/report`}
          variant="secondary"
        >
          <FileText aria-hidden="true" className="size-5" />
          {t("complete.viewReportAction")}
        </ButtonLink>
      </div>
    </section>
  );
}
