import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { ViReadLogo } from "@/components/common/viread-logo";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { CameraPreview } from "@/components/reading/camera-preview";
import { ReadingControls } from "@/components/reading/reading-controls";
import { ReadingProgress } from "@/components/reading/reading-progress";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";
import type { ComparisonResult } from "@/lib/api/comparison-service";

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
  isListening: boolean;
  isMicRecording?: boolean;
  isPageTransitioning?: boolean;
  isPlayingSample?: boolean;
  isReadingWord?: boolean;
  isSpeaking?: boolean;
  latestTranscript?: string | null;
  mispronouncedWordIds?: Set<string>;
  uncertainWordIds?: Set<string>;
  onFinish: () => void;
  onHelp: () => void;
  onManualPage: () => void;
  onPause: () => void;
  onReadSample?: () => void;
  onReadWord?: () => void;
  onToggleListening?: () => void;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  page: ReadingPageDTO;
  comparisonResult?: ComparisonResult | null;
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
  isListening,
  isMicRecording = false,
  isPageTransitioning = false,
  isPlayingSample = false,
  isReadingWord = false,
  isSpeaking = false,
  latestTranscript,
  mispronouncedWordIds,
  uncertainWordIds,
  onFinish,
  onHelp,
  onManualPage,
  onPause,
  onReadSample,
  onReadWord,
  onToggleListening,
  onWordClick,
  page,
  comparisonResult,
}: ReadingLayoutProps) {
  return (
    <section className="relative mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-3 p-4">
      <header className="flex min-h-12 items-center gap-3">
        <div className="flex shrink-0 items-center gap-2 sm:w-[180px]">
          <ViReadLogo
            ariaLabel="ViRead - về tổng quan"
            compact
            href="/dashboard"
            size="sm"
          />
          <Link
            aria-label="Thoát khỏi buổi đọc"
            className="inline-flex h-12 shrink-0 items-center gap-2 rounded-control px-1 text-label font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:h-16 sm:bg-white sm:px-4"
            href={exitHref}
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
            <span className="hidden sm:inline">Thoát</span>
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
          uncertainWordIds={uncertainWordIds}
          onWordClick={onWordClick}
          page={page}
          comparisonResult={comparisonResult}
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
        <div className="mx-auto flex w-full max-w-[1008px] items-center justify-between gap-3 rounded-card border-2 border-primary bg-primary/5 px-4 py-3 shadow-sm transition-all animate-in fade-in">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="relative flex size-3.5 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex size-3.5 rounded-full bg-primary" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-extrabold uppercase tracking-wider text-primary">
                Bé đang đọc
              </p>
              <p className="truncate text-sm font-semibold text-ink">
                {latestTranscript
                  ? `Đã nghe: “${latestTranscript}”`
                  : "Mình đang nghe bé đọc. Con cứ đọc tiếp nhé."}
              </p>
              <p className="text-xs text-muted">
                Các từ cần luyện sẽ được xem lại sau khi con đọc xong.
              </p>
            </div>
          </div>
        </div>
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
