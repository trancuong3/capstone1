import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { CameraPreview } from "@/components/reading/camera-preview";
import { ReadingControls } from "@/components/reading/reading-controls";
import { ReadingProgress } from "@/components/reading/reading-progress";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";

interface ReadingLayoutProps {
  audioLevel?: number;
  bookTitle: string;
  children?: ReactNode;
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
  isPlayingSample?: boolean;
  isReadingWord?: boolean;
  isSpeaking?: boolean;
  latestTranscript?: string | null;
  mispronouncedWordIds?: Set<string>;
  onFinish: () => void;
  onHelp: () => void;
  onManualPage: () => void;
  onPause: () => void;
  onReadSample?: () => void;
  onReadWord?: () => void;
  onToggleListening?: () => void;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  page: ReadingPageDTO;
  spokenWords?: Set<string>;
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
  isPlayingSample = false,
  isReadingWord = false,
  isSpeaking = false,
  latestTranscript,
  mispronouncedWordIds,
  onFinish,
  onHelp,
  onManualPage,
  onPause,
  onReadSample,
  onReadWord,
  onToggleListening,
  onWordClick,
  page,
  spokenWords,
}: ReadingLayoutProps) {
  return (
    <section className="relative mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-3 p-4">
      <header className="flex min-h-12 items-center gap-3">
        <Link
          aria-label="Thoát khỏi buổi đọc"
          className="inline-flex h-12 shrink-0 items-center gap-2 rounded-control px-1 text-label font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:h-16 sm:w-[180px] sm:bg-white sm:px-4"
          href={exitHref}
        >
          <ArrowLeft aria-hidden="true" className="size-5" />
          <span className="hidden sm:inline">Thoát</span>
        </Link>
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
          spokenWords={spokenWords}
        />
      </CameraPreview>

      {countdown !== null ? (
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
        onFinish={onFinish}
        onHelp={onHelp}
        onManualPage={onManualPage}
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
