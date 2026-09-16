import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { CameraPreview } from "@/components/reading/camera-preview";
import { ReadingControls } from "@/components/reading/reading-controls";
import { ReadingProgress } from "@/components/reading/reading-progress";
import type { ReadingPageDTO } from "@/types/reading";

interface ReadingLayoutProps {
  bookTitle: string;
  children?: ReactNode;
  controlsDisabled?: boolean;
  currentWordId: string | null;
  exitHref: string;
  isListening: boolean;
  isPageTransitioning?: boolean;
  onFinish: () => void;
  onHelp: () => void;
  onManualPage: () => void;
  onPause: () => void;
  page: ReadingPageDTO;
}

export function ReadingLayout({
  bookTitle,
  children,
  controlsDisabled = false,
  currentWordId,
  exitHref,
  isListening,
  isPageTransitioning = false,
  onFinish,
  onHelp,
  onManualPage,
  onPause,
  page,
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
          currentWordId={currentWordId}
          isTransitioning={isPageTransitioning}
          page={page}
        />
      </CameraPreview>

      <ReadingControls
        disabled={controlsDisabled}
        onFinish={onFinish}
        onHelp={onHelp}
        onManualPage={onManualPage}
        onPause={onPause}
      />
      <ReadingProgress
        isListening={isListening}
        pageNumber={page.page_number}
      />
      {children}
    </section>
  );
}
