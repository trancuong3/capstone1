"use client";

import { useEffect, useRef, useState } from "react";
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
  Sparkles,
  Star,
  Users,
  XCircle,
} from "lucide-react";
import Image from "next/image";

import { BookChildHeader } from "@/components/books/book-child-header";
import { Button, ButtonLink } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { ReadingPassportPanel } from "@/components/dashboard/reading-passport-panel";
import { SessionReadingReports } from "@/components/reports/session-reading-reports";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { getEffectiveTeacherPersona } from "@/lib/reading/session-voice-lock";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type { ReadingCompletionSummaryUI } from "@/types/reading";

interface SessionCompleteProps {
  booksHref: string;
  bookId: string;
  startPageId?: string;
  endPageId?: string;
  lastPageId?: string;
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
  lastPageId,
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
  const speechPlayer = useSpeechPlayer();
  const offeredVoiceRef = useRef(false);
  const [showWordList, setShowWordList] = useState(false);
  const [unassessedPage, setUnassessedPage] = useState(1);
  const [correctWordsPage, setCorrectWordsPage] = useState(1);
  const [mispronouncedWordsPage, setMispronouncedWordsPage] = useState(1);
  const [skippedWordsPage, setSkippedWordsPage] = useState(1);
  const [transcriptsPage, setTranscriptsPage] = useState(1);
  const WORDS_PAGE_SIZE = 24;
  const ISSUE_WORDS_PAGE_SIZE = 18;
  const TRANSCRIPTS_PAGE_SIZE = 5;
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
  const difficultWordsHref = `/reports/difficult-words?childId=${encodeURIComponent(child.id)}`;
  const hasDifficultWords = summary.assessment
    ? summary.assessment.unresolved_words > 0 ||
      summary.assessment.skipped_after_retry_limit > 0
    : mispronouncedWords.length > 0 || skippedWords.length > 0;

  useEffect(() => {
    if (!hasDifficultWords || offeredVoiceRef.current) return;
    if (typeof window === "undefined") return;
    const hasVoiceApi =
      typeof window.AudioContext === "function" ||
      typeof (window as unknown as { webkitAudioContext?: unknown })
        .webkitAudioContext === "function" ||
      Boolean(window.speechSynthesis?.getVoices?.().length);
    if (!hasVoiceApi) return;
    offeredVoiceRef.current = true;
    const offerText = adaptTextToTeacherPersona(
      "Buổi đọc xong rồi! Con có muốn luyện lại mấy từ khó vừa rồi cùng cô không? Con bấm nút Luyện ngay các từ khó nhé!",
      getEffectiveTeacherPersona().gender,
    );
    void speechPlayer
      .play(offerText, { coaching: true })
      .catch(() => undefined);
    return () => {
      speechPlayer.stop();
    };
  }, [hasDifficultWords, speechPlayer]);
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
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-3.5 px-4 py-3.5 sm:gap-4 sm:px-6 sm:py-4">
      <BookChildHeader child={child} mobileLabel={t("session.mobileLabel")} />
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-3.5">
        <div className="flex flex-col justify-between gap-3.5 rounded-card border border-border bg-cream p-3.5 sm:flex-row sm:items-center sm:p-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <Image
              alt=""
              aria-hidden="true"
              className="size-14 shrink-0 sm:size-16"
              height={64}
              src="/images/figma/owl-mascot.svg"
              width={64}
            />
            <div className="min-w-0">
              <h1 className="text-xl font-extrabold leading-tight text-ink sm:text-2xl">
                {rangeWasPartial
                  ? t("complete.savedTitle")
                  : t("complete.completedTitle")}
              </h1>
              <p className="mt-0.5 text-sm text-muted">
                {rangeWasPartial
                  ? t("complete.partialSubtitle")
                  : t("complete.completedSubtitle")}
              </p>
              {score !== null ? (
                <p className="mt-1 text-xs font-semibold text-ink/80">
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
              ) : null}
            </div>
          </div>

