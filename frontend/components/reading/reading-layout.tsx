import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { CameraPreview } from "@/components/reading/camera-preview";
import { ReadingControls } from "@/components/reading/reading-controls";
import { ReadingProgress } from "@/components/reading/reading-progress";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";
import type { ComparisonResult } from "@/lib/api/comparison-service";
import type { RealtimeAlignmentSnapshot } from "@/lib/reading/realtime-alignment";

interface ReadingLayoutProps {
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
  bookTitle,
  children,
  controlsDisabled = false,
  countdown = null,
  correctWordIds,
  currentWordId,
  currentWordText,
  exitHref,
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
    <section className="relative mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-3 p-4">
      <header className="flex min-h-12 items-center gap-3">
        <div className="flex shrink-0 items-center">
          <Link
            aria-label="Thoát khỏi buổi đọc"
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-control px-2 text-label font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary hover:bg-sky sm:px-3"
            href={exitHref}
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
            <span>Thoát</span>
          </Link>
        </div>
        <p className="min-w-0 flex-1 truncate text-center text-label font-bold text-primary sm:text-ink">
          {bookTitle} · Trang {page.page_number}
        </p>
        <p className="hidden w-[180px] text-label font-bold text-muted sm:block">
          04:32
        </p>
      </header>

      <CameraPreview>
        <BookPageViewer
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
      </CameraPreview>
      {retryMode ? (
        <div
          className="mx-auto flex w-full max-w-[1008px] items-center gap-3 rounded-card border-2 border-primary bg-primary/5 px-4 py-3 shadow-sm animate-in fade-in"
          aria-live="polite"
        >
          <div className="min-w-0 flex-1">
            <p className="text-xs font-extrabold uppercase tracking-wider text-primary">
              Bé đọc lại từ · {retryWordPosition}/{retryWordCount}
            </p>

            <p className="truncate text-lg font-black text-ink">
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
                          ? "Chính xác rồi!"
                          : retryFeedback === "incorrect"
                            ? "Từ này chưa đúng. Bé thử lại nhé!"
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

            <p className="mt-1 text-lg font-extrabold text-primary">
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
              className="shrink-0 rounded-full border border-line bg-white px-3.5 py-2 text-xs font-bold text-ink hover:bg-surface disabled:cursor-not-allowed disabled:opacity-55"
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
              className="shrink-0 rounded-full bg-primary px-3.5 py-2 text-xs font-bold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
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
              className="shrink-0 rounded-full bg-primary px-3.5 py-2 text-xs font-bold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
            >
              Nghe lại và thử
            </button>
          ) : null}
          {retryFeedback === "save-error" && onRetrySave ? (
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={onRetrySave}
              className="shrink-0 rounded-full bg-primary px-3.5 py-2 text-xs font-bold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
            >
              Thử lưu lại
            </button>
          ) : null}
        </div>
      ) : countdown !== null ? (
        <div className="mx-auto flex w-full max-w-[1008px] items-center justify-center gap-3 rounded-card border-2 border-primary bg-primary/10 px-4 py-3.5 shadow-sm animate-in fade-in">
          <span className="text-xs font-black uppercase tracking-wider text-primary">
            Chuẩn bị đọc:
          </span>
          <span className="flex size-9 items-center justify-center rounded-full bg-primary text-xl font-black text-white animate-bounce shadow">
            {countdown > 0 ? countdown : "🎉"}
          </span>
          <span className="text-base font-extrabold text-ink">
            {countdown > 0 ? "Bé sẵn sàng đọc to nhé..." : "Bắt đầu đọc nào!"}
          </span>
        </div>
      ) : isPlayingSample ? (
        <div className="mx-auto flex w-full max-w-[1008px] items-center justify-between gap-3 rounded-card border-2 border-blue-500 bg-blue-50/90 px-4 py-3 shadow-sm animate-in fade-in">
          <div className="flex items-center gap-2 truncate">
            <span className="relative flex size-3.5 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-500 opacity-75" />
              <span className="relative inline-flex size-3.5 rounded-full bg-blue-600" />
            </span>
            <span className="text-xs font-extrabold uppercase tracking-wider text-blue-800 shrink-0">
              Đọc mẫu cả đoạn:
            </span>
            <span className="text-sm font-bold text-blue-950 truncate">
              Đang phát âm toàn bộ trang sách theo giọng mẫu...
            </span>
          </div>
          {onReadSample ? (
            <button
              type="button"
              onClick={onReadSample}
              className="rounded-full bg-blue-600 px-3 py-1 text-xs font-bold text-white hover:bg-blue-700 transition-all cursor-pointer shrink-0"
            >
              Dừng mẫu
            </button>
          ) : null}
        </div>
      ) : isReadingWord ? (
        <div className="mx-auto flex w-full max-w-[1008px] items-center gap-3 rounded-card border-2 border-purple-500 bg-purple-50 px-4 py-3 shadow-sm animate-in fade-in">
          <span className="text-xs font-extrabold uppercase tracking-wider text-purple-800 shrink-0">
            Đọc mẫu 1 chữ:
          </span>
          <p className="min-w-0 flex-1 truncate text-lg font-black text-purple-900">
            &ldquo;{currentWordText || latestTranscript}&rdquo;
          </p>
        </div>
      ) : isMicRecording ? (
        isCurrentWordMispronounced ? (
          <div className="mx-auto flex w-full max-w-[1008px] items-center justify-between gap-3 rounded-card border-2 border-rose-500 bg-rose-50 px-4 py-3 shadow-sm transition-all animate-in fade-in">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex size-3 rounded-full bg-rose-600 animate-pulse shrink-0" />
              <span className="text-xs font-black uppercase tracking-wider text-rose-700 shrink-0">
                Chưa chính xác:
              </span>
              <p className="min-w-0 flex-1 truncate text-base font-extrabold text-rose-950">
                Bé hãy nhìn từ màu đỏ &ldquo;
                <span className="underline decoration-2 underline-offset-2">
                  {currentWordText}
                </span>
                &rdquo; và thử đọc lại nhé!
              </p>
            </div>
            {currentWordText && onReadWord ? (
              <button
                type="button"
                onClick={onReadWord}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-rose-600 hover:bg-rose-700 text-white px-3.5 py-1.5 text-xs font-bold transition-all cursor-pointer shadow-sm active:scale-95"
                title="Bấm để nghe đọc mẫu từ này"
              >
                <span>🔊 Nghe mẫu từ này</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[1008px] items-center justify-between gap-3 rounded-card border-2 border-primary bg-primary/5 px-4 py-3 shadow-sm transition-all animate-in fade-in">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex shrink-0 items-center gap-2">
                {isSpeaking ? (
                  <span className="flex items-center gap-1" aria-hidden="true">
                    <span className="h-4 w-1 animate-pulse rounded-full bg-emerald-500" />
                    <span className="h-6 w-1 animate-pulse rounded-full bg-emerald-500 delay-75" />
                    <span className="h-3 w-1 animate-pulse rounded-full bg-emerald-500 delay-150" />
                  </span>
                ) : (
                  <span className="relative flex size-3.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex size-3.5 rounded-full bg-primary" />
                  </span>
                )}
                <span className="text-xs font-extrabold uppercase tracking-wider text-primary">
                  Bé đang đọc:
                </span>
              </div>
              <p className="min-w-0 flex-1 truncate text-lg font-extrabold text-ink">
                {latestTranscript ? (
                  <span className="text-primary underline decoration-2 underline-offset-4 animate-in zoom-in-95">
                    &ldquo;{latestTranscript}&rdquo;
                  </span>
                ) : isSpeaking ? (
                  <span className="font-bold text-emerald-600 animate-pulse">
                    Đang nhận diện giọng bé… (bé đọc tiếp đi nào)
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
                className="shrink-0 hidden sm:inline-flex items-center gap-1.5 rounded-full bg-primary/10 hover:bg-primary/20 text-primary px-3 py-1 text-xs font-bold transition-all cursor-pointer"
                title="Bấm để nghe phát âm từ này"
              >
                <span>🔊 Đọc 1 chữ: &ldquo;{currentWordText}&rdquo;</span>
              </button>
            ) : null}
          </div>
        )
      ) : latestTranscript ? (
        <div className="mx-auto flex w-full max-w-[1008px] items-center gap-3 rounded-card border border-purple-border/50 bg-purple-surface/40 px-4 py-2.5 shadow-sm">
          <span className="text-xs font-bold uppercase tracking-wider text-purple-ink">
            Bé vừa đọc:
          </span>
          <p className="min-w-0 flex-1 truncate text-sm font-bold text-ink italic">
            &ldquo;{latestTranscript}&rdquo;
          </p>
        </div>
      ) : null}

      <ReadingControls
        disabled={controlsDisabled}
        isListening={isMicRecording}
        isPlayingSample={isPlayingSample}
        retryMode={retryMode}
        onFinish={onFinish}
        onHelp={onHelp}
        onPause={onPause}
        onReadSample={onReadSample}
        onToggleListening={onToggleListening}
      />
      <ReadingProgress
        isListening={isListening}
        pageNumber={page.page_number}
      />
      {children}
    </section>
  );
}
