import { ArrowLeft, CircleHelp, Volume2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import { BookCover } from "@/components/books/book-cover";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import {
  ReadingCompanionBubble,
  type CompanionBubbleState,
} from "@/components/reading/reading-companion-bubble";
import { ReadingControls } from "@/components/reading/reading-controls";
import { ReadingProgress } from "@/components/reading/reading-progress";
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
  page: ReadingPageDTO;
  comparisonResult?: ComparisonResult | null;
  spokenWords?: Set<string>;
  skippedWordIds?: Set<string>;
  repeatedWordIds?: Set<string>;
  hesitationWordIds?: Set<string>;
  assistedWordIds?: ReadonlySet<string>;
  companionBubble?: CompanionBubbleState | null;
  isCompanionSpeaking?: boolean;
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
  page,
  comparisonResult,
  spokenWords,
  skippedWordIds,
  repeatedWordIds,
  hesitationWordIds,
  assistedWordIds,
  companionBubble = null,
  isCompanionSpeaking = false,
  previewSnapshot,
  topBar,
}: ReadingLayoutProps) {
  const hasStatusBanner =
    retryMode ||
    countdown !== null ||
    isPlayingSample ||
    isReadingWord ||
    (isMicRecording &&
      (isCurrentWordMispronounced || Boolean(latestTranscript))) ||
    Boolean(latestTranscript);
  const hasFeedbackPanel =
    hasStatusBanner ||
    Boolean(sentenceReinforcementPanel) ||
    Boolean(phonicsPanel) ||
    Boolean(!retryMode && companionBubble);

  return (
    <section className="relative mx-auto flex min-h-0 w-full max-w-[1200px] flex-1 flex-col gap-2 px-3 pt-2 sm:gap-3 sm:px-6 sm:pt-3">
      <header className="flex shrink-0 flex-nowrap items-center gap-1 sm:gap-3">
        <div className="flex shrink-0 items-center">
          <Link
            aria-label="Thoát khỏi buổi đọc"
            className="inline-flex h-11 shrink-0 items-center gap-1 rounded-control px-1.5 text-xs font-semibold text-ink focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary hover:bg-sky sm:gap-2 sm:px-3 sm:text-label"
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
              className="size-4 shrink-0 sm:size-5"
            />
            <span>Quay lại</span>
          </Link>
        </div>
        <div className="mr-auto min-w-0">
          {child && (
            <p className="truncate text-xs font-bold text-primary sm:text-sm">
              {child.alias} · Lớp {child.grade}
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
            aria-label="Nghe đánh vần"
            onClick={onSpellWord}
            disabled={controlsDisabled}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-control border border-primary/30 bg-sky/60 px-2 text-xs font-semibold text-primary hover:bg-sky disabled:opacity-55 sm:gap-2 sm:px-3 sm:text-sm"
          >
            <Volume2 aria-hidden="true" className="size-4 shrink-0" />
            <span>
              <span className="hidden sm:inline">Nghe </span>đánh vần
            </span>
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Nhờ gia sư giúp đọc"
          onClick={onHelp}
          disabled={controlsDisabled || retryMode}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-control px-2 text-xs font-semibold text-ink hover:bg-sky disabled:opacity-55 sm:gap-2 sm:px-3 sm:text-sm"
        >
          <CircleHelp
            aria-hidden="true"
            className="size-4 shrink-0 sm:size-5"
          />
          <span>Gia sư</span>
        </button>
      </header>

      {topBar ? <div className="shrink-0">{topBar}</div> : null}

      <section
        aria-label="Nội dung trang sách"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <BookPageViewer
          title={bookTitle}
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
        className="reading-dock -mx-3 px-3 pt-2 sm:-mx-6 sm:px-6 sm:pt-2.5"
      >
        {hasFeedbackPanel ? (
          <div
            data-reading-feedback="true"
            className="mx-auto mb-2 max-h-[26dvh] w-full max-w-[1104px] space-y-2 overflow-y-auto overscroll-contain"
          >
            {retryMode ? (
              <div
                className="mx-auto flex w-full max-w-[1008px] flex-wrap items-center gap-3 rounded-card border border-border bg-white px-4 py-2.5"
                aria-live="polite"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-primary">
                    Bé đọc lại từ · {retryWordPosition}/{retryWordCount}
                  </p>

                  <p className="mt-1 break-words text-base font-bold text-ink">
                    {retryFeedback === "preparing-microphone"
                      ? "Đang chuẩn bị microphone..."
                      : retryFeedback === "playing-instruction"
                        ? "ViRead đang hướng dẫn bé..."
                        : retryFeedback === "playing-sample"
                          ? "Nghe mẫu"
                          : retryFeedback === "listening"
                            ? isMicRecording
                              ? "Đang nghe bé"
                              : "Đang bật microphone..."
                            : retryFeedback === "processing"
                              ? "Đang kiểm tra"
                              : retryFeedback === "correct"
                                ? "Bé đã tự sửa đúng"
                                : retryFeedback === "incorrect"
                                  ? "Thử lại · Từ này chưa đúng"
                                  : retryFeedback === "not-recognized"
                                    ? "Thử lại · ViRead chưa nghe rõ"
                                    : retryFeedback === "microphone-unavailable"
                                      ? "Microphone chưa sẵn sàng."
                                      : retryFeedback === "speech-unavailable"
                                        ? "Dịch vụ nhận diện đang tạm dừng."
                                        : retryFeedback === "audio-unavailable"
                                          ? "Chưa phát được lời hướng dẫn."
                                          : retryFeedback === "save-error"
                                            ? "Chưa lưu được kết quả đọc lại."
                                            : "Bé hãy đọc riêng từ bên dưới nhé."}
                  </p>

                  <p className="mt-1.5 w-fit max-w-full break-words rounded-control bg-warning-surface px-3 py-1 text-xl font-extrabold text-ink">
                    <span className="sr-only">Từ cần luyện </span>
                    {currentWordText}
                  </p>

                  {retryContextPhrase ? (
                    <p className="mt-1.5 break-words text-base font-bold text-ink sm:text-lg">
                      {retryContextPhrase}
                    </p>
                  ) : null}
                  {latestTranscript ? (
                    <p className="mt-1 line-clamp-2 text-sm font-medium text-ink">
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
                    Bỏ qua từ này
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
                    Thử bật mic
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
                    Nghe lại và thử
                  </button>
                ) : null}
                {retryFeedback === "save-error" && onRetrySave ? (
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={onRetrySave}
                    className="min-h-11 shrink-0 rounded-control bg-primary px-3.5 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    Thử lưu lại
                  </button>
                ) : null}
                {retryRecording}
              </div>
            ) : countdown !== null ? (
              <div className="mx-auto flex w-full max-w-[1008px] items-center justify-center gap-3 rounded-card border border-border bg-white px-4 py-2.5">
                <span className="text-sm font-semibold text-primary">
                  Chuẩn bị đọc
                </span>
                <span className="flex size-9 items-center justify-center rounded-control bg-sky text-lg font-semibold text-primary">
                  {countdown > 0 ? countdown : "✓"}
                </span>
                <span className="text-base font-medium text-ink">
                  {countdown > 0 ? "Bé sẵn sàng đọc to nhé" : "Bắt đầu đọc"}
                </span>
              </div>
            ) : isPlayingSample ? (
              <div className="mx-auto flex w-full max-w-[1008px] flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-white px-4 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Volume2
                    aria-hidden="true"
                    className="size-4 shrink-0 text-primary"
                  />
                  <span className="shrink-0 text-sm font-semibold text-ink">
                    Đọc mẫu
                  </span>
                  <span className="truncate text-sm text-muted">
                    {isSamplePaused
                      ? "Đã tạm dừng đọc mẫu."
                      : "Đang phát âm toàn bộ trang sách theo giọng mẫu..."}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {onToggleSamplePause ? (
                    <button
                      type="button"
                      onClick={onToggleSamplePause}
                      className="min-h-11 shrink-0 rounded-control border border-border bg-white px-3 py-1 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                      {isSamplePaused ? "Tiếp tục mẫu" : "Tạm dừng mẫu"}
                    </button>
                  ) : null}
                  {onReadSample ? (
                    <button
                      type="button"
                      onClick={onReadSample}
                      className="min-h-11 shrink-0 rounded-control border border-border bg-white px-3 py-1 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                      Dừng mẫu
                    </button>
                  ) : null}
                </div>
              </div>
            ) : isReadingWord ? (
              <div className="mx-auto flex w-full max-w-[1008px] items-center gap-3 rounded-card border border-purple/50 bg-purple px-4 py-2.5">
                <span className="shrink-0 text-sm font-semibold text-purple-ink">
                  Đọc mẫu từ
                </span>
                <p className="min-w-0 flex-1 truncate text-lg font-semibold text-purple-900">
                  &ldquo;{currentWordText || latestTranscript}&rdquo;
                </p>
              </div>
            ) : isMicRecording ? (
              isCurrentWordMispronounced ? (
                <div className="mx-auto flex w-full max-w-[1008px] items-center justify-between gap-3 rounded-card border border-danger/30 bg-danger-surface px-4 py-2.5">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="size-2.5 shrink-0 rounded-full bg-danger" />
                    <span className="shrink-0 text-sm font-semibold text-danger">
                      Chưa chính xác
                    </span>
                    <p className="min-w-0 flex-1 truncate text-base font-semibold text-rose-950">
                      Hãy đọc lại từ &ldquo;
                      <span className="underline decoration-2 underline-offset-2">
                        {currentWordText}
                      </span>
                      &rdquo;
                    </p>
                  </div>
                  {currentWordText && onReadWord ? (
                    <button
                      type="button"
                      onClick={onReadWord}
                      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border border-danger/30 bg-white px-3 py-1.5 text-sm font-semibold text-danger hover:bg-danger-surface"
                      title="Bấm để nghe đọc mẫu từ này"
                    >
                      <>
                        <Volume2 aria-hidden="true" className="size-4" /> Nghe
                        mẫu
                      </>
                    </button>
                  ) : null}
                </div>
              ) : latestTranscript ? (
                <p className="mx-auto line-clamp-2 w-full max-w-[1008px] px-1 text-sm text-muted sm:text-body">
                  Bé vừa đọc: <span>“{latestTranscript}”</span>
                </p>
              ) : null
            ) : latestTranscript ? (
              <div className="mx-auto flex w-full max-w-[1008px] items-center gap-3 rounded-card border border-purple/50 bg-purple/40 px-4 py-2">
                <span className="shrink-0 text-sm font-semibold text-purple-ink">
                  Bản ghi mới nhất
                </span>
                <p className="min-w-0 flex-1 truncate text-sm font-semibold italic text-ink">
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
          onToggleListening={onToggleListening}
          voiceSettings={voiceSettings}
          onChoosePage={onChoosePage}
        />

        <div className="mt-1 [&>div]:flex [&>div]:flex-wrap [&>div]:items-center [&>div]:justify-between [&>div]:gap-x-2 [&>div]:gap-y-0.5 [&>div]:pt-1 [&>div]:text-xs sm:[&>div]:text-sm">
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