          {score !== null ? (
            <div className="flex shrink-0 items-center gap-3 rounded-control border border-primary/25 bg-white px-3.5 py-2.5 shadow-2xs">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-extrabold tabular-nums text-white shadow-sm">
                {score}%
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-primary">
                  {t("complete.firstPassAccuracy")}
                </p>
                <p className="text-sm font-extrabold text-ink">
                  {score >= 90
                    ? t("complete.ratingHigh")
                    : score >= 70
                      ? t("complete.ratingMedium")
                      : t("complete.ratingLow")}
                </p>
                <div
                  className="mt-0.5 flex items-center gap-1"
                  aria-label={t("complete.starsAria", {
                    stars: score >= 90 ? 3 : score >= 70 ? 2 : 1,
                  })}
                >
                  <Star className="size-3.5 fill-amber-400 text-amber-500" />
                  <Star
                    className={cn(
                      "size-3.5",
                      score >= 70
                        ? "fill-amber-400 text-amber-500"
                        : "fill-amber-100 text-amber-200",
                    )}
                  />
                  <Star
                    className={cn(
                      "size-3.5",
                      score >= 90
                        ? "fill-amber-400 text-amber-500"
                        : "fill-amber-100 text-amber-200",
                    )}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            "grid grid-cols-2 items-stretch gap-2.5",
            summary.selected_range_pages !== undefined &&
              summary.selected_range_pages !== null
              ? "sm:grid-cols-4"
              : "sm:grid-cols-3",
          )}
        >
          <div className="flex flex-col items-center justify-start rounded-card border border-border bg-white px-3 py-2.5 text-center">
            <Clock3 aria-hidden="true" className="size-4.5 text-purple-ink" />
            <p className="mt-1 text-lg font-extrabold tabular-nums text-ink sm:text-xl">
              {summary.duration_minutes === null
                ? t("complete.notRecorded")
                : t("complete.durationMinutes", {
                    minutes: formatNumber(summary.duration_minutes),
                  })}
            </p>
            <p className="mt-0.5 text-xs font-semibold text-muted">
              {t("complete.durationLabel")}
            </p>
          </div>
          {summary.selected_range_pages !== undefined &&
          summary.selected_range_pages !== null ? (
            <div className="flex flex-col items-center justify-start rounded-card border border-border bg-white px-3 py-2.5 text-center">
              <BookOpen
                aria-hidden="true"
                className="size-4.5 text-purple-ink"
              />
              <p className="mt-1 text-lg font-extrabold tabular-nums text-ink sm:text-xl">
                {tb("catalog.pagesCount", {
                  count: summary.selected_range_pages,
                })}
              </p>
              <p className="mt-0.5 text-xs font-semibold text-muted">
                {t("complete.pagesInRangeLabel")}
              </p>
            </div>
          ) : null}
          <div className="flex flex-col items-center justify-start rounded-card border border-border bg-white px-3 py-2.5 text-center">
            <CheckCircle2
              aria-hidden="true"
              className="size-4.5 text-purple-ink"
            />
            <p className="mt-1 text-lg font-extrabold tabular-nums text-ink sm:text-xl">
              {summary.pages_explored === null
                ? t("complete.notRecorded")
                : tb("catalog.pagesCount", { count: summary.pages_explored })}
            </p>
            <p className="mt-0.5 text-xs font-semibold text-muted">
              {t("complete.pagesCompletedLabel")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowWordList((prev) => !prev)}
            aria-expanded={showWordList}
            className="group flex cursor-pointer flex-col items-center justify-start rounded-card border border-primary/30 bg-white px-3 py-2.5 text-center transition-colors hover:bg-sky/30 focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <Star
              aria-hidden="true"
              className="size-4.5 text-purple-ink transition-transform group-hover:scale-110"
            />
            <p className="mt-1 text-lg font-extrabold tabular-nums text-ink sm:text-xl">
              {summary.practiced_words === null
                ? t("complete.notRecorded")
                : t("complete.practicedWords", {
                    count: formatNumber(summary.practiced_words),
                  })}
            </p>
            <p className="mt-0.5 text-xs font-semibold text-muted">
              {t("complete.practicedWordsLabel")}
            </p>
            <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-bold text-purple-ink group-hover:underline">
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

