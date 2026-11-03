import { Fragment, useEffect, useRef } from "react";
import { WordHighlightOverlay } from "@/components/reading/word-highlight-overlay";
import { cn } from "@/lib/utils/cn";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";
import type { ComparisonResult } from "@/lib/api/comparison-service";
import { BookPageContent } from "@/components/reading/book-page-content";

interface BookPageViewerProps {
  correctWordIds?: Set<string>;
  currentWordId: string | null;
  isTransitioning?: boolean;
  mispronouncedWordIds?: Set<string>;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  page: ReadingPageDTO;
  comparisonResult?: ComparisonResult | null;
  spokenWords?: Set<string>;
}

export function BookPageViewer({
  correctWordIds,
  currentWordId,
  isTransitioning = false,
  mispronouncedWordIds,
  onWordClick,
  page,
  comparisonResult,
  spokenWords,
}: BookPageViewerProps) {
  const hasWords = page.words && page.words.length > 0;
  const currentWordRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (
      currentWordRef.current &&
      typeof currentWordRef.current.scrollIntoView === "function"
    ) {
      currentWordRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [currentWordId]);

  const currentIdx = currentWordId
    ? page.words.findIndex((w) => w.word_id === currentWordId)
    : -1;

  return (
    <article
      aria-busy={isTransitioning || undefined}
      aria-label={`Trang sách ${page.page_number}`}
      className={cn(
        "relative min-h-[552px] w-full overflow-hidden rounded-[8px] bg-cream p-4 shadow-[0_8px_24px_rgba(33,61,66,0.06)] sm:aspect-[3/2] sm:min-h-0 sm:max-w-[1008px] sm:p-8",
        isTransitioning && "opacity-60",
      )}
      data-page-id={page.page_id}
      data-page-revision-id={page.page_revision_id}
    >
      <WordHighlightOverlay currentWordId={currentWordId} page={page} />

      <div className="relative z-10 flex h-full flex-col">
        <header className="mb-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
            <span className="size-2 rounded-full bg-emerald-500" />
            Nội dung OCR đã xác minh
          </span>
          <span className="text-label text-muted">
            Trang {page.page_number}
          </span>
        </header>
        <BookPageContent
          page={page}
          comparisonResult={comparisonResult}
          currentWordId={currentWordId}
          correctWordIds={correctWordIds}
          mispronouncedWordIds={mispronouncedWordIds}
          spokenWords={spokenWords}
          onWordClick={onWordClick}
        />
        <p className="mt-2 text-right text-label text-muted">
          {page.page_number}
        </p>
      </div>

      <span className="sr-only" aria-live="polite">
        Từ hiện tại:{" "}
        {page.words.find((word) => word.word_id === currentWordId)?.text}
      </span>
    </article>
  );
}
