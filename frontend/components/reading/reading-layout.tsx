import { ArrowLeft, Volume2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookPageViewer } from "@/components/reading/book-page-viewer";
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
  onToggleListening?: () => void;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  page: ReadingPageDTO;
  comparisonResult?: ComparisonResult | null;
  spokenWords?: Set<string>;
  skippedWordIds?: Set<string>;
  repeatedWordIds?: Set<string>;
  hesitationWordIds?: Set<string>;
}

export function ReadingLayout({
  selfCorrectedWordIds,
  unresolvedWordIds,
  uncertainWordIds,
  progressLabel,
  bookTitle,
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
  isPlayingSample = false,
  isSamplePaused = false,
  onToggleSamplePause,
  isReadingWord = false,
  isSpeaking = false,
  latestTranscript,
  mispronouncedWordIds,
  onFinish,
  onHelp,
  onPause,
  onReadSample,
  onReadWord,
  onToggleListening,
  onWordClick,
  page,
  comparisonResult,
  spokenWords,
  skippedWordIds,
  repeatedWordIds,
  hesitationWordIds,
  previewSnapshot,
}: ReadingLayoutProps) {
  return (
    <section className="relative mx-auto flex w-full max-w-[1440px] flex-col gap-3 p-4">
      <header className="flex min-h-12 items-center gap-3">
        <div className="flex shrink-0 items-center">
          <Link
            aria-label="Thoát khỏi buổi đọc"
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-control px-2 text-label font-semibold text-ink focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary hover:bg-sky sm:px-3"
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
            <ArrowLeft aria-hidden="true" className="size-5" />
            <span>Thoát</span>
          </Link>
        </div>
        <h1 className="min-w-0 flex-1 truncate text-center text-label font-semibold text-primary sm:text-ink">
          {bookTitle} · Trang {page.page_number}
        </h1>
        {progressLabel ? (
          <p className="hidden text-sm font-semibold text-muted sm:block">
            {progressLabel}
          </p>
        ) : null}
      </header>

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
      />
      <section
        aria-label="Nội dung trang sách"
        className="min-w-0 rounded-card bg-desk p-2 sm:p-4"
      >
        <BookPageViewer
          selfCorrectedWordIds={selfCorrectedWordIds}
          unresolvedWordIds={unresolvedWordIds}
          uncertainWordIds={uncertainWordIds}
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
          comparisonResult={comparisonResult}
        />
      </section>
      {retryMode ? (
        <div
          className="mx-auto flex w-full max-w-[1008px] flex-wrap items-center gap-3 rounded-card border border-primary/30 bg-white px-4 py-3"
          aria-live="polite"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-primary">
              Bé đọc lại từ · {retryWordPosition}/{retryWordCount}
            </p>

            <p className="truncate text-lg font-semibold text-ink">
              {retryFeedback === "preparing-microphone"
                ? "Đang chuẩn bị microphone..."
                : retryFeedback === "playing-instruction"
                  ? "ViRead đang hướng dẫn bé..."
                  : retryFeedback === "playing-sample"
                    ? "ViRead đang đọc mẫu..."
                    : retryFeedback === "listening"
                      ? isMicRecording
                        ? "Đang nghe bé đọc từ này..."
                        : "Đang bật microphone..."
                      : retryFeedback === "processing"
                        ? "Đang kiểm tra giọng đọc..."
                        : retryFeedback === "correct"
                          ? "Bé đã tự sửa đúng"
                          : retryFeedback === "incorrect"
                            ? "Từ này chưa đúng. Bé thử lại nhé"
                            : retryFeedback === "not-recognized"
                              ? "ViRead chưa nghe rõ từ này."
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

            <p className="mt-1 text-lg font-semibold text-primary">
              Từ cần luyện: “{currentWordText}”
            </p>

            {latestTranscript ? (
              <p className="mt-1 truncate text-sm font-medium text-ink">
                {latestTranscript}
              </p>
            ) : null}
          </div>
          {onSkipRetryWord ? (
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={onSkipRetryWord}
              className="shrink-0 rounded-full border border-line bg-white px-3.5 py-2 text-xs font-semibold text-ink hover:bg-surface disabled:cursor-not-allowed disabled:opacity-55"
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
              className="shrink-0 rounded-full bg-primary px-3.5 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
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
              className="shrink-0 rounded-full bg-primary px-3.5 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
            >
              Nghe lại và thử
            </button>
          ) : null}
          {retryFeedback === "save-error" && onRetrySave ? (
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={onRetrySave}
              className="shrink-0 rounded-full bg-primary px-3.5 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
            >
              Thử lưu lại
            </button>
          ) : null}
        </div>
      ) : countdown !== null ? (
        <div className="mx-auto flex w-full max-w-[1008px] items-center justify-center gap-3 rounded-card border border-border bg-white px-4 py-3">
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
        <div className="mx-auto flex w-full max-w-[1008px] items-center justify-between gap-3 rounded-card border border-border bg-white px-4 py-3">
          <div className="flex items-center gap-2 truncate">
            <Volume2
              aria-hidden="true"
              className="size-4 shrink-0 text-primary"
            />
            <span className="text-sm font-semibold text-ink shrink-0">
              Đọc mẫu
            </span>
            <span className="text-sm text-muted truncate">
              {isSamplePaused
                ? "Đã tạm dừng đọc mẫu."
                : "Đang phát âm toàn bộ trang sách theo giọng mẫu..."}
            </span>
          </div>
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
      ) : isReadingWord ? (
        <div className="mx-auto flex w-full max-w-[1008px] items-center gap-3 rounded-card border border-purple/50 bg-purple px-4 py-3">
          <span className="text-sm font-semibold text-purple-ink shrink-0">
            Đọc mẫu từ
          </span>
          <p className="min-w-0 flex-1 truncate text-lg font-semibold text-purple-900">
            &ldquo;{currentWordText || latestTranscript}&rdquo;
          </p>
        </div>
      ) : isMicRecording ? (
        isCurrentWordMispronounced ? (
          <div className="mx-auto flex w-full max-w-[1008px] items-center justify-between gap-3 rounded-card border border-danger/30 bg-danger-surface px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="size-2.5 shrink-0 rounded-full bg-danger" />
              <span className="text-sm font-semibold text-danger shrink-0">
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
                className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-control border border-danger/30 bg-white px-3 py-1.5 text-sm font-semibold text-danger hover:bg-danger-surface"
                title="Bấm để nghe đọc mẫu từ này"
              >
                <>
                  <Volume2 aria-hidden="true" className="size-4" /> Nghe mẫu
                </>
              </button>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[1008px] items-center justify-between gap-3 rounded-card border border-border bg-white px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex shrink-0 items-center gap-2">
                {isSpeaking ? (
                  <span className="flex items-center gap-1" aria-hidden="true">
                    <span className="h-3 w-1 rounded-full bg-success-ink" />
                    <span className="h-5 w-1 rounded-full bg-success-ink" />
                    <span className="h-2 w-1 rounded-full bg-success-ink" />
                  </span>
                ) : (
                  <span className="size-2.5 rounded-full bg-primary" />
                )}
                <span className="text-sm font-semibold text-primary">
                  Bé đang đọc
                </span>
              </div>
              <p className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">
                {latestTranscript ? (
                  <span className="text-primary underline decoration-2 underline-offset-4">
                    &ldquo;{latestTranscript}&rdquo;
                  </span>
                ) : isSpeaking ? (
                  <span className="font-semibold text-success-ink">
                    Đang nhận diện giọng đọc…
                  </span>
                ) : (
                  <span className="font-medium italic text-muted text-sm">
                    Đang lắng nghe bé đọc… (bé hãy nói vào mic)
                  </span>
                )}
              </p>
            </div>
            {currentWordText && onReadWord ? (
              <button
                type="button"
                onClick={onReadWord}
                className="hidden min-h-10 shrink-0 items-center gap-1.5 rounded-control border border-border bg-white px-3 py-1 text-sm font-semibold text-ink hover:bg-canvas sm:inline-flex"
                title="Bấm để nghe phát âm từ này"
              >
                <>
                  <Volume2 aria-hidden="true" className="size-4" /> Đọc từ:
                  &ldquo;{currentWordText}&rdquo;
                </>
              </button>
            ) : null}
          </div>
        )
      ) : latestTranscript ? (
        <div className="mx-auto flex w-full max-w-[1008px] items-center gap-3 rounded-card border border-purple-border/50 bg-purple-surface/40 px-4 py-2.5">
          <span className="text-sm font-semibold text-purple-ink">
            Bản ghi mới nhất
          </span>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink italic">
            &ldquo;{latestTranscript}&rdquo;
          </p>
        </div>
      ) : null}

      <ReadingProgress
        isListening={isListening}
        pageNumber={page.page_number}
      />
      {children}
    </section>
  );
}