        {hasDifficultWords ? (
          <div
            className="flex flex-col items-center justify-between gap-2.5 rounded-card border border-primary/35 bg-sky/40 px-4 py-2.5 text-center sm:flex-row sm:text-start"
            data-testid="practice-difficult-words-banner"
          >
            <p className="text-sm font-bold text-ink">
              Bé còn từ chưa vững — mình luyện thêm vài giây để nhớ chắc nhé!
            </p>
            <ButtonLink
              className="h-10 min-h-10! shrink-0 py-0! shadow-sm sm:w-auto"
              data-testid="practice-difficult-words-cta"
              href={difficultWordsHref}
              size="admin"
              variant="primary"
            >
              <Sparkles aria-hidden="true" className="size-4 shrink-0" />
              Luyện ngay các từ khó
              <ArrowRight
                aria-hidden="true"
                className="viread-rtl-flip size-4 shrink-0"
              />
            </ButtonLink>
          </div>
        ) : null}

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
                className="sm:w-auto sm:self-start"
                disabled={isRetryingReports}
                onClick={onRetryReports}
                size="compact"
                variant="secondary"
              >
                {isRetryingReports
                  ? t("complete.retryingReports")
                  : t("complete.retryReports")}
              </Button>
            ) : null}
          </div>
        ) : null}

        <ReadingAssessmentSummary assessment={summary.assessment} />

        <SessionReadingReports
          sessionId={sessionId}
          showAssessment={!summary.assessment}
        />

        {showWordList && (
          <div
            className="rounded-card border border-border bg-white p-4 sm:p-5"
            data-testid="spoken-words-container"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
              <div className="flex items-center gap-2">
                <Mic aria-hidden="true" className="size-5 text-purple-ink" />
                <h2 className="text-base font-extrabold text-ink sm:text-lg">
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
              <div className="space-y-3.5">
                {!hasWordAssessment && spokenWords.length > 0
                  ? (() => {
                      const totalUnassessedPages = Math.max(
                        1,
                        Math.ceil(spokenWords.length / WORDS_PAGE_SIZE),
                      );
                      const safeUnassessedPage = Math.min(
                        Math.max(1, unassessedPage),
                        totalUnassessedPages,
                      );
                      const unassessedStart =
                        (safeUnassessedPage - 1) * WORDS_PAGE_SIZE;
                      const visibleSpoken = spokenWords.slice(
                        unassessedStart,
                        unassessedStart + WORDS_PAGE_SIZE,
                      );
                      return (
                        <div>
                          <p className="mb-2 text-sm text-muted">
                            {t("complete.unassessedOnlyLabel")}
                          </p>
                          <div
                            className="viread-learning-content flex flex-wrap gap-2"
                            dir="ltr"
                            lang="vi"
                          >
                            {visibleSpoken.map((word, index) => (
                              <span
                                key={`${word}-${unassessedStart + index}`}
                                className="rounded-full border border-border bg-white px-3 py-1 text-sm text-ink"
                              >
                                {word}
                              </span>
                            ))}
                          </div>
                          <PaginationBar
                            ariaLabel={t("complete.sttResultsTitle")}
                            className="mt-2.5"
                            compact
                            onPageChange={setUnassessedPage}
                            page={safeUnassessedPage}
                            pageSize={WORDS_PAGE_SIZE}
                            total={spokenWords.length}
                          />
                        </div>
                      );
                    })()
                  : null}
                {correctWords.length > 0 &&
                  (() => {
                    const totalCorrectPages = Math.max(
                      1,
                      Math.ceil(correctWords.length / WORDS_PAGE_SIZE),
                    );
                    const safeCorrectPage = Math.min(
                      Math.max(1, correctWordsPage),
                      totalCorrectPages,
                    );
                    const correctStart =
                      (safeCorrectPage - 1) * WORDS_PAGE_SIZE;
                    const visibleCorrect = correctWords.slice(
                      correctStart,
                      correctStart + WORDS_PAGE_SIZE,
                    );
                    return (
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
                          className="viread-learning-content flex flex-wrap gap-1.5"
                          dir="ltr"
                          lang="vi"
                        >
                          {visibleCorrect.map((word, idx) => (
                            <span
                              key={`${word}-${correctStart + idx}`}
                              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-white px-3 py-1 text-sm font-semibold text-ink shadow-2xs transition-colors hover:bg-emerald-50/50"
                            >
                              <CheckCircle2
                                aria-hidden="true"
                                className="size-3.5 shrink-0 text-success-ink"
                              />
                              {word}
                            </span>
                          ))}
                        </div>
                        <PaginationBar
                          ariaLabel={t("complete.correctWordsTitle", {
                            count: formatNumber(correctWords.length),
                          })}
                          className="mt-2.5"
                          compact
                          onPageChange={setCorrectWordsPage}
                          page={safeCorrectPage}
                          pageSize={WORDS_PAGE_SIZE}
                          total={correctWords.length}
                        />
                      </div>
                    );
                  })()}

                {mispronouncedWords.length > 0 &&
                  (() => {
                    const totalMispronouncedPages = Math.max(
                      1,
                      Math.ceil(
                        mispronouncedWords.length / ISSUE_WORDS_PAGE_SIZE,
                      ),
                    );
                    const safeMispronouncedPage = Math.min(
                      Math.max(1, mispronouncedWordsPage),
                      totalMispronouncedPages,
                    );
                    const mispronouncedStart =
                      (safeMispronouncedPage - 1) * ISSUE_WORDS_PAGE_SIZE;
                    const visibleMispronounced = mispronouncedWords.slice(
                      mispronouncedStart,
                      mispronouncedStart + ISSUE_WORDS_PAGE_SIZE,
                    );
                    return (
                      <div className="rounded-control border border-rose-200 bg-rose-50/60 p-3.5">
                        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-danger">
                          <AlertCircle className="size-4 text-rose-600" />
                          <span>
                            {t("complete.mispronouncedWordsTitle", {
                              count: formatNumber(mispronouncedWords.length),
                            })}
                          </span>
                        </p>
                        <div
                          className="viread-learning-content flex flex-wrap gap-1.5"
                          dir="ltr"
                          lang="vi"
                        >
                          {visibleMispronounced.map((word, idx) => (
                            <span
                              key={`${word}-${mispronouncedStart + idx}`}
                              className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-white px-3 py-1 text-sm font-semibold text-rose-800 shadow-2xs"
                            >
                              <XCircle
                                aria-hidden="true"
                                className="size-3.5 shrink-0 text-rose-600"
                              />
                              {word}
                            </span>
                          ))}
                        </div>
                        <PaginationBar
                          ariaLabel={t("complete.mispronouncedWordsTitle", {
                            count: formatNumber(mispronouncedWords.length),
                          })}
                          className="mt-2.5"
                          compact
                          onPageChange={setMispronouncedWordsPage}
                          page={safeMispronouncedPage}
                          pageSize={ISSUE_WORDS_PAGE_SIZE}
                          total={mispronouncedWords.length}
                        />
                      </div>
                    );
                  })()}

                {skippedWords.length > 0 &&
                  (() => {
                    const totalSkippedPages = Math.max(
                      1,
                      Math.ceil(skippedWords.length / ISSUE_WORDS_PAGE_SIZE),
                    );
                    const safeSkippedPage = Math.min(
                      Math.max(1, skippedWordsPage),
                      totalSkippedPages,
                    );
                    const skippedStart =
                      (safeSkippedPage - 1) * ISSUE_WORDS_PAGE_SIZE;
                    const visibleSkipped = skippedWords.slice(
                      skippedStart,
                      skippedStart + ISSUE_WORDS_PAGE_SIZE,
                    );
                    return (
                      <div className="rounded-control border border-amber-200 bg-amber-50/60 p-3.5">
                        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-warning">
                          <AlertCircle className="size-4 text-amber-700" />
                          <span>
                            {t("complete.skippedWordsTitle", {
                              count: formatNumber(skippedWords.length),
                            })}
                          </span>
                        </p>
                        <div
                          className="viread-learning-content flex flex-wrap gap-1.5"
                          dir="ltr"
                          lang="vi"
                        >
                          {visibleSkipped.map((word, idx) => (
                            <span
                              key={`${word}-${skippedStart + idx}`}
                              className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-white px-3 py-1 text-sm font-semibold text-amber-900 shadow-2xs"
                            >
                              <AlertCircle
                                aria-hidden="true"
                                className="size-3.5 shrink-0 text-amber-700"
                              />
                              {word}
                            </span>
                          ))}
                        </div>
                        <PaginationBar
                          ariaLabel={t("complete.skippedWordsTitle", {
                            count: formatNumber(skippedWords.length),
                          })}
                          className="mt-2.5"
                          compact
                          onPageChange={setSkippedWordsPage}
                          page={safeSkippedPage}
                          pageSize={ISSUE_WORDS_PAGE_SIZE}
                          total={skippedWords.length}
                        />
                      </div>
                    );
                  })()}

                {transcripts.length > 0 &&
                  (() => {
                    const totalTranscriptPages = Math.max(
                      1,
                      Math.ceil(transcripts.length / TRANSCRIPTS_PAGE_SIZE),
                    );
                    const safeTranscriptsPage = Math.min(
                      Math.max(1, transcriptsPage),
                      totalTranscriptPages,
                    );
                    const transcriptsStart =
                      (safeTranscriptsPage - 1) * TRANSCRIPTS_PAGE_SIZE;
                    const visibleTranscripts = transcripts.slice(
                      transcriptsStart,
                      transcriptsStart + TRANSCRIPTS_PAGE_SIZE,
                    );
                    return (
                      <div>
                        <p className="mb-1.5 text-sm font-semibold text-muted">
                          {t("complete.micSentencesTitle")}
                        </p>
                        <div className="space-y-1.5">
                          {visibleTranscripts.map((transcriptItem, idx) => (
                            <div
                              key={transcriptsStart + idx}
                              className="viread-learning-content rounded-lg border border-border bg-white/80 px-3 py-1.5 text-sm italic text-ink"
                              dir="ltr"
                              lang="vi"
                            >
                              &ldquo;{transcriptItem}&rdquo;
                            </div>
                          ))}
                        </div>
                        <PaginationBar
                          ariaLabel={t("complete.micSentencesTitle")}
                          className="mt-2.5"
                          compact
                          onPageChange={setTranscriptsPage}
                          page={safeTranscriptsPage}
                          pageSize={TRANSCRIPTS_PAGE_SIZE}
                          total={transcripts.length}
                        />
                      </div>
                    );
                  })()}
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

        {lastPageId || startPageId ? (
          <div
            className="mx-auto w-full max-w-[440px] rounded-card border border-primary/25 bg-sky/40 p-4 text-center"
            data-testid="multimodal-bridge-panel"
          >
            <p className="text-xs font-extrabold uppercase tracking-wide text-primary-hover">
              {t("multimodalBridge.title")}
            </p>
            <p className="mt-1 text-xs text-muted">
              {t("multimodalBridge.subtitle")}
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <ButtonLink
                className="w-auto"
                href={`/entertainment/picture-description?${new URLSearchParams(
                  {
                    childId: child.id,
                    bookId,
                    pageId: (lastPageId ?? startPageId)!,
                  },
                ).toString()}`}
                size="compact"
                variant="secondary"
              >
                {t("multimodalBridge.pictureCta")}
              </ButtonLink>
              <ButtonLink
                className="w-auto"
                href={`/entertainment/sentence-shooter?${new URLSearchParams({
                  childId: child.id,
                  bookId,
                  pageId: (lastPageId ?? startPageId)!,
                }).toString()}`}
                size="compact"
                variant="secondary"
              >
                {t("multimodalBridge.shooterCta")}
              </ButtonLink>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-2 pt-0.5 sm:grid-cols-2 lg:grid-cols-3">
          <ButtonLink
            className="min-h-11! py-2!"
            href={rereadHref}
            size="compact"
            variant={hasDifficultWords ? "secondary" : "primary"}
          >
            <BookOpen aria-hidden="true" className="size-4 shrink-0" />
            {t("complete.rereadAction")}
          </ButtonLink>
          <ButtonLink
            className="min-h-11! py-2!"
            href={booksHref}
            size="compact"
            variant="secondary"
          >
            {t("complete.readAnotherAction")}
            <ArrowRight
              aria-hidden="true"
              className="viread-rtl-flip size-4 shrink-0"
            />
          </ButtonLink>
          {!rangeWasPartial ? (
            <ButtonLink
              className="min-h-11! py-2!"
              href={gameHref}
              size="compact"
              variant="secondary"
            >
              <Gamepad2 aria-hidden="true" className="size-4 shrink-0" />
              {t("complete.playGameAction")}
            </ButtonLink>
          ) : null}
          <ButtonLink
            className="min-h-11! py-2!"
            href={`/sessions/${sessionId}`}
            size="compact"
            variant="outline"
          >
            <Users aria-hidden="true" className="size-4 shrink-0" />
            {t("complete.viewWithParentAction")}
          </ButtonLink>
          <ButtonLink
            className="min-h-11! py-2!"
            href={`/sessions/${sessionId}/report`}
            size="compact"
            variant="outline"
          >
            <FileText aria-hidden="true" className="size-4 shrink-0" />
            {t("complete.viewReportAction")}
          </ButtonLink>
          <ButtonLink
            className="min-h-11! py-2!"
            href="/dashboard"
            size="compact"
            variant="quiet"
          >
            <Home aria-hidden="true" className="size-4 shrink-0" />
            {t("complete.goHomeAction")}
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
