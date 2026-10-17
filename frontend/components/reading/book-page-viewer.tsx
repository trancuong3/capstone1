import Image from "next/image";

import { WordHighlightOverlay } from "@/components/reading/word-highlight-overlay";
import { cn } from "@/lib/utils/cn";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";

interface BookPageViewerProps {
  currentWordId: string | null;
  isTransitioning?: boolean;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  page: ReadingPageDTO;
  spokenWords?: Set<string>;
}

export function BookPageViewer({
  currentWordId,
  isTransitioning = false,
  onWordClick,
  page,
  spokenWords,
}: BookPageViewerProps) {
  const hasWords = page.words && page.words.length > 0;

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

        {page.image_url ? (
          <div className="relative mx-auto my-2 h-[200px] w-full max-w-[420px] overflow-hidden rounded-control border border-sand bg-white p-1 shadow-sm sm:h-[42%] sm:max-w-[560px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={`Ảnh gốc trang ${page.page_number}`}
              className="h-full w-full object-contain"
              src={page.image_url}
            />
          </div>
        ) : (
          <div className="relative mx-auto my-2 h-[168px] w-full max-w-[294px] overflow-hidden rounded-control bg-book-orange sm:h-[34%] sm:max-w-[560px]">
            <Image
              alt="Minh họa trang sách"
              className="h-full w-full object-cover"
              fill
              priority
              sizes="(max-width: 767px) 294px, 560px"
              src="/images/figma/book-cat.svg"
            />
          </div>
        )}

        <div className="mt-2 flex-1 overflow-y-auto rounded-card bg-white/70 p-4 shadow-inner">
          {hasWords ? (
            <p className="text-[22px] font-extrabold leading-[1.8] text-ink sm:text-[28px] sm:leading-[1.6]">
              {page.words.map((word) => {
                const isCurrent = word.word_id === currentWordId;
                const isSpoken = Boolean(
                  spokenWords?.has(word.text) ||
                  spokenWords?.has(word.text.toLowerCase()),
                );
                return (
                  <span
                    className={cn(
                      "mr-2 inline-block rounded-[10px] px-2 py-0.5 transition-all duration-150 cursor-pointer select-none active:scale-95",
                      isCurrent &&
                        "bg-highlight scale-105 font-black text-primary shadow-sm ring-2 ring-primary",
                      !isCurrent &&
                        isSpoken &&
                        "bg-emerald-50 text-emerald-800 font-bold border-b-2 border-emerald-400",
                      !isCurrent && !isSpoken && "hover:bg-highlight/40",
                    )}
                    data-bbox={word.bbox.join(",")}
                    data-page-revision-id={page.page_revision_id}
                    data-word-id={word.word_id}
                    key={word.word_id}
                    onClick={() => onWordClick?.(word)}
                    role="button"
                    tabIndex={0}
                    title={`Bấm để nghe đọc mẫu chữ: "${word.text}"`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onWordClick?.(word);
                      }
                    }}
                  >
                    {word.text}
                  </span>
                );
              })}
            </p>
          ) : page.text ? (
            <p className="text-[22px] font-bold leading-[1.8] text-ink sm:text-[26px]">
              {page.text}
            </p>
          ) : (
            <p className="text-body text-muted">
              Đang tải nội dung văn bản của trang…
            </p>
          )}
        </div>

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
