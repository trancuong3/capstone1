"use client";

import { ArrowLeft, CircleHelp, Volume2 } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import type { BookDetailDTO } from "@/types/book";
import type { ReadingDisplayMode } from "@/types/book-assets";
import type { ChildProfileDTO } from "@/types/child";
import { BookCover } from "@/components/books/book-cover";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import {
  ReadingCompanionBubble,
  type CompanionBubbleState,
} from "@/components/reading/reading-companion-bubble";
import { ReadingControls } from "@/components/reading/reading-controls";
import { ReadingProgress } from "@/components/reading/reading-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";
import type { ComparisonResult } from "@/lib/api/comparison-service";
import type { RealtimeAlignmentSnapshot } from "@/lib/reading/realtime-alignment";

interface ReadingLayoutProps {
  selfCorrectedWordIds?: ReadonlySet<string>;
  unresolvedWordIds?: ReadonlySet<string>;
  uncertainWordIds?: ReadonlySet<string>;
  progressLabel?: string;
  audioLevel?: number;
  bookTitle: string;
  book?: BookDetailDTO;
  child?: ChildProfileDTO;
  onChoosePage?: () => void;
  children?: ReactNode;
  previewSnapshot?: RealtimeAlignmentSnapshot | null;
  controlsDisabled?: boolean;
  countdown?: number | null;
  correctWordIds?: Set<string>;
  currentWordId: string | null;
  currentWordText?: string | null;
  exitHref: string;
  onExit?: () => void;
  /** Optional voice settings control shown in the controls bar. */
  voiceSettings?: ReactNode;
  isCurrentWordMispronounced?: boolean;
  isListening: boolean;
  isMicRecording?: boolean;
  isPageTransitioning?: boolean;
  retryMode?: boolean;
  onSkipRetryWord?: () => void;
  retryWordPosition?: number;
  retryWordCount?: number;
  retryFeedback?:
    | "waiting"
    | "preparing-microphone"
    | "playing-instruction"
    | "playing-sample"
    | "listening"
    | "processing"
    | "correct"
    | "incorrect"
    | "not-recognized"
    | "microphone-unavailable"
    | "speech-unavailable"
    | "audio-unavailable"
    | "save-error";
  onRetryRead?: () => void;
  onRetryMicrophonePermission?: () => void;
  onRetrySave?: () => void;
  retryRecording?: ReactNode;
  retryContextPhrase?: string | null;
  isPlayingSample?: boolean;
  isSamplePaused?: boolean;
  onToggleSamplePause?: () => void;
  isReadingWord?: boolean;
  isSpeaking?: boolean;
  latestTranscript?: string | null;
  mispronouncedWordIds?: Set<string>;
  onFinish: () => void;
  onHelp: () => void;
  onPause: () => void;
  onReadSample?: () => void;
  onReadWord?: () => void;
  onSpellWord?: () => void;
  phonicsPanel?: ReactNode;
  sentenceReinforcementPanel?: ReactNode;
  onToggleListening?: () => void;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  onRefreshPageImage?: (pageId: string) => Promise<string | null | undefined>;
  page: ReadingPageDTO;
  comparisonResult?: ComparisonResult | null;
  spokenWords?: Set<string>;
  skippedWordIds?: Set<string>;
  repeatedWordIds?: Set<string>;
  hesitationWordIds?: Set<string>;
  assistedWordIds?: ReadonlySet<string>;
  companionBubble?: CompanionBubbleState | null;
  isCompanionSpeaking?: boolean;
  readingMode?: ReadingDisplayMode | null;
  onReadingModeChange?: (mode: ReadingDisplayMode) => void;
  /** Optional compact page-range / navigation strip rendered inside the top band. */
  topBar?: ReactNode;
}

