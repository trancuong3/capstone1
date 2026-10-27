import { WordHighlightOverlay } from "@/components/reading/word-highlight-overlay";
import { cn } from "@/lib/utils/cn";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";
import type { ComparisonResult } from "@/lib/api/comparison-service";

interface BookPageViewerProps {
  currentWordId: string | null;
  isTransitioning?: boolean;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  page: ReadingPageDTO;
  comparisonResult?: ComparisonResult | null;
}

export function BookPageViewer({
  currentWordId,
  isTransitioning = false,
  onWordClick,
  page,
  comparisonResult,
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

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-card bg-white/70 p-5 shadow-inner sm:mt-6 sm:p-8">
          {hasWords ? (
            <p className="text-[22px] font-extrabold leading-[1.8] text-ink sm:text-[28px] sm:leading-[1.6]">
              {page.words.map((word, index) => {
                const wordIndex = word.word_index ?? index;

                const alignment = comparisonResult?.alignment.find(
                  (item) => item.book_index === wordIndex,
                );

                const isHesitation = comparisonResult?.summary.hesitations.some(
                  (item) =>
                    typeof item === "object" &&
                      item !== null &&
                        "after_word" in item &&
                          String(item.after_word).toLocaleLowerCase("vi") ===
                            word.text.toLocaleLowerCase("vi"),
                ); 

                const isRepeated =
                  comparisonResult?.summary.repeated_words.some(
                    (item) =>
                      item.toLocaleLowerCase("vi") ===
                      word.text.toLocaleLowerCase("vi"),
                ) ?? false;

                const colorClass =
                  alignment?.status === "DELETE"
                    ? "bg-red-200 text-red-900 ring-1 ring-red-500"
                    : alignment?.status === "SUBSTITUTE"
                      ? "bg-orange-200 text-orange-900 ring-1 ring-orange-500"
                      : isRepeated
                        ? "bg-purple-200 text-purple-900 ring-1 ring-purple-500"
                        : isHesitation
                          ? "bg-blue-200 text-blue-900 ring-1 ring-blue-500"
                          : alignment?.status === "MATCH"
                            ? "bg-green-200 text-green-900 ring-1 ring-green-500"
                            : "";

              return (
                <span
                  className={cn(
                    "mr-2 inline-block rounded-[10px] px-1.5 py-0.5 transition-all duration-150 cursor-pointer select-none hover:bg-highlight/40 active:scale-95",
                    colorClass,
                    word.word_id === currentWordId &&
                      "bg-yellow-300 scale-105 font-black text-primary shadow-sm ring-2 ring-yellow-500",
                  )}
                  data-bbox={word.bbox.join(",")}
                  data-page-revision-id={page.page_revision_id}
                  data-word-id={word.word_id}
                  key={word.word_id}
                  onClick={() => onWordClick?.(word)}
                  role="button"
                  tabIndex={0}
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