export function ReadingLayout({
  selfCorrectedWordIds,
  unresolvedWordIds,
  uncertainWordIds,
  progressLabel,
  bookTitle,
  book,
  child,
  onChoosePage,
  children,
  controlsDisabled = false,
  countdown = null,
  correctWordIds,
  currentWordId,
  currentWordText,
  exitHref,
  onExit,
  voiceSettings,
  isCurrentWordMispronounced = false,
  isListening,
  isMicRecording = false,
  isPageTransitioning = false,
  retryMode = false,
  onSkipRetryWord,
  retryWordPosition = 0,
  retryWordCount = 0,
  retryFeedback = "waiting",
  onRetryRead,
  onRetryMicrophonePermission,
  onRetrySave,
  retryRecording,
  retryContextPhrase,
  isPlayingSample = false,
  isSamplePaused = false,
  onToggleSamplePause,
  isReadingWord = false,
  latestTranscript,
  mispronouncedWordIds,
  onFinish,
  onHelp,
  onPause,
  onReadSample,
  onReadWord,
  onSpellWord,
  phonicsPanel,
  sentenceReinforcementPanel,
  onToggleListening,
  onWordClick,
  onRefreshPageImage,
  page,
  comparisonResult,
  spokenWords,
  skippedWordIds,
  repeatedWordIds,
  hesitationWordIds,
  assistedWordIds,
  companionBubble = null,
  isCompanionSpeaking = false,
  readingMode,
  onReadingModeChange,
  previewSnapshot,
  topBar,
}: ReadingLayoutProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reading");
  const tc = useTranslations("child");
  const [internalReadingMode, setInternalReadingMode] =
    useState<ReadingDisplayMode | null>(null);
  const activeReadingMode =
    readingMode !== undefined ? readingMode : internalReadingMode;
  const handleReadingModeChange = onReadingModeChange ?? setInternalReadingMode;
  const pageHasVerifiedIllustration =
    Boolean(page.illustration_url) && page.illustration_text_free === true;
  const resolvedInitialReadingMode: ReadingDisplayMode | undefined =
    activeReadingMode ??
    (pageHasVerifiedIllustration ? "ILLUSTRATED" : undefined);
  const hasStatusBanner =
    retryMode ||
    countdown !== null ||
    isPlayingSample ||
    isReadingWord ||
    (isMicRecording &&
      (isCurrentWordMispronounced || Boolean(latestTranscript))) ||
    Boolean(latestTranscript);
  const hasDockedFeedbackPanel =
    retryMode || Boolean(sentenceReinforcementPanel) || Boolean(phonicsPanel);
  const hasFeedbackPanel =
    hasStatusBanner ||
    Boolean(sentenceReinforcementPanel) ||
    Boolean(phonicsPanel) ||
    Boolean(!retryMode && companionBubble);

  return (
    <section className="relative mx-auto flex min-h-0 w-full max-w-[1200px] flex-1 flex-col gap-1.5 px-3 pt-1.5 sm:gap-3 sm:px-6 sm:pt-3">
      <header className="flex shrink-0 flex-nowrap items-center gap-1.5 sm:gap-3">
        <div className="flex shrink-0 items-center">
          <Link
            aria-label={t("layout.exitAria")}
            className="inline-flex min-h-12 min-w-12 shrink-0 items-center justify-center gap-1 rounded-control px-2 text-xs font-semibold text-ink focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary hover:bg-sky sm:h-11 sm:min-h-11 sm:gap-2 sm:px-3 sm:text-label"
            href={exitHref}
            onClick={
              onExit
                ? (event) => {
                    event.preventDefault();
                    onExit();
                  }
                : undefined
            }
          >
            <ArrowLeft
              aria-hidden="true"
              className="viread-rtl-flip size-5 shrink-0 sm:size-5"
            />
            <span className="hidden sm:inline">{t("layout.back")}</span>
          </Link>
        </div>
        <div className="me-auto min-w-0">
          {child && (
            <p className="truncate text-xs font-bold text-primary sm:text-sm">
              {child.alias} ·{" "}
              {tc("switcher.gradeLabel", { grade: child.grade })}
            </p>
          )}
          {!topBar && progressLabel && (
            <p className="truncate text-xs tabular-nums text-muted sm:text-sm">
              {progressLabel}
            </p>
          )}
        </div>
        {onSpellWord && (currentWordText || page.words.length > 0) ? (
          <button
            type="button"
            aria-label={t("layout.phonicsAria")}
            onClick={onSpellWord}
            disabled={controlsDisabled}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-control border border-primary/30 bg-sky/60 px-2 text-xs font-semibold text-primary hover:bg-sky disabled:opacity-55 sm:gap-2 sm:px-3 sm:text-sm"
          >
            <Volume2 aria-hidden="true" className="size-4 shrink-0" />
            <span>
              <span className="hidden sm:inline">
                {t("layout.phonicsPrefix")}
              </span>
              {t("layout.phonicsLabel")}
            </span>
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t("layout.tutorAria")}
          onClick={onHelp}
          disabled={controlsDisabled || retryMode}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-control px-2 text-xs font-semibold text-ink hover:bg-sky disabled:opacity-55 sm:gap-2 sm:px-3 sm:text-sm"
        >
          <CircleHelp
            aria-hidden="true"
            className="size-5 shrink-0 sm:size-5"
          />
          <span>{t("layout.tutorLabel")}</span>
        </button>
      </header>

      {topBar ? (
        <div data-reading-topbar="true" className="shrink-0">
          {topBar}
        </div>
      ) : null}

      <section
        aria-label={t("layout.bookPageAria")}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <BookPageViewer
          title={bookTitle}
          illustrationUrl={page.illustration_url ?? null}
          illustrationTextFree={pageHasVerifiedIllustration}
          initialReadingMode={resolvedInitialReadingMode}
          readingMode={activeReadingMode}
          onReadingModeChange={handleReadingModeChange}
          illustration={
            book && (
              <BookCover
                book={book}
                hero
                className="reader-cover-art shrink-0"
              />
            )
          }
          selfCorrectedWordIds={selfCorrectedWordIds}
          unresolvedWordIds={unresolvedWordIds}
          uncertainWordIds={uncertainWordIds}
          activeRetryWordId={
            retryMode && retryFeedback !== "correct" ? currentWordId : null
          }
          correctWordIds={correctWordIds}
          currentWordId={currentWordId}
          isTransitioning={isPageTransitioning}
          mispronouncedWordIds={mispronouncedWordIds}
          onRefreshImageUrl={onRefreshPageImage}
          onWordClick={onWordClick}
          page={page}
          previewSnapshot={previewSnapshot}
          spokenWords={spokenWords}
          skippedWordIds={skippedWordIds}
          repeatedWordIds={repeatedWordIds}
          hesitationWordIds={hesitationWordIds}
          assistedWordIds={assistedWordIds}
          comparisonResult={comparisonResult}
        />
      </section>

      <div
        data-reading-dock="true"
        className="reading-dock relative -mx-3 px-3 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 sm:pt-2.5 sm:pb-2"
      >
        {hasFeedbackPanel ? (
          <div
            data-reading-feedback="true"
            data-feedback-overlay={hasDockedFeedbackPanel ? undefined : "true"}
            className={
              hasDockedFeedbackPanel
                ? "mx-auto mb-1.5 max-h-[20dvh] w-full max-w-[1104px] space-y-2 overflow-y-auto overscroll-contain sm:mb-2 sm:max-h-[26dvh]"
                : "pointer-events-none absolute inset-x-0 bottom-full z-20 mx-auto max-h-[20dvh] w-full max-w-[1104px] space-y-1.5 overflow-y-auto overscroll-contain px-3 pb-1.5 sm:max-h-[24dvh] sm:px-6 sm:pb-2 [&>*]:pointer-events-auto [&>*]:shadow-sm"
            }
          >
            {retryMode ? (
              <div
                className="mx-auto flex w-full max-w-[1008px] flex-wrap items-center gap-3 rounded-card border border-border bg-white px-4 py-2.5"
                aria-live="polite"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-primary">
                    {t("layout.retryHeader", {
                      current: formatNumber(retryWordPosition),
                      total: formatNumber(retryWordCount),
                    })}
                  </p>

                  <p className="mt-1 break-words text-base font-bold text-ink">
                    {retryFeedback === "preparing-microphone"
                      ? t("layout.retryStatusPreparingMic")
                      : retryFeedback === "playing-instruction"
                        ? t("layout.retryStatusInstructing")
                        : retryFeedback === "playing-sample"
                          ? t("layout.retryStatusSample")
                          : retryFeedback === "listening"
                            ? isMicRecording
                              ? t("layout.retryStatusListening")
                              : t("layout.retryStatusEnablingMic")
                            : retryFeedback === "processing"
                              ? t("layout.retryStatusChecking")
                              : retryFeedback === "correct"
                                ? t("layout.retryStatusSelfCorrected")
                                : retryFeedback === "incorrect"
                                  ? t("layout.retryStatusIncorrect")
                                  : retryFeedback === "not-recognized"
                                    ? t("layout.retryStatusUnclear")
                                    : retryFeedback === "microphone-unavailable"
                                      ? t("layout.retryStatusMicError")
                                      : retryFeedback === "speech-unavailable"
                                        ? t("layout.retryStatusSttUnavailable")
                                        : retryFeedback === "audio-unavailable"
                                          ? t(
                                              "layout.retryStatusTtsUnavailable",
                                            )
                                          : retryFeedback === "save-error"
                                            ? t("layout.retryStatusSaveError")
                                            : t("layout.retryStatusDefault")}
                  </p>

                  <p
                    className="viread-learning-content mt-1.5 w-fit max-w-full break-words rounded-control bg-warning-surface px-3 py-1 text-xl font-extrabold text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    <span className="sr-only">
                      {t("layout.retryWordSrPrefix")}
                    </span>
                    {currentWordText}
                  </p>

                  {retryContextPhrase ? (
                    <p
                      className="viread-learning-content mt-1.5 break-words text-base font-bold text-ink sm:text-lg"
                      dir="ltr"
                      lang="vi"
                    >
                      {retryContextPhrase}
                    </p>
                  ) : null}
                  {latestTranscript ? (
                    <p
                      className="viread-learning-content mt-1 line-clamp-2 text-sm font-medium text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {latestTranscript}
                    </p>
                  ) : null}
                </div>
                {onSkipRetryWord ? (
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={onSkipRetryWord}
                    className="min-h-11 shrink-0 rounded-control border border-border bg-white px-3.5 py-2 text-xs font-semibold text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {t("layout.skipWord")}
                  </button>
                ) : null}
                {retryFeedback === "microphone-unavailable" &&
                onRetryMicrophonePermission ? (
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={onRetryMicrophonePermission}
                    className="min-h-11 shrink-0 rounded-control bg-primary px-3.5 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {t("layout.retryMic")}
                  </button>
                ) : null}
                {(retryFeedback === "incorrect" ||
                  retryFeedback === "not-recognized" ||
                  retryFeedback === "audio-unavailable" ||
                  retryFeedback === "speech-unavailable") &&
                onRetryRead ? (
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={onRetryRead}
                    className="min-h-11 shrink-0 rounded-control bg-primary px-3.5 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {t("layout.listenAndRetry")}
                  </button>
                ) : null}
                {retryFeedback === "save-error" && onRetrySave ? (
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={onRetrySave}
                    className="min-h-11 shrink-0 rounded-control bg-primary px-3.5 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {t("layout.retrySave")}
                  </button>
                ) : null}
                {retryRecording}
              </div>
            ) : countdown !== null ? (
              <div className="mx-auto flex w-full max-w-[1008px] items-center justify-center gap-3 rounded-card border border-border bg-white px-4 py-2.5">
                <span className="text-sm font-semibold text-primary">
                  {t("layout.preparingRead")}
                </span>
                <span className="flex size-9 items-center justify-center rounded-control bg-sky text-lg font-semibold text-primary">
                  {countdown > 0 ? countdown : "✓"}
                </span>
                <span className="text-base font-medium text-ink">
                  {countdown > 0
                    ? t("layout.countdownReady")
                    : t("layout.countdownStart")}
                </span>
              </div>
            ) : isPlayingSample ? (
              <div className="mx-auto flex w-full max-w-[1008px] flex-wrap items-center justify-between gap-2.5 rounded-card border border-border bg-white px-3 py-2 sm:px-4 sm:py-2.5">
                <div className="flex min-w-0 basis-full items-center gap-2 min-[520px]:basis-auto min-[520px]:flex-1">
                  <Volume2
                    aria-hidden="true"
                    className="size-4 shrink-0 text-primary"
                  />
                  <span className="shrink-0 text-sm font-semibold text-ink">
                    {t("layout.sampleBannerTitle")}
                  </span>
                  <span className="min-w-0 truncate text-sm text-muted">
                    {isSamplePaused
                      ? t("layout.samplePaused")
                      : t("layout.samplePlayingPage")}
                  </span>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {onToggleSamplePause ? (
                    <button
                      type="button"
                      onClick={onToggleSamplePause}
                      className="min-h-11 shrink-0 rounded-control border border-border bg-white px-3 py-1 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                      {isSamplePaused
                        ? t("layout.resumeSample")
                        : t("layout.pauseSample")}
                    </button>
                  ) : null}
                  {onReadSample ? (
                    <button
                      type="button"
                      onClick={onReadSample}
                      className="min-h-11 shrink-0 rounded-control border border-border bg-white px-3 py-1 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                      {t("layout.stopSample")}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : isReadingWord ? (
              <div className="mx-auto flex w-full max-w-[1008px] items-center gap-3 rounded-card border border-purple/50 bg-purple px-4 py-2.5">
                <span className="shrink-0 text-sm font-semibold text-purple-ink">
                  {t("layout.sampleWordButton")}
                </span>
                <p
                  className="viread-learning-content min-w-0 flex-1 truncate text-lg font-semibold text-purple-900"
                  dir="ltr"
                  lang="vi"
                >
                  &ldquo;{currentWordText || latestTranscript}&rdquo;
                </p>
              </div>
            ) : isMicRecording ? (
              isCurrentWordMispronounced ? (
                <div className="mx-auto flex w-full max-w-[1008px] items-center justify-between gap-3 rounded-card border border-danger/30 bg-danger-surface px-4 py-2.5">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="size-2.5 shrink-0 rounded-full bg-danger" />
                    <span className="shrink-0 text-sm font-semibold text-danger">
                      {t("layout.incorrectWordBannerLabel")}
                    </span>
                    <p className="min-w-0 flex-1 truncate text-base font-semibold text-rose-950">
                      {t("layout.retryWordPromptPrefix")}
                      <span
                        className="viread-learning-content underline decoration-2 underline-offset-2"
                        dir="ltr"
                        lang="vi"
                      >
                        {currentWordText}
                      </span>
                      {t("layout.retryWordPromptSuffix")}
                    </p>
                  </div>
                  {currentWordText && onReadWord ? (
                    <button
                      type="button"
                      onClick={onReadWord}
                      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border border-danger/30 bg-white px-3 py-1.5 text-sm font-semibold text-danger hover:bg-danger-surface"
                      title={t("layout.listenTargetWordTitle")}
                    >
                      <>
                        <Volume2 aria-hidden="true" className="size-4" />{" "}
                        {t("controls.samplePage")}
                      </>
                    </button>
                  ) : null}
                </div>
              ) : latestTranscript ? (
                <p className="mx-auto line-clamp-2 w-full max-w-[1008px] rounded-control border border-border/80 bg-white/95 px-3 py-1.5 text-sm text-muted backdrop-blur-xs sm:text-body">
                  {t("layout.childJustReadPrefix")}{" "}
                  <span className="viread-learning-content" dir="ltr" lang="vi">
                    “{latestTranscript}”
                  </span>
                </p>
              ) : null
            ) : latestTranscript ? (
              <div className="mx-auto flex w-full max-w-[1008px] items-center gap-3 rounded-card border border-purple/50 bg-purple/40 px-4 py-2">
                <span className="shrink-0 text-sm font-semibold text-purple-ink">
                  {t("layout.latestRecording")}
                </span>
                <p
                  className="viread-learning-content min-w-0 flex-1 truncate text-sm font-semibold italic text-ink"
                  dir="ltr"
                  lang="vi"
                >
                  &ldquo;{latestTranscript}&rdquo;
                </p>
              </div>
            ) : null}

            {sentenceReinforcementPanel ? (
              <div className="mx-auto w-full max-w-[1008px]">
                {sentenceReinforcementPanel}
              </div>
            ) : null}

            {phonicsPanel ? (
              <div className="mx-auto w-full max-w-[1008px]">
                {phonicsPanel}
              </div>
            ) : null}

            {!retryMode && companionBubble ? (
              <ReadingCompanionBubble
                isSpeaking={isCompanionSpeaking}
                state={companionBubble}
              />
            ) : null}
          </div>
        ) : null}

        <ReadingControls
          pauseDisabled={false}
          disabled={controlsDisabled}
          isListening={isMicRecording}
          isPlayingSample={isPlayingSample}
          retryMode={retryMode}
          onFinish={onFinish}
          onHelp={onHelp}
          onPause={onPause}
          onReadSample={onReadSample}
          onSpellWord={
            onSpellWord && (currentWordText || page.words.length > 0)
              ? onSpellWord
              : undefined
          }
          onToggleListening={onToggleListening}
          voiceSettings={voiceSettings}
          onChoosePage={onChoosePage}
        />

        <div
          data-reading-progress-wrap="true"
          className="mt-0.5 [&>div]:flex [&>div]:flex-wrap [&>div]:items-center [&>div]:justify-between [&>div]:gap-x-2 [&>div]:gap-y-0.5 [&>div]:pt-0.5 [&>div]:text-[11px] sm:mt-1 sm:[&>div]:pt-1 sm:[&>div]:text-sm"
        >
          <ReadingProgress
            isListening={isListening}
            pageNumber={page.page_number}
            wordCount={page.words.length}
            readCount={
              page.words.filter(
                (word) =>
                  correctWordIds?.has(word.word_id) ||
                  mispronouncedWordIds?.has(word.word_id),
              ).length
            }
            currentWord={currentWordText}
          />
        </div>
      </div>

      {children}
    </section>
  );
}
